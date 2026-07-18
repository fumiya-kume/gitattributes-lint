import { performance } from "node:perf_hooks";
import { RESOURCE_LIMITS } from "./limits.js";

export type ResourceBudgetKind =
  | "analysis-time"
  | "git-stream-bytes"
  | "parser-retained-bytes"
  | "pattern-operations";

export class ResourceBudgetExceededError extends Error {
  public readonly kind: ResourceBudgetKind;

  public constructor(kind: ResourceBudgetKind, message: string) {
    super(message);
    this.name = "AnalysisResourceLimitError";
    this.kind = kind;
  }
}

export interface AnalysisBudgetOptions {
  readonly now?: () => number;
  readonly maxElapsedMs?: number;
  readonly maxGitStreamBytes?: number;
  readonly maxParserRetainedBytes?: number;
  readonly maxPatternOperations?: number;
}

export class AnalysisBudget {
  private readonly now: () => number;
  private readonly maxElapsedMs: number;
  private readonly deadline: number;
  private readonly maxGitStreamBytes: number;
  private readonly maxParserRetainedBytes: number;
  private readonly maxPatternOperations: number;
  private gitStreamBytes = 0;
  private parserRetainedBytes = 0;
  private patternOperations = 0;

  public constructor(options: AnalysisBudgetOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.maxElapsedMs = options.maxElapsedMs ?? RESOURCE_LIMITS.maxAnalysisDurationMs;
    this.deadline = this.now() + this.maxElapsedMs;
    this.maxGitStreamBytes =
      options.maxGitStreamBytes ?? RESOURCE_LIMITS.maxGitStreamBytes;
    this.maxParserRetainedBytes =
      options.maxParserRetainedBytes ?? RESOURCE_LIMITS.maxGitattributesRetainedBytes;
    this.maxPatternOperations =
      options.maxPatternOperations ?? RESOURCE_LIMITS.maxPatternMatchOperations;
  }

  public remainingMs(): number {
    return Math.max(0, this.deadline - this.now());
  }

  public checkElapsed(): void {
    if (this.now() >= this.deadline) {
      throw new ResourceBudgetExceededError(
        "analysis-time",
        `Analysis exceeded the ${String(this.maxElapsedMs)}-millisecond time limit.`
      );
    }
  }

  public consumeGitStreamBytes(byteCount: number): void {
    this.checkElapsed();
    this.gitStreamBytes += byteCount;
    if (this.gitStreamBytes > this.maxGitStreamBytes) {
      throw new ResourceBudgetExceededError(
        "git-stream-bytes",
        `Git stream processing exceeded the ${String(this.maxGitStreamBytes)}-byte aggregate limit.`
      );
    }
  }

  public reserveParserBytes(byteCount: number): void {
    this.checkElapsed();
    this.parserRetainedBytes += byteCount;
    if (this.parserRetainedBytes > this.maxParserRetainedBytes) {
      throw new ResourceBudgetExceededError(
        "parser-retained-bytes",
        `Parsed .gitattributes data exceeded the ${String(this.maxParserRetainedBytes)}-byte retained-memory budget.`
      );
    }
  }

  public consumePatternOperations(operationCount = 1): void {
    this.patternOperations += operationCount;
    if (this.patternOperations > this.maxPatternOperations) {
      throw new ResourceBudgetExceededError(
        "pattern-operations",
        `Pattern matching exceeded the ${String(this.maxPatternOperations)}-operation budget.`
      );
    }

    if ((this.patternOperations & 1023) === 0) {
      this.checkElapsed();
    }
  }
}
