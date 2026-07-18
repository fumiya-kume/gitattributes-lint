#!/usr/bin/env node

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, CommanderError, InvalidArgumentError } from "commander";
import {
  analyzeGitattributesFile,
  getLintExitCode,
  type GitattributesFileAnalysis,
} from "./linter.js";

const require = createRequire(import.meta.url);
const packageMetadata = require("../package.json") as {
  readonly name: string;
  readonly version: string;
  readonly description: string;
};

type OutputFormat = "stylish" | "json";

interface CliOptions {
  readonly allowAttribute: readonly string[];
  readonly config: boolean;
  readonly cwd: string;
  readonly format: OutputFormat;
  readonly strict: boolean;
}

function parseOutputFormat(value: string): OutputFormat {
  if (value === "stylish" || value === "json") {
    return value;
  }

  throw new InvalidArgumentError("format must be either stylish or json");
}

function resolveWorkingDirectory(cwd: string): string {
  return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
}

function collectAllowedAttribute(value: string, previous: readonly string[]): readonly string[] {
  return [...previous, value];
}

function unique(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

function reportForJson(analysis: GitattributesFileAnalysis, exitCode: 0 | 1) {
  return {
    builtinAttributes: unique(analysis.builtinAttributes.map(({ name }) => name)),
    checkedPathCount: analysis.checkedPathCount,
    configMode: analysis.configMode,
    customAttributes: unique(analysis.customAttributes.map(({ name }) => name)),
    effective: {
      builtinAttributes: analysis.effectiveBuiltinAttributeNames,
      customAttributes: analysis.effectiveCustomAttributeNames,
    },
    effectiveAttributeCount: analysis.effectiveAttributeCount,
    errors: analysis.errors,
    file: analysis.filePath,
    unusedPatterns: analysis.unusedPatterns.map(({ line, pattern }) => ({
      line,
      pattern,
    })),
    valid: exitCode === 0,
    warnings: analysis.warnings,
  };
}

function isResourceLimitError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    [
      "AnalysisResourceLimitError",
      "GitResourceLimitError",
      "GitattributesPatternResourceLimitError",
      "GitattributesResourceLimitError",
    ].includes(error.name)
  );
}

function printStylish(analysis: GitattributesFileAnalysis): void {
  if (analysis.issues.length === 0) {
    console.log(true);
    return;
  }

  for (const issue of analysis.issues) {
    console.log(
      `${analysis.filePath}:${issue.line}:${issue.column} ${issue.severity} ${issue.rule}: ${issue.message}`
    );
  }

  console.log(
    `${analysis.errors.length} error(s), ${analysis.warnings.length} warning(s)`
  );
}

export function createProgram(): Command {
  const program = new Command();

  program
    .name("gitattributes-lint")
    .description(packageMetadata.description)
    .version(packageMetadata.version)
    .argument("[path]", "path to a .gitattributes file")
    .option("-C, --cwd <directory>", "directory to run the linter from", process.cwd())
    .option(
      "-f, --format <format>",
      "output format: stylish or json",
      parseOutputFormat,
      "stylish"
    )
    .option("--strict", "treat warnings as errors")
    .option(
      "--allow-attribute <name>",
      "allow a custom attribute name without typo warnings (repeatable)",
      collectAllowedAttribute,
      []
    )
    .option("--no-config", "do not load JavaScript configuration files")
    .showSuggestionAfterError();

  program.action(async (path: string | undefined, options: CliOptions) => {
    let analysis: GitattributesFileAnalysis;
    try {
      analysis = await analyzeGitattributesFile({
        allowedAttributes: options.allowAttribute,
        cwd: resolveWorkingDirectory(options.cwd),
        noConfig: options.config === false,
        path,
      });
    } catch (error: unknown) {
      if (options.format === "json" && isResourceLimitError(error)) {
        console.log(JSON.stringify({ error: error.message, valid: false }));
        process.exitCode = 1;
        return;
      }

      throw error;
    }

    const exitCode = getLintExitCode(analysis, { strict: options.strict });

    if (options.format === "json") {
      console.log(JSON.stringify(reportForJson(analysis, exitCode)));
    } else {
      printStylish(analysis);
    }

    process.exitCode = exitCode;
  });

  return program;
}

export async function main(argv: readonly string[] = process.argv): Promise<void> {
  const program = createProgram().exitOverride();

  try {
    await program.parseAsync(argv);
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode;
      return;
    }

    throw error;
  }
}

export function isMainModule(
  argv1: string | undefined = process.argv[1],
  modulePath: string = fileURLToPath(import.meta.url)
): boolean {
  if (argv1 === undefined) {
    return false;
  }

  try {
    return realpathSync(modulePath) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`gitattributes-lint: ${message}`);
    process.exitCode = 1;
  });
}
