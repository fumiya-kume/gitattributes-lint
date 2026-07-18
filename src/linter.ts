import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  analyzeGitattributes,
  isBuiltinAttribute,
  isReservedBuiltinAttribute,
  type GitattributesAnalysis,
  type GitattributesIssue,
  type GitattributesRule,
} from "./attributes.js";
import {
  findGitRepositoryRoot,
  isGitCaseInsensitive,
  scanGitAttributes,
} from "./git-attributes.js";
import { RESOURCE_LIMITS } from "./limits.js";
import { compileGitattributesPattern } from "./patterns.js";
import { AnalysisBudget } from "./resource-budget.js";

export interface LintRequest {
  readonly allowedAttributes?: readonly string[];
  readonly cwd: string;
  readonly noConfig?: boolean;
  readonly path?: string;
}

export type GitattributesConfigMode = "default" | "disabled";

export interface GitattributesFileAnalysis extends GitattributesAnalysis {
  readonly checkedPathCount: number;
  readonly configMode: GitattributesConfigMode;
  readonly effectiveAttributeCount: number;
  readonly effectiveBuiltinAttributeNames: readonly string[];
  readonly effectiveCustomAttributeNames: readonly string[];
  readonly filePath: string;
  readonly repositoryRoot?: string;
  readonly unusedPatterns: readonly GitattributesRule[];
}

export interface LintOptions {
  readonly strict?: boolean;
}

export class GitattributesNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitattributesNotFoundError";
  }
}

export class GitattributesSymlinkError extends Error {
  public constructor(filePath: string) {
    super(`Git does not follow symlink .gitattributes files: ${filePath}`);
    this.name = "GitattributesSymlinkError";
  }
}

export class GitattributesResourceLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitattributesResourceLimitError";
  }
}

export class GitattributesValidationError extends Error {
  public readonly issues: readonly GitattributesIssue[];

  public constructor(analysis: GitattributesAnalysis) {
    super(
      analysis.issues
        .map(
          ({ column, line, message, rule, severity }) =>
            `${severity} line ${line}:${column} ${rule}: ${message}`
        )
        .join("\n")
    );
    this.name = "GitattributesValidationError";
    this.issues = analysis.issues;
  }
}

export function getLintExitCode(
  analysis: Pick<GitattributesAnalysis, "valid" | "warnings">,
  options: LintOptions = {}
): 0 | 1 {
  if (!analysis.valid || (options.strict === true && analysis.warnings.length > 0)) {
    return 1;
  }

  return 0;
}

async function isFileOrSymlink(path: string): Promise<boolean> {
  try {
    const fileStat = await lstat(path);
    return fileStat.isFile() || fileStat.isSymbolicLink();
  } catch {
    return false;
  }
}

async function readGitattributesFile(
  filePath: string,
  budget: AnalysisBudget
): Promise<string> {
  budget.checkElapsed();
  const fileStat = await lstat(filePath);
  if (fileStat.isSymbolicLink()) {
    throw new GitattributesSymlinkError(filePath);
  }

  if (fileStat.size > RESOURCE_LIMITS.maxGitattributesBytes) {
    throw new GitattributesResourceLimitError(
      `.gitattributes exceeds the ${String(RESOURCE_LIMITS.maxGitattributesBytes)}-byte input limit: ${filePath}`
    );
  }

  const stream = createReadStream(filePath, {
    encoding: "utf8",
    highWaterMark: 64 * 1024,
  });
  const chunks: string[] = [];
  let byteLength = 0;

  try {
    for await (const chunk of stream) {
      budget.checkElapsed();
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      byteLength += Buffer.byteLength(text, "utf8");
      if (byteLength > RESOURCE_LIMITS.maxGitattributesBytes) {
        throw new GitattributesResourceLimitError(
          `.gitattributes exceeds the ${String(RESOURCE_LIMITS.maxGitattributesBytes)}-byte input limit: ${filePath}`
        );
      }
      chunks.push(text);
    }
  } finally {
    stream.destroy();
  }

  return chunks.join("");
}

