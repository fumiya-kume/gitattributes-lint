import { describe, expect, it } from "vitest";
import {
  AnalysisBudget,
  ResourceBudgetExceededError,
} from "../src/resource-budget.js";

describe("shared analysis resource budget", () => {
  it("allows work before the deadline and rejects work at the deadline", () => {
    let now = 100;
    const budget = new AnalysisBudget({
      maxElapsedMs: 10,
      now: () => now,
    });

    expect(budget.remainingMs()).toBe(10);
    budget.checkElapsed();

    now = 109;
    expect(budget.remainingMs()).toBe(1);
    budget.checkElapsed();

    now = 110;
    expect(budget.remainingMs()).toBe(0);
    expect(() => budget.checkElapsed()).toThrowError(
      expect.objectContaining({
        kind: "analysis-time",
        name: "AnalysisResourceLimitError",
      })
    );
  });

  it("clamps remaining time to zero after the deadline", () => {
    let now = 0;
    const budget = new AnalysisBudget({
      maxElapsedMs: 5,
      now: () => now,
    });

    now = 100;
    expect(budget.remainingMs()).toBe(0);
  });

  it.each([
    ["git stream bytes", "git-stream-bytes"],
    ["parser retained bytes", "parser-retained-bytes"],
    ["pattern operations", "pattern-operations"],
  ] as const)("enforces the exact %s boundary", (_label, kind) => {
    const budget = new AnalysisBudget({
      maxGitStreamBytes: 2,
      maxParserRetainedBytes: 2,
      maxPatternOperations: 2,
    });

    if (kind === "git-stream-bytes") {
      budget.consumeGitStreamBytes(2);
      expect(() => budget.consumeGitStreamBytes(1)).toThrowError(
        expect.objectContaining({ kind })
      );
    } else if (kind === "parser-retained-bytes") {
      budget.reserveParserBytes(2);
      expect(() => budget.reserveParserBytes(1)).toThrowError(
        expect.objectContaining({ kind })
      );
    } else {
      budget.consumePatternOperations(2);
      expect(() => budget.consumePatternOperations(1)).toThrowError(
        expect.objectContaining({ kind })
      );
    }
  });

  it("checks elapsed time periodically while consuming pattern operations", () => {
    let now = 0;
    const budget = new AnalysisBudget({
      maxElapsedMs: 10,
      maxPatternOperations: 2_000,
      now: () => now,
    });

    for (let index = 0; index < 1_023; index += 1) {
      budget.consumePatternOperations();
    }

    now = 10;
    expect(() => budget.consumePatternOperations()).toThrowError(
      expect.objectContaining({
        kind: "analysis-time",
        name: "AnalysisResourceLimitError",
      })
    );
  });

  it("exposes the shared resource error contract", () => {
    const error = new ResourceBudgetExceededError(
      "analysis-time",
      "deadline reached"
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AnalysisResourceLimitError");
    expect(error.kind).toBe("analysis-time");
    expect(error.message).toBe("deadline reached");
  });
});
