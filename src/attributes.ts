import { RESOURCE_LIMITS } from "./limits.js";
import {
  AnalysisBudget,
  ResourceBudgetExceededError,
} from "./resource-budget.js";

export const BUILTIN_ATTRIBUTE_NAMES = [
  "text",
  "eol",
  "crlf",
  "working-tree-encoding",
  "ident",
  "filter",
  "diff",
  "merge",
  "conflict-marker-size",
  "whitespace",
  "export-ignore",
  "export-subst",
  "delta",
  "encoding",
  "binary",
  "builtin_objectmode",
] as const;

const builtinAttributeNames = new Set<string>(BUILTIN_ATTRIBUTE_NAMES);

export type GitattributesAttributeKind = "builtin" | "custom" | "reserved";

export type GitattributesAttributeState =
  | "set"
  | "unset"
  | "value"
  | "unspecified";

export type GitattributesIssueSeverity = "error" | "warning";

export type GitattributesIssueCode =
  | "attribute-without-value"
  | "conflicting-attributes"
  | "invalid-attribute"
  | "invalid-conflict-marker-size"
  | "invalid-eol-value"
  | "invalid-quoted-token"
  | "invalid-text-value"
  | "invalid-working-tree-encoding"
  | "missing-attribute"
  | "negative-pattern"
  | "possible-attribute-typo"
  | "reserved-builtin-attribute"
  | "resource-limit"
  | "unused-pattern";

export interface GitattributesAttributeUsage {
  readonly column: number;
  readonly kind: GitattributesAttributeKind;
  readonly line: number;
  readonly name: string;
  readonly pattern: string;
  readonly state: GitattributesAttributeState;
  readonly value?: string;
}

export interface GitattributesRule {
  readonly attributes: readonly GitattributesAttributeUsage[];
  readonly column: number;
  readonly isMacroDefinition: boolean;
  readonly line: number;
  readonly pattern: string;
}

export interface GitattributesIssue {
  readonly code: GitattributesIssueCode;
  readonly column: number;
  readonly line: number;
  readonly message: string;
  readonly rule: string;
  readonly severity: GitattributesIssueSeverity;
}

export interface GitattributesAnalysis {
  readonly attributes: readonly GitattributesAttributeUsage[];
  readonly builtinAttributes: readonly GitattributesAttributeUsage[];
  readonly customAttributes: readonly GitattributesAttributeUsage[];
  readonly errors: readonly GitattributesIssue[];
  readonly hasBuiltinAttributes: boolean;
  readonly issues: readonly GitattributesIssue[];
  readonly reservedAttributes: readonly GitattributesAttributeUsage[];
  readonly rules: readonly GitattributesRule[];
  readonly valid: boolean;
  readonly warnings: readonly GitattributesIssue[];
}

export interface GitattributesAnalysisOptions {
  readonly allowedAttributes?: readonly string[];
  readonly budget?: AnalysisBudget;
}

interface Token {
  readonly column: number;
  readonly value: string;
}

interface TokenizationResult {
  readonly issue?: GitattributesIssue;
  readonly tokens: readonly Token[];
}

class DiagnosticCollector {
  private readonly budget: AnalysisBudget;
  private readonly collected: GitattributesIssue[] = [];
  private resourceLimitReached = false;
  private truncated = false;

  public constructor(budget: AnalysisBudget) {
    this.budget = budget;
  }

  public add(issue: GitattributesIssue): void {
    if (this.resourceLimitReached) {
      return;
    }

    const retainedLimit = Math.max(0, RESOURCE_LIMITS.maxDiagnostics - 1);
    if (this.collected.length < retainedLimit) {
      try {
        this.reserveDiagnostic(issue);
      } catch (error: unknown) {
        if (!(error instanceof ResourceBudgetExceededError)) {
          throw error;
        }
        this.recordResourceLimit(issue.line, issue.column, error.message);
        return;
      }
      this.collected.push(issue);
      return;
    }

    if (!this.truncated) {
      const marker = createIssue(
        "resource-limit",
        issue.line,
        issue.column,
        `The diagnostic limit of ${String(RESOURCE_LIMITS.maxDiagnostics)} was reached; further diagnostics were omitted.`
      );
      try {
        this.reserveDiagnostic(marker);
      } catch (error: unknown) {
        if (!(error instanceof ResourceBudgetExceededError)) {
          throw error;
        }
        this.recordResourceLimit(issue.line, issue.column, error.message);
        return;
      }
      this.collected.push(marker);
      this.truncated = true;
    }
  }

