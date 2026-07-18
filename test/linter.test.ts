import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitattributesNotFoundError,
  GitattributesValidationError,
  analyzeGitattributesFile,
  getLintExitCode,
  lint,
  resolveGitattributesFile,
} from "../src/linter.js";
import { RESOURCE_LIMITS } from "../src/limits.js";

describe("linter API", () => {
  it("returns the expected exit code for errors and strict warnings", () => {
    const warning = {
      code: "unused-pattern",
      column: 1,
      line: 1,
      message: "warning",
      rule: "gitattributes/unused-pattern",
      severity: "warning",
    } as const;

    expect(getLintExitCode({ valid: true, warnings: [] })).toBe(0);
    expect(getLintExitCode({ valid: false, warnings: [] })).toBe(1);
    expect(getLintExitCode({ valid: true, warnings: [warning] })).toBe(0);
    expect(getLintExitCode({ valid: true, warnings: [warning] }, { strict: true })).toBe(1);
  });

  it("exposes validation issues and formatted messages through lint", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(filePath, "*.txt eol=windows\n", "utf8");

      await expect(lint({ cwd: directory, path: filePath })).rejects.toSatisfy(
        (error: unknown) => {
          expect(error).toBeInstanceOf(GitattributesValidationError);
          const validationError = error as GitattributesValidationError;
          expect(validationError.issues).toEqual([
            expect.objectContaining({
              code: "invalid-eol-value",
              line: 1,
              severity: "error",
            }),
          ]);
          expect(validationError.message).toContain("gitattributes/invalid-eol-value");
          return true;
        }
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports a missing file when resolution has no repository fallback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await expect(resolveGitattributesFile({ cwd: directory })).rejects.toBeInstanceOf(
        GitattributesNotFoundError
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns no effective Git data for an explicit non-repository file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, "custom.gitattributes");
      await writeFile(filePath, "*.txt text custom=value\n", "utf8");

      const analysis = await analyzeGitattributesFile({
        cwd: directory,
        path: filePath,
      });

      expect(analysis.valid).toBe(true);
      expect(analysis.repositoryRoot).toBeUndefined();
      expect(analysis.checkedPathCount).toBe(0);
      expect(analysis.effectiveAttributeCount).toBe(0);
      expect(analysis.effectiveBuiltinAttributeNames).toEqual([]);
      expect(analysis.effectiveCustomAttributeNames).toEqual([]);
      expect(analysis.unusedPatterns).toEqual([]);
      expect(analysis.configMode).toBe("default");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("short-circuits Git scanning when parser diagnostics hit a resource limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(
        filePath,
        `*.txt custom=${"x".repeat(RESOURCE_LIMITS.maxAttributeValueLength + 1)}\n`,
        "utf8"
      );

      const analysis = await analyzeGitattributesFile({
        cwd: directory,
        path: filePath,
      });

      expect(analysis.valid).toBe(false);
      expect(analysis.issues).toEqual([
        expect.objectContaining({ code: "resource-limit" }),
      ]);
      expect(analysis.checkedPathCount).toBe(0);
      expect(analysis.effectiveAttributeCount).toBe(0);
      expect(analysis.unusedPatterns).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("caps unused-pattern diagnostics without retaining the omitted rules", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const lines = Array.from(
        { length: RESOURCE_LIMITS.maxDiagnostics + 1 },
        (_, index) => `unused-${String(index)}.txt text`
      );
      await writeFile(join(repository, ".gitattributes"), `${lines.join("\n")}\n`, "utf8");
      await writeFile(join(repository, "present.txt"), "content\n", "utf8");

      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      await promisify(execFile)("git", ["init", "--quiet", repository]);
      await promisify(execFile)("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.issues).toHaveLength(RESOURCE_LIMITS.maxDiagnostics);
      expect(analysis.issues.at(-1)).toMatchObject({ code: "resource-limit" });
      expect(analysis.unusedPatterns).toHaveLength(RESOURCE_LIMITS.maxDiagnostics - 1);
      expect(analysis.valid).toBe(false);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
