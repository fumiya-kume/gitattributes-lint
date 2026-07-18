import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { scanGitAttributes } from "../src/git-attributes.js";

const execFileAsync = promisify(execFile);

describe("Git filename command injection boundary", () => {
  it("preserves shell-looking filenames through argv and NUL input", async () => {
    const repository = await mkdtemp(join(tmpdir(), "gitattributes-lint-"));
    const keepFile = join(repository, "x", "keep.txt");
    const filenames = [
      "--help",
      "$(echo hacked)",
      "a;rm -rf x",
      "file with spaces.txt",
      "file\nwith\nnewline.txt",
    ];

    try {
      await execFileAsync("git", ["init", "--quiet", repository]);
      await mkdir(join(repository, "x"));
      await writeFile(join(repository, ".gitattributes"), "* text\n", "utf8");
      await writeFile(keepFile, "keep\n", "utf8");
      for (const filename of filenames) {
        await writeFile(join(repository, filename), "content\n", "utf8");
      }
      await execFileAsync("git", ["-C", repository, "add", "--", "."]);

      const observedPaths: string[] = [];
      const result = await scanGitAttributes(repository, [], {
        onPath: (path) => {
          observedPaths.push(path);
        },
      });

      expect(result.checkedPathCount).toBeGreaterThanOrEqual(filenames.length);
      expect(observedPaths).toEqual(expect.arrayContaining(filenames));
      await expect(access(keepFile)).resolves.toBeUndefined();
    } finally {
      await rm(repository, { recursive: true, force: true });
    }
  });
});