  public addMany(issues: readonly GitattributesIssue[]): void {
    for (const issue of issues) {
      this.add(issue);
    }
  }

  public get issues(): readonly GitattributesIssue[] {
    return this.collected;
  }

  public get isTruncated(): boolean {
    return this.truncated;
  }

  public get isResourceLimited(): boolean {
    return this.resourceLimitReached;
  }

  private reserveDiagnostic(issue: GitattributesIssue): void {
    this.budget.reserveParserBytes(
      RESOURCE_LIMITS.gitattributesDiagnosticRetainedBytes +
        Buffer.byteLength(issue.message, "utf8") +
        Buffer.byteLength(issue.rule, "utf8")
    );
  }

  private recordResourceLimit(line: number, column: number, message: string): void {
    this.resourceLimitReached = true;
    if (this.collected.length >= RESOURCE_LIMITS.maxDiagnostics) {
      return;
    }

    this.collected.push(createIssue("resource-limit", line, column, message));
  }
}

function isWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\r";
}

function decodeEscape(character: string): string | undefined {
  switch (character) {
    case "a":
      return "\u0007";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "v":
      return "\v";
    case '"':
    case "\\":
      return character;
    default:
      return undefined;
  }
}

function isValidAttributeName(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(name) && !name.startsWith("-");
}

function createIssue(
  code: GitattributesIssueCode,
  line: number,
  column: number,
  message: string,
  severity: GitattributesIssueSeverity = "error"
): GitattributesIssue {
  return {
    code,
    column,
    line,
    message,
    rule: `gitattributes/${code}`,
    severity,
  };
}

function tokenizeLine(line: string, lineNumber: number): TokenizationResult {
  const tokens: Token[] = [];
  let index = 0;

  while (index < line.length) {
    while (index < line.length && isWhitespace(line[index] ?? "")) {
      index += 1;
    }

    if (index >= line.length) {
      break;
    }

    if (tokens.length >= RESOURCE_LIMITS.maxTokensPerLine) {
      return {
        issue: createIssue(
          "resource-limit",
          lineNumber,
          index + 1,
          `A rule may contain at most ${String(RESOURCE_LIMITS.maxTokensPerLine)} tokens.`
        ),
        tokens,
      };
    }

    if (tokens.length === 0 && line[index] === "#") {
      return { tokens };
    }

    const column = index + 1;
    let value = "";
    const octalBytes: number[] = [];
    const flushOctalBytes = (): void => {
      if (octalBytes.length === 0) {
        return;
      }

      value += Buffer.from(octalBytes).toString("utf8");
      octalBytes.length = 0;
    };

    if (line[index] === '"') {
      index += 1;
      let closed = false;

      while (index < line.length) {
        const character = line[index];

        if (character === '"') {
          index += 1;
          closed = true;
          break;
        }

        if (character === "\\") {
          index += 1;
          if (index >= line.length) {
            return {
              issue: createIssue(
                "invalid-quoted-token",
                lineNumber,
                column,
                "A quoted token cannot end with an escape character."
              ),
              tokens,
            };
          }

          const escapedCharacter = line[index] ?? "";
          const decoded = decodeEscape(escapedCharacter);
          if (decoded !== undefined) {
            flushOctalBytes();
            value += decoded;
            index += 1;
            continue;
          }

          if (/[0-3]/u.test(escapedCharacter)) {
            const octal = line.slice(index, index + 3);
            if (!/^[0-7]{3}$/u.test(octal)) {
              return {
                issue: createIssue(
                  "invalid-quoted-token",
                  lineNumber,
                  column,
                  "C-style octal escapes must contain three octal digits."
                ),
                tokens,
              };
            }
            octalBytes.push(Number.parseInt(octal, 8));
            index += 3;
            continue;
          }

          return {
            issue: createIssue(
              "invalid-quoted-token",
              lineNumber,
              column,
              `Invalid C-style escape sequence \\${escapedCharacter}.`
            ),
            tokens,
          };
        }

        flushOctalBytes();
        value += character;
        index += 1;
      }

      flushOctalBytes();

      if (!closed) {
        return {
          issue: createIssue(
            "invalid-quoted-token",
            lineNumber,
            column,
            "Unterminated quoted token."
          ),
          tokens,
        };
      }

      if (index < line.length && !isWhitespace(line[index] ?? "")) {
        return {
          issue: createIssue(
            "invalid-quoted-token",
            lineNumber,
            column,
            "A quoted token must be followed by whitespace."
          ),
          tokens,
        };
      }
    } else {
      while (index < line.length && !isWhitespace(line[index] ?? "")) {
        value += line[index] ?? "";
        index += 1;
      }
    }

    tokens.push({ column, value });
  }

  return { tokens };
}

