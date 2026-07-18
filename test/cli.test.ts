import { describe, expect, it } from "vitest";
import { createProgram, isMainModule } from "../src/cli.js";
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
