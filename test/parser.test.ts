import { describe, expect, it } from "vitest";
import { analyzeGitattributes } from "../src/attributes.js";

describe(".gitattributes parser", () => {
  it("accepts empty lines", () => {
    const analysis = analyzeGitattributes("\n   \n\t\n*.txt text\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules).toHaveLength(1);
  });

  it("ignores comments after leading whitespace", () => {
    const analysis = analyzeGitattributes("# comment\n  # another comment\n*.txt text\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules).toHaveLength(1);
  });

  it("supports tabs and multiple spaces as separators", () => {
    const analysis = analyzeGitattributes("*.txt\ttext   eol=lf    -diff\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]?.pattern).toBe("*.txt");
    expect(analysis.rules[0]?.attributes.map(({ name }) => name)).toEqual([
      "text",
      "eol",
      "diff",
    ]);
  });

  it("parses C-style quoted patterns", () => {
    const analysis = analyzeGitattributes('"path with spaces/*.txt" text\n');

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]?.pattern).toBe("path with spaces/*.txt");
  });

  it("decodes UTF-8 bytes in C-style octal escapes", () => {
    const analysis = analyzeGitattributes("\"\\303\\251.txt\" text\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]?.pattern).toBe("é.txt");
  });

  it.each([
    [String.raw`"\a" text`, "\u0007"],
    [String.raw`"\b" text`, "\b"],
    [String.raw`"\f" text`, "\f"],
    [String.raw`"\n" text`, "\n"],
    [String.raw`"\r" text`, "\r"],
    [String.raw`"\t" text`, "\t"],
    [String.raw`"\v" text`, "\v"],
    [String.raw`"\"" text`, '"'],
    [String.raw`"\\" text`, "\\"],
  ] as const)("decodes C-style escape %s", (source, expectedPattern) => {
    const analysis = analyzeGitattributes(`${source}\n`);

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]?.pattern).toBe(expectedPattern);
  });

  it("keeps escaped hash and exclamation patterns literal", () => {
    const analysis = analyzeGitattributes("\\#literal.txt text\n\\!literal.txt text\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules.map(({ pattern }) => pattern)).toEqual([
      "\\#literal.txt",
      "\\!literal.txt",
    ]);
    expect(analysis.errors).toEqual([]);
  });

  it("parses set, unset, unspecified, and value states", () => {
    const analysis = analyzeGitattributes(
      "*.txt text -diff !merge custom=value\n"
    );

    expect(analysis.valid).toBe(true);
    expect(analysis.attributes.map(({ name, state, value }) => ({ name, state, value }))).toEqual([
      { name: "text", state: "set", value: undefined },
      { name: "diff", state: "unset", value: undefined },
      { name: "merge", state: "unspecified", value: undefined },
      { name: "custom", state: "value", value: "value" },
    ]);
  });

  it("recognizes custom attribute macros", () => {
    const analysis = analyzeGitattributes("[attr]docs text -diff\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]).toMatchObject({
      isMacroDefinition: true,
      pattern: "[attr]docs",
    });
  });

  it("accepts CRLF line endings", () => {
    const analysis = analyzeGitattributes("*.txt text\r\n*.md -text\r\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules).toHaveLength(2);
    expect(analysis.rules[1]?.attributes[0]).toMatchObject({
      name: "text",
      state: "unset",
    });
  });

  it("treats carriage returns inside a line as separators", () => {
    const analysis = analyzeGitattributes("foo\rtext");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]?.pattern).toBe("foo");
    expect(analysis.rules[0]?.attributes[0]?.name).toBe("text");
  });

  it("removes a UTF-8 BOM from the first line", () => {
    const analysis = analyzeGitattributes("\uFEFF*.txt text\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules[0]?.pattern).toBe("*.txt");
  });

  it("reports unterminated and invalid C-style quotes", () => {
    const analysis = analyzeGitattributes(
      '"unterminated text\n"bad\\q" text\n"closed"x text\n'
    );

    expect(analysis.errors.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "invalid-quoted-token", line: 1 },
      { code: "invalid-quoted-token", line: 2 },
      { code: "invalid-quoted-token", line: 3 },
    ]);
  });

  it("rejects malformed octal and trailing escape sequences", () => {
    const trailingEscape = "\"trailing\\";
    const analysis = analyzeGitattributes(
      `${String.raw`"\378" text`}\n${String.raw`"\400" text`}\n${trailingEscape}\n`
    );

    expect(analysis.errors.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "invalid-quoted-token", line: 1 },
      { code: "invalid-quoted-token", line: 2 },
      { code: "invalid-quoted-token", line: 3 },
    ]);
  });

  it("validates macro names independently from macro attributes", () => {
    const analysis = analyzeGitattributes(
      [
        "[attr] text",
        "[attr]bad/name text",
        "[attr]builtin_objectmode text",
      ].join("\n")
    );

    expect(analysis.errors.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "invalid-attribute", line: 1 },
      { code: "invalid-attribute", line: 2 },
      { code: "invalid-attribute", line: 3 },
    ]);
  });

  it("reports invalid attribute names", () => {
    const analysis = analyzeGitattributes("*.txt foo/bar\n*.md --text\n");

    expect(analysis.errors.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "invalid-attribute", line: 1 },
      { code: "invalid-attribute", line: 2 },
    ]);
  });

  it("parses a final rule without a newline", () => {
    const analysis = analyzeGitattributes("*.txt text");

    expect(analysis.valid).toBe(true);
    expect(analysis.rules).toHaveLength(1);
    expect(analysis.rules[0]?.attributes[0]?.name).toBe("text");
  });
});