function classifyAttribute(name: string): GitattributesAttributeKind {
  if (isReservedBuiltinAttribute(name)) {
    return "reserved";
  }

  return builtinAttributeNames.has(name) ? "builtin" : "custom";
}

function parseAttribute(
  token: Token,
  pattern: string,
  line: number,
  allowedAttributes: ReadonlySet<string>,
  budget: AnalysisBudget
): { attribute?: GitattributesAttributeUsage; issue?: GitattributesIssue } {
  const prefix = token.value[0];
  const hasModifier = prefix === "-" || prefix === "!";
  const expression = hasModifier ? token.value.slice(1) : token.value;
  const equalsIndex = expression.indexOf("=");
  const name = equalsIndex === -1 ? expression : expression.slice(0, equalsIndex);

  if (!isValidAttributeName(name)) {
    return {
      issue: createIssue(
        "invalid-attribute",
        line,
        token.column,
        `Invalid attribute name ${JSON.stringify(name)}.`
      ),
    };
  }

  const kind = classifyAttribute(name);
  const state: GitattributesAttributeState =
    prefix === "-"
      ? "unset"
      : prefix === "!"
        ? "unspecified"
        : equalsIndex === -1
          ? "set"
          : "value";
  const value = equalsIndex === -1 ? undefined : expression.slice(equalsIndex + 1);

  if (value !== undefined && value.length > RESOURCE_LIMITS.maxAttributeValueLength) {
    return {
      issue: createIssue(
        "resource-limit",
        line,
        token.column,
        `Attribute values may contain at most ${String(RESOURCE_LIMITS.maxAttributeValueLength)} characters.`
      ),
    };
  }

  budget.reserveParserBytes(
    RESOURCE_LIMITS.gitattributesAttributeRetainedBytes +
      Buffer.byteLength(name, "utf8") +
      Buffer.byteLength(pattern, "utf8") +
      (value === undefined ? 0 : Buffer.byteLength(value, "utf8"))
  );

  const attribute: GitattributesAttributeUsage = {
    column: token.column,
    kind,
    line,
    name,
    pattern,
    state,
    ...(value === undefined ? {} : { value }),
  };

  if (kind === "reserved") {
    return {
      attribute,
      issue: createIssue(
        "reserved-builtin-attribute",
        line,
        token.column,
        `${name} is reserved by Git and cannot be assigned in a .gitattributes file.`
      ),
    };
  }

  if (kind === "custom" && !allowedAttributes.has(name)) {
    const suggestion = findUniqueCloseBuiltinAttribute(name);
    if (suggestion !== undefined) {
      return {
        attribute,
        issue: createIssue(
          "possible-attribute-typo",
          line,
          token.column,
          `Unknown attribute ${JSON.stringify(name)} is close to ${JSON.stringify(suggestion.name)} (distance ${String(suggestion.distance)}).`,
          "warning"
        ),
      };
    }
  }

  return { attribute };
}

