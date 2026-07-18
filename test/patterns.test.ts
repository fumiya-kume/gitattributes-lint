import { describe, expect, it } from "vitest";
import { matchesGitattributesPattern } from "../src/patterns.js";

describe(".gitattributes pattern matching", () => {
  it("only treats slash-delimited double stars as recursive", () => {
    expect(matchesGitattributesPattern("a/**/b.txt", "a/b.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/**/b.txt", "a/nested/b.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/foo**bar", "a/foo/nested/bar")).toBe(false);
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
  });

  it("preserves backslashes in Git pathnames", () => {
    expect(matchesGitattributesPattern("a/b.txt", "a\\b.txt")).toBe(false);
    expect(matchesGitattributesPattern("a\\\\b.txt", "a\\b.txt")).toBe(true);
  });

  it("allows recursive stars to span line terminators in pathnames", () => {
    expect(matchesGitattributesPattern("a/**/b.txt", "a/x\n/y/b.txt")).toBe(true);
    expect(matchesGitattributesPattern("a/**", "a/x\r/y.txt")).toBe(true);
  });
});
