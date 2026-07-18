import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeGitattributes } from "../src/attributes.js";
import { parseNullDelimitedChunks, scanGitAttributes } from "../src/git-attributes.js";
import { RESOURCE_LIMITS } from "../src/limits.js";
import { matchesGitattributesPattern } from "../src/patterns.js";
import { AnalysisBudget } from "../src/resource-budget.js";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function* oneChunk(value: string): AsyncGenerator<string> {
  yield value;
}

async function consumeFields(
  stream: AsyncIterable<Buffer | string>,
  budget: AnalysisBudget
): Promise<void> {
  for await (const _value of parseNullDelimitedChunks(stream, 1024, budget)) {
    // Exhaust the parser so stream accounting and errors are observed.
    void _value;
  }
}

describe("security resource boundaries", () => {
  it("rejects a near-limit parser input before retaining 100,000 attributes", () => {
    const source = Array.from(
      { length: RESOURCE_LIMITS.maxGitattributesRules },
      (_, index) => `file-${String(index)} aa bb cc dd`
    ).join("\n");

    const analysis = analyzeGitattributes(source);

    expect(analysis.valid).toBe(false);
    expect(analysis.issues).toEqual([
      expect.objectContaining({
        code: "resource-limit",
        severity: "error",
      }),
    ]);
    expect(analysis.rules.length).toBeLessThan(RESOURCE_LIMITS.maxGitattributesRules);
    expect(analysis.attributes.length).toBeLessThan(100_000);
  });

  it("bounds consecutive wildcard matching with the shared operation budget", () => {
    const budget = new AnalysisBudget({ maxPatternOperations: 1_000 });
    const startedAt = Date.now();

    expect(() =>
      matchesGitattributesPattern(
        `${"*".repeat(32)}Z`,
        `${"a".repeat(128)}Y`,
        { budget }
      )
    ).toThrowError(expect.objectContaining({
      kind: "pattern-operations",
      name: "AnalysisResourceLimitError",
    }));

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("rejects aggregate Git stream input even when individual fields are small", async () => {
    const budget = new AnalysisBudget({
      maxGitStreamBytes: 10,
    });

    await expect(consumeFields(oneChunk("a\0b\0c\0d\0e\0f\0"), budget)).rejects.toMatchObject({
      kind: "git-stream-bytes",
      name: "AnalysisResourceLimitError",
    });
  });

  it("terminates quiet sibling Git processes when the request deadline expires", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gitattributes-lint-fifo-git-"));
    const index = join(directory, ".git", "index");

    try {
      const startedAt = Date.now();
      await execFileAsync("git", ["init", "--quiet", directory]);
      await execFileAsync("mkfifo", [index]);
      await expect(
        scanGitAttributes(
          directory,
          [],
          {},
          new AnalysisBudget({ maxElapsedMs: 100 })
        )
      ).rejects.toMatchObject({ name: "GitResourceLimitError" });
      expect(Date.now() - startedAt).toBeLessThan(4_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
