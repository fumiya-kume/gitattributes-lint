import { describe, expect, it } from "vitest";
import {
  analyzeGitattributes,
  isBuiltinAttribute,
  isReservedBuiltinAttribute,
} from "../src/attributes.js";
import { AnalysisBudget } from "../src/resource-budget.js";
import { RESOURCE_LIMITS } from "../src/limits.js";

describe("gitattributes attribute analysis", () => {
  it("classifies built-in and custom attributes with their states", () => {
    const analysis = analyzeGitattributes(
      [
        "# A comment",
        "*.txt text eol=lf -diff custom=value !later",
        "*.bin binary",
      ].join("\n")
    );

    expect(analysis.valid).toBe(true);
    expect(analysis.hasBuiltinAttributes).toBe(true);
    expect(analysis.builtinAttributes.map(({ name, state, value }) => ({ name, state, value }))).toEqual([
      { name: "text", state: "set", value: undefined },
      { name: "eol", state: "value", value: "lf" },
      { name: "diff", state: "unset", value: undefined },
      { name: "binary", state: "set", value: undefined },
    ]);
    expect(analysis.customAttributes.map(({ name, state, value }) => ({ name, state, value }))).toEqual([
      { name: "custom", state: "value", value: "value" },
      { name: "later", state: "unspecified", value: undefined },
    ]);
  });

  it("recognizes reserved built-in attributes and rejects assigning them", () => {
    const analysis = analyzeGitattributes("* builtin_objectmode=100644\n");

    expect(analysis.valid).toBe(false);
    expect(analysis.reservedAttributes.map(({ name }) => name)).toEqual([
      "builtin_objectmode",
    ]);
    expect(analysis.issues).toEqual([
      expect.objectContaining({
        code: "reserved-builtin-attribute",
        line: 1,
      }),
    ]);
  });

  it("warns only for a unique close typo in the built-in catalog", () => {
    const analysis = analyzeGitattributes("*.txt texxt\n");

    expect(analysis.warnings).toEqual([
      expect.objectContaining({
        code: "possible-attribute-typo",
        message: expect.stringContaining('"text"'),
        severity: "warning",
      }),
    ]);
  });

  it("does not warn for distant, ambiguous, or explicitly allowed custom attributes", () => {
    const distant = analyzeGitattributes("*.txt project-specific\n");
    const ambiguous = analyzeGitattributes("*.txt et\n");
    const allowed = analyzeGitattributes("*.txt texxt\n", {
      allowedAttributes: ["texxt"],
    });

    expect(distant.warnings).toEqual([]);
    expect(ambiguous.warnings).toEqual([]);
    expect(allowed.warnings).toEqual([]);
  });

  it("supports quoted patterns and identifies Git built-in names", () => {
    const analysis = analyzeGitattributes('"path with spaces/*.txt" text\n');

    expect(analysis.valid).toBe(true);
    expect(analysis.builtinAttributes[0]).toMatchObject({
      name: "text",
      pattern: "path with spaces/*.txt",
    });
    expect(isBuiltinAttribute("text")).toBe(true);
    expect(isBuiltinAttribute("custom")).toBe(false);
    expect(isReservedBuiltinAttribute("builtin_objectmode")).toBe(true);
    expect(isBuiltinAttribute("builtin_objectmode")).toBe(false);
  });

  it.each([
    ["*.txt eol", ["attribute-without-value"]],
    ["*.txt -eol", ["attribute-without-value"]],
    ["*.txt !eol", []],
    ["*.txt eol=lf", []],
    ["*.txt eol=crlf", []],
    ["*.txt eol=windows", ["invalid-eol-value"]],
    ["*.txt text=auto", []],
    ["*.txt text=manual", ["invalid-text-value"]],
    ["*.txt text working-tree-encoding=UTF-8", []],
    ["*.txt working-tree-encoding=UTF-8", ["attribute-without-value"]],
    [
      "*.txt working-tree-encoding=",
      ["invalid-working-tree-encoding", "attribute-without-value"],
    ],
    [
      "*.txt working-tree-encoding",
      ["invalid-working-tree-encoding", "attribute-without-value"],
    ],
    [
      "*.txt -working-tree-encoding",
      ["invalid-working-tree-encoding", "attribute-without-value"],
    ],
    ["*.txt !working-tree-encoding", []],
    ["*.txt conflict-marker-size=1", []],
    ["*.txt conflict-marker-size=999", []],
    ["*.txt conflict-marker-size=0", ["invalid-conflict-marker-size"]],
    ["*.txt conflict-marker-size=-1", ["invalid-conflict-marker-size"]],
    ["*.txt conflict-marker-size=1.5", ["invalid-conflict-marker-size"]],
    ["*.txt conflict-marker-size", ["invalid-conflict-marker-size"]],
    ["*.txt !conflict-marker-size", []],
  ] as const)("enforces policy for %s", (source, expectedCodes) => {
    const analysis = analyzeGitattributes(source);

    expect(analysis.issues.map(({ code }) => code)).toEqual(expectedCodes);
  });

  it("accepts eol without an explicit text attribute", () => {
    const analysis = analyzeGitattributes("*.txt eol=lf\n");

    expect(analysis.valid).toBe(true);
    expect(analysis.warnings).toEqual([]);
  });

  it("reports syntax and policy issues with line and column information", () => {
    const analysis = analyzeGitattributes(
      [
        "*.txt",
        "*.md eol=windows",
        "*.bin binary text",
        "!ignored text",
        '"unterminated text',
      ].join("\n")
    );

    expect(analysis.valid).toBe(false);
    expect(analysis.errors.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "missing-attribute", line: 1 },
      { code: "invalid-eol-value", line: 2 },
      { code: "negative-pattern", line: 4 },
      { code: "invalid-quoted-token", line: 5 },
    ]);
    expect(analysis.warnings.map(({ code, line }) => ({ code, line }))).toEqual([
      { code: "conflicting-attributes", line: 3 },
    ]);
    expect(analysis.errors[0]).toMatchObject({ column: 1 });
  });

  it("caps diagnostic collection and marks truncated output as an error", () => {
    const source = Array.from(
      { length: RESOURCE_LIMITS.maxDiagnostics + 10 },
      () => "*.txt"
    ).join("\n");

    const analysis = analyzeGitattributes(source);

    expect(analysis.issues).toHaveLength(RESOURCE_LIMITS.maxDiagnostics);
    expect(analysis.issues.at(-1)).toMatchObject({
      code: "resource-limit",
      severity: "error",
    });
    expect(analysis.valid).toBe(false);
  });

  it("rejects oversized attribute values", () => {
    const analysis = analyzeGitattributes(
      `*.txt custom=${"x".repeat(RESOURCE_LIMITS.maxAttributeValueLength + 1)}`
    );

    expect(analysis.issues).toEqual([
      expect.objectContaining({
        code: "resource-limit",
        severity: "error",
      }),
    ]);
  });

  it("accepts an attribute value exactly at its limit", () => {
    const analysis = analyzeGitattributes(
      `*.txt custom=${"x".repeat(RESOURCE_LIMITS.maxAttributeValueLength)}`
    );

    expect(analysis.valid).toBe(true);
    expect(analysis.issues).toEqual([]);
  });

  it("rejects input, line, token, and allow-list limits at the boundary", () => {
    const oversizedInput = analyzeGitattributes(
      "x".repeat(RESOURCE_LIMITS.maxGitattributesBytes + 1)
    );
    expect(oversizedInput.issues).toEqual([
      expect.objectContaining({ code: "resource-limit" }),
    ]);

    const oversizedLine = analyzeGitattributes(
      "x".repeat(RESOURCE_LIMITS.maxLineLength + 1)
    );
    expect(oversizedLine.issues).toEqual([
      expect.objectContaining({ code: "resource-limit" }),
    ]);

    const exactTokens = [
      "*.txt",
      ...Array.from(
        { length: RESOURCE_LIMITS.maxTokensPerLine - 1 },
        (_, index) => `custom-${String(index)}`
      ),
    ].join(" ");
    expect(analyzeGitattributes(exactTokens).issues).toEqual([]);

    const oversizedTokens = `${exactTokens} extra`;
    expect(analyzeGitattributes(oversizedTokens).issues).toEqual([
      expect.objectContaining({ code: "resource-limit" }),
    ]);

    const allowed = analyzeGitattributes("*.txt vendor-flag", {
      allowedAttributes: Array.from(
        { length: RESOURCE_LIMITS.maxAllowedAttributes + 1 },
        (_, index) => `allowed-${String(index)}`
      ),
    });
    expect(allowed.issues).toEqual([
      expect.objectContaining({ code: "resource-limit" }),
    ]);
  });

  it("stops at the configured retained parser budget", () => {
    const analysis = analyzeGitattributes("*.txt custom=value\n", {
      budget: new AnalysisBudget({ maxParserRetainedBytes: 1 }),
    });

    expect(analysis.valid).toBe(false);
    expect(analysis.issues).toEqual([
      expect.objectContaining({ code: "resource-limit" }),
    ]);
    expect(analysis.rules).toEqual([]);
  });

  it("accepts files exactly at the line and rule limits", () => {
    const lineLimitedSource =
      Array.from(
        { length: RESOURCE_LIMITS.maxGitattributesLines },
        () => "# comment"
      ).join("\n") + "\n";
    const lineLimited = analyzeGitattributes(lineLimitedSource);
    expect(lineLimited.valid).toBe(true);
    expect(lineLimited.issues).toEqual([]);

    const ruleLimitedSource = Array.from(
      { length: RESOURCE_LIMITS.maxGitattributesRules },
      (_, index) => "file-" + String(index) + " text"
    ).join("\n");
    const ruleLimited = analyzeGitattributes(ruleLimitedSource);
    expect(ruleLimited.valid).toBe(true);
    expect(ruleLimited.rules).toHaveLength(RESOURCE_LIMITS.maxGitattributesRules);
    expect(ruleLimited.issues).toEqual([]);
  });
});
