import { describe, expect, it } from "vitest";
import {
  GitResourceLimitError,
  parseNullDelimitedChunks,
} from "../src/git-attributes.js";
import { AnalysisBudget } from "../src/resource-budget.js";

async function* oneByteChunks(value: string): AsyncGenerator<Buffer> {
  for (const byte of Buffer.from(value, "utf8")) {
    yield Buffer.from([byte]);
  }
}

async function* mixedChunks(): AsyncGenerator<Buffer | string> {
  yield Buffer.from("日本", "utf8");
  yield "語.txt\0second";
  yield Buffer.from("\0", "utf8");
}

describe("NUL-delimited Git output parser", () => {
  it("restores fields when every input chunk is one byte", async () => {
    const values: string[] = [];
    for await (const value of parseNullDelimitedChunks(
      oneByteChunks("README.md\0src/index.ts\0日本語.txt\0")
    )) {
      values.push(value);
    }

    expect(values).toEqual(["README.md", "src/index.ts", "日本語.txt"]);
  });

  it("rejects an unterminated field as a Git resource error", async () => {
    const consume = async (): Promise<void> => {
      for await (const _value of parseNullDelimitedChunks(oneByteChunks("README.md"))) {
        void _value;
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(GitResourceLimitError);
  });

  it("handles mixed string and Buffer chunks and empty fields", async () => {
    const values: string[] = [];
    for await (const value of parseNullDelimitedChunks(mixedChunks())) {
      values.push(value);
    }

    expect(values).toEqual(["日本語.txt", "second"]);

    const emptyValues: string[] = [];
    async function* emptyFields(): AsyncGenerator<string> {
      yield "\0a\0\0";
    }
    for await (const value of parseNullDelimitedChunks(emptyFields())) {
      emptyValues.push(value);
    }

    expect(emptyValues).toEqual(["", "a", ""]);
  });

  it("enforces field and aggregate stream limits", async () => {
    const consumeField = async (): Promise<void> => {
      for await (const _value of parseNullDelimitedChunks(oneByteChunks("1234\0"), 3)) {
        void _value;
      }
    };
    await expect(consumeField()).rejects.toBeInstanceOf(GitResourceLimitError);

    const consumePending = async (): Promise<void> => {
      for await (const _value of parseNullDelimitedChunks(oneByteChunks("1234"), 3)) {
        void _value;
      }
    };
    await expect(consumePending()).rejects.toBeInstanceOf(GitResourceLimitError);

    const budget = new AnalysisBudget({ maxGitStreamBytes: 3 });
    const consumeAggregate = async (): Promise<void> => {
      for await (const _value of parseNullDelimitedChunks(oneByteChunks("a\0b\0"), 10, budget)) {
        void _value;
      }
    };
    await expect(consumeAggregate()).rejects.toMatchObject({
      kind: "git-stream-bytes",
      name: "AnalysisResourceLimitError",
    });
  });
});