function validateRulePolicy(rule: GitattributesRule): readonly GitattributesIssue[] {
  const issues: GitattributesIssue[] = [];
  const attributesByName = new Map(
    rule.attributes.map((attribute) => [attribute.name, attribute] as const)
  );
  const eol = attributesByName.get("eol");
  const text = attributesByName.get("text");
  const encoding = attributesByName.get("working-tree-encoding");
  const conflictMarkerSize = attributesByName.get("conflict-marker-size");

  if (eol !== undefined && eol.state !== "unspecified") {
    if (eol.state !== "value") {
      issues.push(
        createIssue(
          "attribute-without-value",
          eol.line,
          eol.column,
          "The eol attribute must be set to lf or crlf.",
          "error"
        )
      );
    } else if (eol.value !== "lf" && eol.value !== "crlf") {
      issues.push(
        createIssue(
          "invalid-eol-value",
          eol.line,
          eol.column,
          `eol must be either lf or crlf, received ${JSON.stringify(eol.value)}.`
        )
      );
    }

  }

  if (text !== undefined && text.state === "value" && text.value !== "auto") {
    issues.push(
      createIssue(
        "invalid-text-value",
        text.line,
        text.column,
        `text may only use the value auto, received ${JSON.stringify(text.value)}.`
      )
    );
  }

  if (encoding !== undefined && encoding.state !== "unspecified") {
    if (encoding.state !== "value" || encoding.value?.length === 0) {
      issues.push(
        createIssue(
          "invalid-working-tree-encoding",
          encoding.line,
          encoding.column,
          "working-tree-encoding requires a non-empty encoding value."
        )
      );
    }

    if (text === undefined) {
      issues.push(
        createIssue(
          "attribute-without-value",
          encoding.line,
          encoding.column,
          "working-tree-encoding is specified without text in the same rule; make the text policy explicit.",
          "warning"
        )
      );
    }
  }

  if (conflictMarkerSize !== undefined && conflictMarkerSize.state !== "unspecified") {
    if (
      conflictMarkerSize.state !== "value" ||
      !/^[1-9][0-9]*$/u.test(conflictMarkerSize.value ?? "")
    ) {
      issues.push(
        createIssue(
          "invalid-conflict-marker-size",
          conflictMarkerSize.line,
          conflictMarkerSize.column,
          "conflict-marker-size must be a positive integer."
        )
      );
    }
  }

  if (
    attributesByName.has("binary") &&
    ["text", "diff", "merge"].some((name) => attributesByName.has(name))
  ) {
    const binary = attributesByName.get("binary");
    issues.push(
      createIssue(
        "conflicting-attributes",
        binary?.line ?? rule.line,
        binary?.column ?? rule.column,
        "binary is a macro for -diff -merge -text and should not be combined with text, diff, or merge in the same rule.",
        "warning"
      )
    );
  }

  return issues;
}

export function isBuiltinAttribute(name: string): boolean {
  return !isReservedBuiltinAttribute(name) && builtinAttributeNames.has(name);
}

export function isReservedBuiltinAttribute(name: string): boolean {
  return name.startsWith("builtin_");
}

const ATTRIBUTE_TYPO_DISTANCE_THRESHOLD = 2;

function findUniqueCloseBuiltinAttribute(
  name: string
): { readonly distance: number; readonly name: string } | undefined {
  if (name.length > RESOURCE_LIMITS.maxAttributeNameLength) {
    return undefined;
  }

  let bestDistance = ATTRIBUTE_TYPO_DISTANCE_THRESHOLD + 1;
  let bestName: string | undefined;
  let tied = false;

  for (const candidate of BUILTIN_ATTRIBUTE_NAMES) {
    if (isReservedBuiltinAttribute(candidate)) {
      continue;
    }

    const distance = levenshteinDistance(name, candidate, bestDistance);
    if (distance > ATTRIBUTE_TYPO_DISTANCE_THRESHOLD) {
      continue;
    }

    if (distance < bestDistance) {
      bestDistance = distance;
      bestName = candidate;
      tied = false;
    } else if (distance === bestDistance) {
      tied = true;
    }
  }

  if (bestName === undefined || tied) {
    return undefined;
  }

  return { distance: bestDistance, name: bestName };
}

function levenshteinDistance(left: string, right: string, cutoff: number): number {
  if (Math.abs(left.length - right.length) > cutoff) {
    return cutoff + 1;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];

    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      const distance = Math.min(
        (current[rightIndex - 1] ?? leftIndex) + 1,
        (previous[rightIndex] ?? leftIndex) + 1,
        (previous[rightIndex - 1] ?? leftIndex - 1) + substitutionCost
      );
      current[rightIndex] = distance;
    }

    previous = current;
  }

  return previous[right.length] ?? cutoff + 1;
}

function createAnalysis(
  attributes: readonly GitattributesAttributeUsage[],
  rules: readonly GitattributesRule[],
  issues: readonly GitattributesIssue[]
): GitattributesAnalysis {
  const builtinAttributes = attributes.filter(({ kind }) => kind === "builtin");
  const customAttributes = attributes.filter(({ kind }) => kind === "custom");
  const reservedAttributes = attributes.filter(({ kind }) => kind === "reserved");
  const errors = issues.filter(({ severity }) => severity === "error");
  const warnings = issues.filter(({ severity }) => severity === "warning");

  return {
    attributes,
    builtinAttributes,
    customAttributes,
    errors,
    hasBuiltinAttributes: builtinAttributes.length > 0,
    issues,
    reservedAttributes,
    rules,
    valid: errors.length === 0,
    warnings,
  };
}

