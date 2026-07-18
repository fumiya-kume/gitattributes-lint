import { describe, expect, it } from "vitest";
import {
  compileGitattributesPattern,
  GitattributesPatternResourceLimitError,
  matchesGitattributesPattern,
} from "../src/patterns.js";
import { AnalysisBudget } from "../src/resource-budget.js";

describe(".gitattributes pattern matching", () => {
  it("matches basenames for patterns without slashes", () => {
    expect(matchesGitattributesPattern("*.txt", "docs/readme.txt")).toBe(true);
    expect(matchesGitattributesPattern("*.txt", "docs/readme.md")).toBe(false);
    expect(matchesGitattributesPattern("a?c", "nested/abc")).toBe(true);
    expect(matchesGitattributesPattern("a?c", "nested/a/c")).toBe(false);
  });

  it("keeps segment wildcards from crossing path separators", () => {
    expect(matchesGitattributesPattern("a/*/c", "a/b/c")).toBe(true);
    expect(matchesGitattributesPattern("a/*/c", "a/b/d/c")).toBe(false);
    expect(matchesGitattributesPattern("a/?/c", "a/b/c")).toBe(true);
    expect(matchesGitattributesPattern("a/?/c", "a/bb/c")).toBe(false);
  });

  it("only treats slash-delimited double stars as recursive", () => {
    expect(matchesGitattributesPattern("a/**/b.txt", "a/b.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/**/b.txt", "a/nested/b.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/foo**bar", "a/foo/nested/bar")).toBe(false);
  });

  it("supports zero or more directory levels for recursive directory stars", () => {
    expect(matchesGitattributesPattern("**/README.md", "README.md")).toBe(true);
    expect(matchesGitattributesPattern("**/README.md", "docs/README.md")).toBe(true);
    expect(matchesGitattributesPattern("**/README.md", "docs/api/README.md")).toBe(true);
    expect(matchesGitattributesPattern("a/**", "a")).toBe(false);
    expect(matchesGitattributesPattern("a/**", "a/file.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/**/**/b.txt", "a/b.txt")).toBe(true);
  });

  it("anchors a leading slash to the attribute file directory", () => {
    expect(matchesGitattributesPattern("/foo.txt", "foo.txt")).toBe(true);
    expect(matchesGitattributesPattern("/foo.txt", "nested/foo.txt")).toBe(false);
  });

  it("supports standalone and composite POSIX character classes", () => {
    expect(matchesGitattributesPattern("[[:digit:]].txt", "1.txt")).toBe(true);
    expect(matchesGitattributesPattern("[[:digit:]].txt", "a.txt")).toBe(false);
    expect(matchesGitattributesPattern("[[:alpha:]_]", "a")).toBe(true);
    expect(matchesGitattributesPattern("[[:alpha:]_]", "_")).toBe(true);
    expect(matchesGitattributesPattern("[[:alpha:]_]", "5")).toBe(false);
    expect(matchesGitattributesPattern("[![:digit:]_]", "a")).toBe(true);
    expect(matchesGitattributesPattern("[![:digit:]_]", "_")).toBe(false);
    expect(matchesGitattributesPattern("[[:digit:]a-f]", "5")).toBe(true);
    expect(matchesGitattributesPattern("[[:digit:]a-f]", "g")).toBe(false);
  });

  it.each([
    ["alnum", "7", true],
    ["blank", "\t", true],
    ["lower", "z", true],
    ["space", "\n", true],
    ["upper", "Z", true],
    ["xdigit", "F", true],
    ["xdigit", "g", false],
  ] as const)("supports POSIX class %s with %s", (name, character, expected) => {
    expect(matchesGitattributesPattern(`[[:${name}:]]`, character)).toBe(expected);
  });

  it("supports caret-negated character classes", () => {
    expect(matchesGitattributesPattern("[^0-9]", "a")).toBe(true);
    expect(matchesGitattributesPattern("[^0-9]", "5")).toBe(false);
  });

  it("supports the complete Git POSIX class catalog", () => {
    expect(matchesGitattributesPattern("[[:cntrl:]]", "\n")).toBe(true);
    expect(matchesGitattributesPattern("[[:graph:]]", "a")).toBe(true);
    expect(matchesGitattributesPattern("[[:graph:]]", " ")).toBe(false);
    expect(matchesGitattributesPattern("[[:print:]]", " ")).toBe(true);
    expect(matchesGitattributesPattern("[[:punct:]]", "!")).toBe(true);
    expect(matchesGitattributesPattern("[[:punct:]]", "a")).toBe(false);
  });

  it("supports a literal closing bracket at the start of a class", () => {
    expect(matchesGitattributesPattern("[]a]", "a")).toBe(true);
    expect(matchesGitattributesPattern("[]a]", "]")).toBe(true);
    expect(matchesGitattributesPattern("[]a]", "b")).toBe(false);
  });

  it("supports escaped glob metacharacters as literals", () => {
    expect(matchesGitattributesPattern(String.raw`\*.txt`, "*.txt")).toBe(true);
    expect(matchesGitattributesPattern(String.raw`\?.txt`, "?.txt")).toBe(true);
    expect(matchesGitattributesPattern(String.raw`\[name\]`, "[name]")).toBe(true);
    expect(matchesGitattributesPattern(String.raw`a\\b`, "a\\b")).toBe(true);
    expect(matchesGitattributesPattern(String.raw`[\]]`, "]")).toBe(true);
  });

  it("preserves a literal leading ./ in a pattern", () => {
    expect(matchesGitattributesPattern("./foo.txt", "foo.txt")).toBe(false);
    expect(matchesGitattributesPattern("./foo.txt", "./foo.txt")).toBe(true);
  });

  it("supports Git's case-insensitive repository setting", () => {
    expect(matchesGitattributesPattern("*.TXT", "file.txt")).toBe(false);
    expect(
      matchesGitattributesPattern("*.TXT", "file.txt", { caseInsensitive: true })
    ).toBe(true);
    expect(matchesGitattributesPattern("s", "ſ", { caseInsensitive: true })).toBe(false);
    expect(matchesGitattributesPattern("k", "K", { caseInsensitive: true })).toBe(false);
    expect(matchesGitattributesPattern("ä", "Ä", { caseInsensitive: true })).toBe(false);
  });

  it("does not treat malformed glob escapes as literal matches", () => {
    expect(matchesGitattributesPattern("[", "[")).toBe(false);
    expect(matchesGitattributesPattern("foo\\", "foo\\")).toBe(false);
    expect(matchesGitattributesPattern("[z-a]", "z")).toBe(true);
    expect(matchesGitattributesPattern("[z-a]", "a")).toBe(false);
    expect(matchesGitattributesPattern("[[:unknown:]]", "a")).toBe(false);
  });

  it("returns false for empty and trailing-slash patterns", () => {
    expect(matchesGitattributesPattern("", "anything")).toBe(false);
    expect(matchesGitattributesPattern("directory/", "directory/file.txt")).toBe(false);
    expect(compileGitattributesPattern("")("anything")).toBe(false);
  });

  it("preserves backslashes in Git pathnames", () => {
    expect(matchesGitattributesPattern("a/b.txt", "a\\b.txt")).toBe(false);
    expect(matchesGitattributesPattern("a\\\\b.txt", "a\\b.txt")).toBe(true);
  });

  it("allows recursive stars to span line terminators in pathnames", () => {
    expect(matchesGitattributesPattern("a/**/b.txt", "a/x\n/y/b.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/**", "a/x\r/y.txt")).toBe(true);
  });

  it("matches Unicode code points without splitting surrogate pairs", () => {
    expect(matchesGitattributesPattern("😀.txt", "😀.txt")).toBe(true);
    expect(matchesGitattributesPattern("?.txt", "😀.txt")).toBe(true);
    expect(matchesGitattributesPattern("?.txt", "ab.txt")).toBe(false);
  });

  it("reuses a compiled matcher with its options", () => {
    const matcher = compileGitattributesPattern("*.TXT", {
      caseInsensitive: true,
    });

    expect(matcher("README.txt")).toBe(true);
    expect(matcher("README.md")).toBe(false);
  });

  it("propagates the shared pattern operation budget", () => {
    const budget = new AnalysisBudget({ maxPatternOperations: 1 });
    const matcher = compileGitattributesPattern("**/*.txt", { budget });

    expect(() => matcher("docs/readme.txt")).toThrowError(
      expect.objectContaining({
        kind: "pattern-operations",
        name: "AnalysisResourceLimitError",
      })
    );
  });

  it("enforces the standalone matcher operation limit", () => {
    expect(() =>
      matchesGitattributesPattern(
        `${"*".repeat(256)}Z`,
        `${"a".repeat(20_000)}Y`
      )
    ).toThrowError(
      expect.objectContaining({
        name: "GitattributesPatternResourceLimitError",
      })
    );
  });

  it("exposes a dedicated error for standalone matcher limits", () => {
    const error = new GitattributesPatternResourceLimitError("limit");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GitattributesPatternResourceLimitError");
    expect(error.message).toBe("limit");
  });
});