export async function resolveGitattributesFile(
  request: LintRequest,
  budget: AnalysisBudget = new AnalysisBudget()
): Promise<string> {
  const resolvedCwd = resolve(request.cwd);
  budget.checkElapsed();
  const cwd = await realpath(resolvedCwd).catch(() => resolvedCwd);
  budget.checkElapsed();

  if (request.path !== undefined) {
    const requestedPath = isAbsolute(request.path)
      ? resolve(request.path)
      : resolve(cwd, request.path);
    const requestedDirectory = dirname(requestedPath);
    const canonicalDirectory = await realpath(requestedDirectory).catch(
      () => requestedDirectory
    );
    return join(canonicalDirectory, basename(requestedPath));
  }

  const currentDirectoryFile = join(cwd, ".gitattributes");
  if (await isFileOrSymlink(currentDirectoryFile)) {
    return currentDirectoryFile;
  }

  const repositoryRoot = await findGitRepositoryRoot(cwd, budget);
  if (repositoryRoot !== undefined) {
    const repositoryFile = join(repositoryRoot, ".gitattributes");
    if (await isFileOrSymlink(repositoryFile)) {
      return repositoryFile;
    }
  }

  throw new GitattributesNotFoundError(
    `Could not find .gitattributes from ${cwd} or its repository root.`
  );
}

export async function lint(request: LintRequest, options: LintOptions = {}): Promise<true> {
  const analysis = await analyzeGitattributesFile(request);

  if (getLintExitCode(analysis, options) !== 0) {
    throw new GitattributesValidationError(analysis);
  }

  return true;
}

