import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  findGitRepositoryRoot,
  GitResourceLimitError,
  isGitCaseInsensitive,
  scanGitAttributes,
} from "../src/git-attributes.js";
import { RESOURCE_LIMITS } from "../src/limits.js";
import { AnalysisBudget } from "../src/resource-budget.js";
import { analyzeGitattributesFile } from "../src/linter.js";

const execFileAsync = promisify(execFile);

describe("Git-backed attribute analysis", () => {
  it("reports Git case sensitivity and returns undefined outside a repository", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const repository = join(parent, "repo");

    try {
      await mkdir(repository);
      await execFileAsync("git", ["init", "--quiet", repository]);
      await execFileAsync("git", ["-C", repository, "config", "core.ignorecase", "true"]);

      await expect(isGitCaseInsensitive(repository)).resolves.toBe(true);
      await execFileAsync("git", ["-C", repository, "config", "core.ignorecase", "false"]);
      await expect(isGitCaseInsensitive(repository)).resolves.toBe(false);
      await execFileAsync("git", ["-C", repository, "config", "--unset", "core.ignorecase"]);
      await expect(isGitCaseInsensitive(repository)).resolves.toBe(false);
      await expect(findGitRepositoryRoot(parent)).resolves.toBeUndefined();
      await expect(
        findGitRepositoryRoot(repository, new AnalysisBudget({ maxElapsedMs: 0 }))
      ).rejects.toMatchObject({
        kind: "analysis-time",
        name: "AnalysisResourceLimitError",
      });
      await expect(
        isGitCaseInsensitive(repository, new AnalysisBudget({ maxElapsedMs: 0 }))
      ).rejects.toMatchObject({
        kind: "analysis-time",
        name: "AnalysisResourceLimitError",
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("streams paths and effective attributes through async handlers", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const paths: string[] = [];
    const attributes: Array<{ name: string; path: string; value: string }> = [];

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(
        join(repository, ".gitattributes"),
        "* text custom=value\n",
        "utf8"
      );
      await writeFile(join(repository, "guide.md"), "guide\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const result = await scanGitAttributes(repository, [], {
        onAttribute: async (attribute) => {
          await Promise.resolve();
          attributes.push(attribute);
        },
        onPath: async (path) => {
          await Promise.resolve();
          paths.push(path);
        },
      });

      expect(result.checkedPathCount).toBe(paths.length);
      expect(result.effectiveAttributeCount).toBe(attributes.length);
      expect(paths).toEqual(expect.arrayContaining(["guide.md"]));
      expect(attributes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "text", path: "guide.md", value: "set" }),
          expect.objectContaining({ name: "custom", path: "guide.md", value: "value" }),
        ])
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("checks additional paths that Git did not list", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const observedPaths: string[] = [];

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "* text\n", "utf8");
      await writeFile(join(repository, ".gitignore"), "ignored.txt\n", "utf8");
      await writeFile(join(repository, "ignored.txt"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", ".gitattributes", ".gitignore"]);

      const result = await scanGitAttributes(
        repository,
        [join(repository, "ignored.txt"), join(repository, "..", "outside.txt")],
        {
          onPath: (path) => {
            observedPaths.push(path);
          },
        }
      );

      expect(result.checkedPathCount).toBe(observedPaths.length);
      expect(observedPaths).toContain("ignored.txt");
      expect(observedPaths).not.toContain("outside.txt");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects oversized additional repository paths before spawning Git", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await expect(
        scanGitAttributes(repository, [
          join(repository, "x".repeat(RESOURCE_LIMITS.maxGitPathLength + 1)),
        ])
      ).rejects.toBeInstanceOf(GitResourceLimitError);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects an expired scan budget before starting subprocesses", async () => {
    await expect(
      scanGitAttributes(
        "/nonexistent-repository",
        [],
        {},
        new AnalysisBudget({ maxElapsedMs: 0 })
      )
    ).rejects.toMatchObject({
      kind: "analysis-time",
      name: "AnalysisResourceLimitError",
    });
  });

  it("does not reject Git's known negative-pattern advisory", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(
        join(repository, ".gitattributes"),
        "!ignored.txt text\n*.txt text\n",
        "utf8"
      );
      await writeFile(join(repository, "file.txt"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.errors).toEqual([
        expect.objectContaining({ code: "negative-pattern" }),
      ]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("terminates the scan when an asynchronous handler fails", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "* text\n", "utf8");
      await writeFile(join(repository, "file.txt"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      await expect(
        scanGitAttributes(repository, [], {
          onAttribute: async () => {
            await Promise.resolve();
            throw new Error("handler failed");
          },
        })
      ).rejects.toThrow("handler failed");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("uses git check-attr to collect effective built-in and custom attributes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const nestedDirectory = join(repository, "docs");

    try {
      await mkdir(nestedDirectory);
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "*.md text custom=value\n", "utf8");
      await writeFile(join(nestedDirectory, "guide.md"), "# Guide\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.effectiveBuiltinAttributeNames).toContain("text");
      expect(analysis.effectiveCustomAttributeNames).toContain("custom");
      expect(analysis.effectiveAttributeCount).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("does not duplicate effective results for an additional path already listed by Git", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "* marker\n", "utf8");
      await writeFile(join(repository, "file.txt"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.checkedPathCount).toBe(2);
      expect(analysis.effectiveAttributeCount).toBe(2);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("preserves repository roots ending in whitespace", async () => {
    const parent = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      for (const suffix of [" ", "\n"]) {
        const repository = join(parent, "repo" + suffix);
        await mkdir(repository);
        await execFileAsync("git", ["init", "--quiet", repository]);

        await expect(findGitRepositoryRoot(repository)).resolves.toBe(
          await realpath(repository)
        );
      }
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("reports patterns that do not match any repository path", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(
        join(repository, ".gitattributes"),
        "*.md text\n*.psd binary\n",
        "utf8"
      );
      await writeFile(join(repository, "README.md"), "# README\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.unusedPatterns.map(({ pattern }) => pattern)).toEqual(["*.psd"]);
      expect(analysis.warnings).toEqual([
        expect.objectContaining({
          code: "unused-pattern",
          line: 2,
          severity: "warning",
        }),
      ]);
      expect(analysis.valid).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("does not treat malformed bracket patterns as applied by Git", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "[ marker\n", "utf8");
      await writeFile(join(repository, "["), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.unusedPatterns.map(({ pattern }) => pattern)).toEqual(["["]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("keeps root-anchored patterns scoped to the attribute directory", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const nestedDirectory = join(repository, "nested");

    try {
      await mkdir(nestedDirectory);
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "/foo.txt text\n", "utf8");
      await writeFile(join(nestedDirectory, "foo.txt"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.unusedPatterns.map(({ pattern }) => pattern)).toEqual([
        "/foo.txt",
      ]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("matches patterns relative to a nested attribute file directory", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const nestedDirectory = join(repository, "nested");

    try {
      await mkdir(nestedDirectory);
      await execFileAsync("git", ["init", "--quiet", repository]);
      const filePath = join(nestedDirectory, ".gitattributes");
      await writeFile(filePath, "*.md text\n", "utf8");
      await writeFile(join(repository, "README.md"), "root\n", "utf8");
      await writeFile(join(nestedDirectory, "guide.md"), "guide\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: filePath,
      });

      expect(analysis.unusedPatterns).toEqual([]);
      expect(analysis.checkedPathCount).toBeGreaterThanOrEqual(3);
      expect(analysis.effectiveBuiltinAttributeNames).toContain("text");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("matches UTF-8 paths encoded with C-style octal escapes", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "\"\\303\\251.txt\" marker\n", "utf8");
      await writeFile(join(repository, "é.txt"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.unusedPatterns).toEqual([]);
      expect(analysis.effectiveCustomAttributeNames).toContain("marker");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("keeps Git case-insensitive matching ASCII-only", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await execFileAsync("git", ["-C", repository, "config", "core.ignorecase", "true"]);
      await writeFile(join(repository, ".gitattributes"), "s marker\n", "utf8");
      await writeFile(join(repository, "ſ"), "content\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.unusedPatterns.map(({ pattern }) => pattern)).toEqual(["s"]);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("surfaces diagnostics from a successful git check-attr command", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const nestedDirectory = join(repository, "nested");

    try {
      await mkdir(nestedDirectory);
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(nestedDirectory, ".gitattributes"), "[attr]docs text\n*.md docs\n", "utf8");
      await writeFile(join(nestedDirectory, "guide.md"), "# Guide\n", "utf8");
      await execFileAsync("git", ["-C", repository, "add", "."]);

      await expect(
        analyzeGitattributesFile({
          cwd: repository,
          path: join(nestedDirectory, ".gitattributes"),
        })
      ).rejects.toThrow("completed with diagnostics");
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("never executes configured filter, diff, or merge drivers", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const marker = join(tmpdir(), `gitattributes-lint-driver-${Date.now()}`);
    const driver = join(repository, "driver.sh");

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(
        join(repository, ".gitattributes"),
        "*.txt filter=evil diff=evil merge=evil\n",
        "utf8"
      );
      await writeFile(join(repository, "file.txt"), "content\n", "utf8");
      await writeFile(
        driver,
        `#!/bin/sh\nprintf '%s\\n' invoked > ${JSON.stringify(marker)}\n`,
        "utf8"
      );
      await chmod(driver, 0o755);

      for (const key of [
        "filter.evil.clean",
        "filter.evil.smudge",
        "filter.evil.process",
        "diff.evil.command",
        "merge.evil.driver",
      ]) {
        await execFileAsync("git", ["-C", repository, "config", "--local", key, driver]);
      }

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.effectiveCustomAttributeNames).toEqual([]);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(repository, { recursive: true, force: true });
      await rm(marker, { force: true });
    }
  });

  it("exposes an explicit disabled configuration mode for untrusted repositories", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "*.txt text\n", "utf8");
      await writeFile(
        join(repository, "gitattributes-lint.config.js"),
        "throw new Error('JavaScript config must not be evaluated');\n",
        "utf8"
      );

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        noConfig: true,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.configMode).toBe("disabled");
      expect(analysis.valid).toBe(true);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("does not read the contents of other working-tree files", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const unreadableFile = join(repository, "secret.txt");

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await writeFile(join(repository, ".gitattributes"), "*.txt text\n", "utf8");
      await writeFile(unreadableFile, "secret\n", "utf8");
      await chmod(unreadableFile, 0o000);

      const analysis = await analyzeGitattributesFile({
        cwd: repository,
        path: join(repository, ".gitattributes"),
      });

      expect(analysis.checkedPathCount).toBeGreaterThanOrEqual(1);
      expect(analysis.valid).toBe(true);
    } finally {
      await chmod(unreadableFile, 0o644).catch(() => undefined);
      await rm(repository, { recursive: true, force: true });
    }
  });
});