export function analyzeGitattributes(
  source: string,
  options: GitattributesAnalysisOptions = {}
): GitattributesAnalysis {
  const attributes: GitattributesAttributeUsage[] = [];
  const rules: GitattributesRule[] = [];
  const budget = options.budget ?? new AnalysisBudget();
  const diagnostics = new DiagnosticCollector(budget);
  let attributeLimitReached = false;

  if (
    Buffer.byteLength(source, "utf8") > RESOURCE_LIMITS.maxGitattributesBytes ||
    source.length > RESOURCE_LIMITS.maxGitattributesCharacters
  ) {
    diagnostics.add(
      createIssue(
        "resource-limit",
        1,
        1,
        `The .gitattributes file exceeds the ${String(RESOURCE_LIMITS.maxGitattributesBytes)}-byte input limit.`
      )
    );
    return createAnalysis(attributes, rules, diagnostics.issues);
  }

  try {
    budget.reserveParserBytes(Buffer.byteLength(source, "utf8") * 2);
  } catch (error: unknown) {
    if (!(error instanceof ResourceBudgetExceededError)) {
      throw error;
    }

    diagnostics.add(createIssue("resource-limit", 1, 1, error.message));
    return createAnalysis(attributes, rules, diagnostics.issues);
  }

  const allowedAttributes = new Set<string>();
  for (const name of options.allowedAttributes ?? []) {
    if (allowedAttributes.size >= RESOURCE_LIMITS.maxAllowedAttributes) {
      diagnostics.add(
        createIssue(
          "resource-limit",
          1,
          1,
          `At most ${String(RESOURCE_LIMITS.maxAllowedAttributes)} allowed attributes may be configured.`
        )
      );
      break;
    }

    if (name.length > RESOURCE_LIMITS.maxAttributeNameLength) {
      diagnostics.add(
        createIssue(
          "resource-limit",
          1,
          1,
          `Allowed attribute names may contain at most ${String(RESOURCE_LIMITS.maxAttributeNameLength)} characters.`
        )
      );
      continue;
    }

    if (!allowedAttributes.has(name)) {
      try {
        budget.reserveParserBytes(64 + Buffer.byteLength(name, "utf8"));
      } catch (error: unknown) {
        if (!(error instanceof ResourceBudgetExceededError)) {
          throw error;
        }

        diagnostics.add(createIssue("resource-limit", 1, 1, error.message));
        return createAnalysis(attributes, rules, diagnostics.issues);
      }
    }

    allowedAttributes.add(name);
  }

  const sourceWithoutBom = source.startsWith("\uFEFF") ? source.slice(1) : source;
  let lineNumber = 1;
  let lineStart = 0;
  while (lineStart < sourceWithoutBom.length) {
    if (diagnostics.isResourceLimited) {
      break;
    }

    try {
      budget.checkElapsed();
    } catch (error: unknown) {
      if (!(error instanceof ResourceBudgetExceededError)) {
        throw error;
      }

      diagnostics.add(createIssue("resource-limit", lineNumber, 1, error.message));
      break;
    }

    if (lineNumber > RESOURCE_LIMITS.maxGitattributesLines) {
      diagnostics.add(
        createIssue(
          "resource-limit",
          lineNumber,
          1,
          `A .gitattributes file may contain at most ${String(RESOURCE_LIMITS.maxGitattributesLines)} lines.`
        )
      );
      break;
    }

    const newlineIndex = sourceWithoutBom.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? sourceWithoutBom.length : newlineIndex;
    const line = sourceWithoutBom.endsWith("\r", lineEnd) && lineEnd > lineStart
      ? sourceWithoutBom.slice(lineStart, lineEnd - 1)
      : sourceWithoutBom.slice(lineStart, lineEnd);

    if (line.length > RESOURCE_LIMITS.maxLineLength) {
      diagnostics.add(
        createIssue(
          "resource-limit",
          lineNumber,
          RESOURCE_LIMITS.maxLineLength + 1,
          `A line may contain at most ${String(RESOURCE_LIMITS.maxLineLength)} characters.`
        )
      );
    } else {
    const tokenization = tokenizeLine(line, lineNumber);

    if (tokenization.issue !== undefined) {
      diagnostics.add(tokenization.issue);
    } else if (tokenization.tokens.length > 0) {
      const [patternToken, ...attributeTokens] = tokenization.tokens;
      if (patternToken !== undefined) {
        const macroIssue = validateMacroName(patternToken, lineNumber);
        if (macroIssue !== undefined) {
          diagnostics.add(macroIssue);
        }

        if (attributeTokens.length === 0) {
          diagnostics.add(
            createIssue(
              "missing-attribute",
              lineNumber,
              patternToken.column,
              "A gitattributes rule must define at least one attribute."
            )
          );
        } else {
          if (patternToken.value.startsWith("!")) {
            diagnostics.add(
              createIssue(
                "negative-pattern",
                lineNumber,
                patternToken.column,
                "Negative patterns are not allowed in .gitattributes files."
              )
            );
          }

          if (rules.length >= RESOURCE_LIMITS.maxGitattributesRules) {
            diagnostics.add(
              createIssue(
                "resource-limit",
                lineNumber,
                patternToken.column,
                `A .gitattributes file may contain at most ${String(RESOURCE_LIMITS.maxGitattributesRules)} rules.`
              )
            );
            attributeLimitReached = true;
          } else {
            let parsed: ParsedRule | undefined;
            try {
              parsed = parseRule(
                patternToken,
                attributeTokens,
                lineNumber,
                attributes,
                diagnostics,
                allowedAttributes,
                budget
              );
            } catch (error: unknown) {
              if (!(error instanceof ResourceBudgetExceededError)) {
                throw error;
              }

              diagnostics.add(
                createIssue("resource-limit", lineNumber, patternToken.column, error.message)
              );
              attributeLimitReached = true;
            }

            if (parsed !== undefined) {
              rules.push(parsed.rule);
              diagnostics.addMany(validateRulePolicy(parsed.rule));
              if (parsed.attributeLimitReached) {
                attributeLimitReached = true;
              }
            }
          }
        }
      }
    }

    if (attributeLimitReached) {
      break;
    }
    }

    if (diagnostics.isTruncated || diagnostics.isResourceLimited) {
      break;
    }

    if (newlineIndex === -1) {
      break;
    }

    lineStart = newlineIndex + 1;
    lineNumber += 1;
  }

  return createAnalysis(attributes, rules, diagnostics.issues);
}

