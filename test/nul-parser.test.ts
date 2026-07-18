import { describe, expect, it } from "vitest";
import {
  GitResourceLimitError,
  parseNullDelimitedChunks,
} from "../src/git-attributes.js";

async function* oneByteChunks(value: string): AsyncGenerator<Buffer> {
  for (const byte of Buffer.from(value, "utf8")) {
    yield Buffer.from([byte]);
  }
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
});