export async function analyzeGitattributesFile(
  request: LintRequest
): Promise<GitattributesFileAnalysis> {
  const budget = new AnalysisBudget();
  const filePath = await resolveGitattributesFile(request, budget);
  const source = await readGitattributesFile(filePath, budget);
  const analysis = analyzeGitattributes(source, {
    allowedAttributes: request.allowedAttributes,
    budget,
  });
  if (analysis.issues.some(({ code }) => code === "resource-limit")) {
    return {
      ...analysis,
      checkedPathCount: 0,
      configMode: request.noConfig === true ? "disabled" : "default",
      effectiveAttributeCount: 0,
      effectiveBuiltinAttributeNames: [],
      effectiveCustomAttributeNames: [],
      filePath,
      unusedPatterns: [],
      valid: false,
    };
  }

  budget.checkElapsed();
  const repositoryRoot = await findGitRepositoryRoot(dirname(filePath), budget);
  const attributeDirectory =
    repositoryRoot === undefined
      ? ""
      : relative(repositoryRoot, dirname(filePath)).split(sep).join("/");
  const matchedPatterns = new Set<GitattributesRule>();
  const effectiveBuiltinAttributeNames = new Set<string>();
  const effectiveCustomAttributeNames = new Set<string>();
  let checkedPathCount = 0;
  let effectiveAttributeCount = 0;
  const matchingRules = analysis.rules.filter(
    (rule) => !rule.isMacroDefinition && !rule.pattern.startsWith("!")
  );
  const matchingRuleSet = new Set(matchingRules);

  if (repositoryRoot !== undefined) {
    const caseInsensitive = await isGitCaseInsensitive(repositoryRoot, budget);
    const unmatchedPatternMatchers = new Set(
      matchingRules.map((rule) => ({
        matcher: compileGitattributesPattern(rule.pattern, { budget, caseInsensitive }),
        rule,
      }))
    );
    let patternMatchChecks = 0;

    const scan = await scanGitAttributes(repositoryRoot, [filePath], {
      onAttribute: ({ name }) => {
        budget.checkElapsed();
        effectiveAttributeCount += 1;
        if (isBuiltinAttribute(name)) {
          addBoundedName(effectiveBuiltinAttributeNames, name, "built-in");
        } else if (!isReservedBuiltinAttribute(name)) {
          addBoundedName(effectiveCustomAttributeNames, name, "custom");
        }
      },
      onPath: (path) => {
        budget.checkElapsed();
        checkedPathCount += 1;
        const pathFromAttributeDirectory = pathFromDirectory(path, attributeDirectory);
        if (pathFromAttributeDirectory === undefined) {
          return;
        }

        for (const patternMatcher of unmatchedPatternMatchers) {
          patternMatchChecks += 1;
          if (patternMatchChecks > RESOURCE_LIMITS.maxPatternMatchChecks) {
            throw new GitattributesResourceLimitError(
              `Pattern matching exceeded the ${String(RESOURCE_LIMITS.maxPatternMatchChecks)}-check limit.`
            );
          }

          if (patternMatcher.matcher(pathFromAttributeDirectory)) {
            matchedPatterns.add(patternMatcher.rule);
            unmatchedPatternMatchers.delete(patternMatcher);
          }
        }
      },
    });
    checkedPathCount = scan.checkedPathCount;
    effectiveAttributeCount = scan.effectiveAttributeCount;
  }

  const allUnusedPatterns =
    repositoryRoot === undefined
      ? []
      : analysis.rules.filter(
          (rule) => matchingRuleSet.has(rule) && !matchedPatterns.has(rule)
        );
  const unusedPatternIssuesByRule = new Map(
    allUnusedPatterns.map(
      (rule) =>
        [
          rule,
          {
            code: "unused-pattern" as const,
            column: rule.column,
            line: rule.line,
            message: `Pattern ${JSON.stringify(rule.pattern)} does not match any checked repository path.`,
            rule: "gitattributes/unused-pattern",
            severity: "warning" as const,
          },
        ] as const
    )
  );
  const issues = capDiagnostics([...analysis.issues, ...unusedPatternIssuesByRule.values()]);
  const retainedIssues = new Set(issues);
  const unusedPatterns = allUnusedPatterns.filter((rule) => {
    const issue = unusedPatternIssuesByRule.get(rule);
    return issue !== undefined && retainedIssues.has(issue);
  });
  const errors = issues.filter(({ severity }) => severity === "error");
  const warnings = issues.filter(({ severity }) => severity === "warning");

  return {
    ...analysis,
    checkedPathCount,
    configMode: request.noConfig === true ? "disabled" : "default",
    effectiveAttributeCount,
    effectiveBuiltinAttributeNames: Array.from(effectiveBuiltinAttributeNames),
    effectiveCustomAttributeNames: Array.from(effectiveCustomAttributeNames),
    errors,
    filePath,
    issues,
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    unusedPatterns,
    valid: errors.length === 0,
    warnings,
  };
}

function addBoundedName(set: Set<string>, name: string, kind: string): void {
  if (set.has(name)) {
    return;
  }

  if (set.size >= RESOURCE_LIMITS.maxUniqueEffectiveAttributeNames) {
    throw new GitattributesResourceLimitError(
      `The number of unique effective ${kind} attribute names exceeded the ${String(RESOURCE_LIMITS.maxUniqueEffectiveAttributeNames)}-name limit.`
    );
  }

  set.add(name);
}

function capDiagnostics(
  issues: readonly GitattributesIssue[]
): readonly GitattributesIssue[] {
  if (issues.length < RESOURCE_LIMITS.maxDiagnostics) {
    return issues;
  }

  const retainedLimit = Math.max(0, RESOURCE_LIMITS.maxDiagnostics - 1);
  const retained = issues.slice(0, retainedLimit);
  const triggeringIssue = issues[retainedLimit];
  const marker: GitattributesIssue = {
    code: "resource-limit",
    column: triggeringIssue?.column ?? 1,
    line: triggeringIssue?.line ?? 1,
    message: `The diagnostic limit of ${String(RESOURCE_LIMITS.maxDiagnostics)} was reached; further diagnostics were omitted.`,
    rule: "gitattributes/resource-limit",
    severity: "error",
  };
  return [...retained, marker];
}

function pathFromDirectory(path: string, directory: string): string | undefined {
  if (directory.length === 0) {
    return path;
  }

  if (path === directory) {
    return "";
  }

  const prefix = `${directory}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : undefined;
}