function validateMacroName(
  patternToken: Token,
  lineNumber: number
): GitattributesIssue | undefined {
  if (!patternToken.value.startsWith("[attr]")) {
    return undefined;
  }

  const macroName = patternToken.value.slice("[attr]".length);
  if (!isValidAttributeName(macroName) || isReservedBuiltinAttribute(macroName)) {
    return createIssue(
      "invalid-attribute",
      lineNumber,
      patternToken.column,
      `Invalid macro attribute name ${JSON.stringify(macroName)}.`
    );
  }

  return undefined;
}

interface ParsedRule {
  readonly attributeLimitReached: boolean;
  readonly rule: GitattributesRule;
}

function parseRule(
  patternToken: Token,
  attributeTokens: readonly Token[],
  lineNumber: number,
  attributes: GitattributesAttributeUsage[],
  diagnostics: DiagnosticCollector,
  allowedAttributes: ReadonlySet<string>,
  budget: AnalysisBudget
): ParsedRule {
  budget.reserveParserBytes(
    RESOURCE_LIMITS.gitattributesRuleRetainedBytes +
      Buffer.byteLength(patternToken.value, "utf8")
  );
  const ruleAttributes: GitattributesAttributeUsage[] = [];
  let attributeLimitReached = false;
  for (const token of attributeTokens) {
    if (attributes.length >= RESOURCE_LIMITS.maxGitattributesAttributes) {
      diagnostics.add(
        createIssue(
          "resource-limit",
          lineNumber,
          token.column,
          `A .gitattributes file may define at most ${String(RESOURCE_LIMITS.maxGitattributesAttributes)} attributes.`
        )
      );
      attributeLimitReached = true;
      break;
    }

    const parsed = parseAttribute(
      token,
      patternToken.value,
      lineNumber,
      allowedAttributes,
      budget
    );
    if (parsed.attribute !== undefined) {
      attributes.push(parsed.attribute);
      ruleAttributes.push(parsed.attribute);
    }
    if (parsed.issue !== undefined) {
      diagnostics.add(parsed.issue);
    }
  }

  return {
    attributeLimitReached,
    rule: {
      attributes: ruleAttributes,
      column: patternToken.column,
      isMacroDefinition: patternToken.value.startsWith("[attr]"),
      line: lineNumber,
      pattern: patternToken.value,
    },
  };
}
