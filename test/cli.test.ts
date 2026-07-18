import { describe, expect, it, vi } from "vitest";
import { createProgram, isMainModule, main } from "../src/cli.js";
import {
  GitattributesValidationError,
  GitattributesResourceLimitError,
  GitattributesSymlinkError,
  lint,
  resolveGitattributesFile,
} from "../src/linter.js";
import { RESOURCE_LIMITS } from "../src/limits.js";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function runCli(argv: readonly string[]): Promise<{
  readonly errors: readonly string[];
  readonly exitCode: string | number | undefined;
  readonly logs: readonly string[];
}> {
  const originalExitCode = process.exitCode;
  const errors: string[] = [];
  const logs: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map(String).join(" "));
  });
  const error = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map(String).join(" "));
  });
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    errors.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write);

  process.exitCode = undefined;
  try {
    await main(argv);
    return { errors, exitCode: process.exitCode, logs };
  } finally {
    log.mockRestore();
    error.mockRestore();
    stderr.mockRestore();
    process.exitCode = originalExitCode;
  }
}

describe("gitattributes-lint CLI", () => {
  it("exposes the package name and version in its help", () => {
    const help = createProgram().helpInformation();

    expect(help).toContain("Usage: gitattributes-lint");
    expect(help).toContain("[path]");
    expect(help).toContain("-f, --format <format>");
    expect(help).toContain("--strict");
    expect(help).toContain("--allow-attribute <name>");
    expect(help).toContain("--no-config");
  });

  it("prints a JSON report for a valid explicit file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(filePath, "*.txt text custom=value\n", "utf8");

      const result = await runCli([
        "node",
        "gitattributes-lint",
        "--format",
        "json",
        filePath,
      ]);
      const report = JSON.parse(result.logs[0] ?? "{}");

      expect(result.exitCode).toBe(0);
      expect(report).toMatchObject({
        configMode: "default",
        file: await realpath(filePath),
        valid: true,
      });
      expect(report.builtinAttributes).toEqual(["text"]);
      expect(report.customAttributes).toEqual(["custom"]);
      expect(report.effectiveAttributeCount).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prints stylish diagnostics and fails for invalid input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(filePath, "*.txt eol=windows\n", "utf8");

      const result = await runCli(["node", "gitattributes-lint", filePath]);

      expect(result.exitCode).toBe(1);
      expect(result.logs).toHaveLength(2);
      expect(result.logs[0]).toContain("gitattributes/invalid-eol-value");
      expect(result.logs[1]).toBe("1 error(s), 0 warning(s)");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("makes warnings fail only in strict mode and supports allow-attribute", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(filePath, "*.txt texxt\n", "utf8");

      const normal = await runCli(["node", "gitattributes-lint", filePath]);
      expect(normal.exitCode).toBe(0);
      expect(normal.logs[1]).toBe("0 error(s), 1 warning(s)");

      const strict = await runCli([
        "node",
        "gitattributes-lint",
        "--strict",
        filePath,
      ]);
      expect(strict.exitCode).toBe(1);

      const allowed = await runCli([
        "node",
        "gitattributes-lint",
        "--allow-attribute",
        "texxt",
        filePath,
      ]);
      expect(allowed.exitCode).toBe(0);
      expect(allowed.logs).toEqual(["true"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("resolves cwd, exposes disabled config mode, and rejects invalid formats", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      await writeFile(join(directory, ".gitattributes"), "*.txt text\n", "utf8");

      const result = await runCli([
        "node",
        "gitattributes-lint",
        "--cwd",
        directory,
        "--no-config",
        "--format",
        "json",
      ]);
      const report = JSON.parse(result.logs[0] ?? "{}");
      expect(result.exitCode).toBe(0);
      expect(report.configMode).toBe("disabled");

      const invalid = await runCli([
        "node",
        "gitattributes-lint",
        "--format",
        "yaml",
      ]);
      expect(invalid.exitCode).toBe(1);
      expect(invalid.logs).toEqual([]);
      expect(invalid.errors[0]).toContain("format must be either stylish or json");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns a JSON resource error for an oversized file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(
        filePath,
        "x".repeat(RESOURCE_LIMITS.maxGitattributesBytes + 1),
        "utf8"
      );

      const result = await runCli([
        "node",
        "gitattributes-lint",
        "--format",
        "json",
        filePath,
      ]);
      const report = JSON.parse(result.logs[0] ?? "{}");

      expect(result.exitCode).toBe(1);
      expect(report).toMatchObject({ valid: false });
      expect(report.error).toContain("input limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("recognizes a symlinked CLI entry point as the main module", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const target = join(directory, "cli.js");
      const symlinkPath = join(directory, "gitattributes-lint");
      await writeFile(target, "", "utf8");
      await symlink(target, symlinkPath);

      expect(isMainModule(symlinkPath, target)).toBe(true);
      expect(isMainModule(undefined, target)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reads an explicitly specified file and returns true", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, "custom.gitattributes");
      await writeFile(filePath, "*.md text\n", "utf8");

      await expect(lint({ cwd: directory, path: filePath })).resolves.toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects assignments to Git's reserved built-in namespace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, "custom.gitattributes");
      await writeFile(filePath, "* builtin_objectmode=100644\n", "utf8");

      await expect(lint({ cwd: directory, path: filePath })).rejects.toBeInstanceOf(
        GitattributesValidationError
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("prefers the current directory and falls back to the repository root", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const nestedDirectory = join(repository, "nested");

    try {
      await mkdir(nestedDirectory);
      await execFileAsync("git", ["init", "--quiet", repository]);

      const repositoryFile = join(repository, ".gitattributes");
      const nestedFile = join(nestedDirectory, ".gitattributes");
      await writeFile(repositoryFile, "*.md text\n", "utf8");
      await writeFile(nestedFile, "*.txt text\n", "utf8");

      await expect(resolveGitattributesFile({ cwd: nestedDirectory })).resolves.toBe(
        await realpath(nestedFile)
      );

      await rm(nestedFile);
      await expect(resolveGitattributesFile({ cwd: nestedDirectory })).resolves.toBe(
        await realpath(repositoryFile)
      );
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("does not follow symlink .gitattributes files", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const nestedDirectory = join(repository, "nested");

    try {
      await mkdir(nestedDirectory);
      await execFileAsync("git", ["init", "--quiet", repository]);

      const repositoryFile = join(repository, ".gitattributes");
      const targetFile = join(nestedDirectory, "attributes-target");
      const symlinkFile = join(nestedDirectory, ".gitattributes");
      await writeFile(repositoryFile, "*.md text\n", "utf8");
      await writeFile(targetFile, "*.txt text\n", "utf8");
      await symlink(targetFile, symlinkFile);

      await expect(resolveGitattributesFile({ cwd: nestedDirectory })).resolves.toBe(
        join(await realpath(nestedDirectory), ".gitattributes")
      );
      await expect(lint({ cwd: nestedDirectory })).rejects.toBeInstanceOf(
        GitattributesSymlinkError
      );
      await expect(
        lint({ cwd: nestedDirectory, path: symlinkFile })
      ).rejects.toBeInstanceOf(GitattributesSymlinkError);
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });

  it("rejects an oversized .gitattributes file before reading it fully", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));

    try {
      const filePath = join(directory, ".gitattributes");
      await writeFile(
        filePath,
        "x".repeat(RESOURCE_LIMITS.maxGitattributesBytes + 1),
        "utf8"
      );

      await expect(
        lint({ cwd: directory, path: filePath })
      ).rejects.toBeInstanceOf(GitattributesResourceLimitError);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
