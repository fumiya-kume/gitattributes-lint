import {
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { isAbsolute, relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { RESOURCE_LIMITS } from "./limits.js";
import {
  AnalysisBudget,
  ResourceBudgetExceededError,
} from "./resource-budget.js";

export interface GitAttributeValue {
  readonly name: string;
  readonly path: string;
  readonly value: string;
}

export interface GitAttributeScanHandlers {
  readonly onAttribute?: (attribute: GitAttributeValue) => void | Promise<void>;
  readonly onPath?: (path: string) => void | Promise<void>;
}

export interface GitAttributeScanResult {
  readonly checkedPathCount: number;
  readonly effectiveAttributeCount: number;
}

export class GitResourceLimitError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GitResourceLimitError";
  }
}

interface GitProcess {
  readonly args: readonly string[];
  readonly budget: AnalysisBudget;
  readonly child: ChildProcessWithoutNullStreams;
  inputError?: Error;
  processError?: Error;
  stderr: string;
  stderrBytes: number;
  stderrOverflowed: boolean;
  terminating: boolean;
  timedOut: boolean;
  timeoutHandle?: NodeJS.Timeout;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

function startGit(args: readonly string[], budget: AnalysisBudget): GitProcess {
  budget.checkElapsed();
  const child = spawn("git", args, {
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const gitProcess: GitProcess = {
    args,
    budget,
    child,
    stderr: "",
    stderrBytes: 0,
    stderrOverflowed: false,
    terminating: false,
    timedOut: false,
  };

  gitProcess.timeoutHandle = setTimeout(() => {
    gitProcess.timedOut = true;
    terminateGit(gitProcess);
  }, Math.max(1, budget.remainingMs()));
  gitProcess.timeoutHandle.unref();
  child.once("close", () => {
    if (gitProcess.timeoutHandle !== undefined) {
      clearTimeout(gitProcess.timeoutHandle);
      gitProcess.timeoutHandle = undefined;
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    const remainingBytes = Math.max(0, RESOURCE_LIMITS.maxGitStderrBytes - gitProcess.stderrBytes);
    if (remainingBytes > 0) {
      gitProcess.stderr += Buffer.from(chunk, "utf8").subarray(0, remainingBytes).toString("utf8");
    }
    gitProcess.stderrBytes += chunkBytes;

    if (gitProcess.stderrBytes > RESOURCE_LIMITS.maxGitStderrBytes) {
      gitProcess.stderrOverflowed = true;
      terminateGit(gitProcess);
    }
  });

  child.stdin.on("error", (error: Error) => {
    gitProcess.inputError = error;
  });
  child.on("error", (error: Error) => {
    gitProcess.processError = error;
  });

  return gitProcess;
}

function terminateGit(gitProcess: GitProcess): void {
  const child = gitProcess.child;
  if (
    gitProcess.terminating ||
    child.exitCode !== null ||
    child.signalCode !== null
  ) {
    return;
  }

  gitProcess.terminating = true;
  try {
    if (process.platform !== "win32" && child.pid !== undefined && child.pid > 0) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
  child.stdin.destroy();
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        if (process.platform !== "win32" && child.pid !== undefined && child.pid > 0) {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, RESOURCE_LIMITS.gitTerminationGraceMs);
  escalation.unref();
}

function formatGitCommand(args: readonly string[]): string {
  return args.map((argument) => JSON.stringify(argument)).join(" ");
}

const GIT_ADVISORY_STDERR_LINES = new Set([
  "warning: Negative patterns are ignored in git attributes",
  "Use '\\!' for literal leading exclamation.",
]);

function withoutKnownAdvisoryWarnings(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !GIT_ADVISORY_STDERR_LINES.has(line.trim()))
    .join("\n");
}

function waitForGit(gitProcess: GitProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (gitProcess.timeoutHandle !== undefined) {
        clearTimeout(gitProcess.timeoutHandle);
        gitProcess.timeoutHandle = undefined;
      }
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };

    const onClose = (exitCode: number | null): void => {
      if (gitProcess.timedOut) {
        finish(
          new GitResourceLimitError(
            `git ${formatGitCommand(gitProcess.args)} exceeded the ${String(RESOURCE_LIMITS.maxAnalysisDurationMs)}-millisecond time limit.`
          )
        );
        return;
      }

      try {
        gitProcess.budget.checkElapsed();
      } catch (error: unknown) {
        if (error instanceof ResourceBudgetExceededError) {
          finish(error);
          return;
        }
        throw error;
      }

      if (gitProcess.stderrOverflowed) {
        finish(
          new GitResourceLimitError(
            `git ${formatGitCommand(gitProcess.args)} exceeded the ${String(RESOURCE_LIMITS.maxGitStderrBytes)}-byte stderr limit.`
          )
        );
        return;
      }

      if (gitProcess.inputError !== undefined) {
        finish(gitProcess.inputError);
        return;
      }

      if (exitCode !== 0) {
        const details = gitProcess.stderr.trim();
        finish(
          new Error(
            `git ${formatGitCommand(gitProcess.args)} failed with exit code ${String(exitCode)}${
              details.length === 0 ? "." : `: ${details}`
            }`
          )
        );
        return;
      }

      const details = withoutKnownAdvisoryWarnings(gitProcess.stderr).trim();
      if (gitProcess.args.includes("check-attr") && details.length > 0) {
        finish(
          new Error(
            `git ${formatGitCommand(gitProcess.args)} completed with diagnostics: ${details}`
          )
        );
        return;
      }

      finish();
    };

    if (gitProcess.processError !== undefined) {
      finish(gitProcess.processError);
      return;
    }

    gitProcess.child.once("error", (error: Error) => finish(error));
    gitProcess.child.once("close", onClose);

    if (gitProcess.child.exitCode !== null || gitProcess.child.signalCode !== null) {
      queueMicrotask(() => onClose(gitProcess.child.exitCode));
    }
  });
}

async function readGitText(
  args: readonly string[],
  budget: AnalysisBudget
): Promise<string> {
  const gitProcess = startGit(args, budget);
  let output = "";

  try {
    for await (const chunk of gitProcess.child.stdout) {
      const text = chunkToString(chunk);
      budget.consumeGitStreamBytes(Buffer.byteLength(text, "utf8"));
      output += text;
      if (Buffer.byteLength(output, "utf8") > RESOURCE_LIMITS.maxGitFieldLength) {
        throw new GitResourceLimitError(
          `git ${formatGitCommand(args)} exceeded the ${String(RESOURCE_LIMITS.maxGitFieldLength)}-byte output limit.`
        );
      }
    }

    await waitForGit(gitProcess);
    return output;
  } catch (error: unknown) {
    terminateGit(gitProcess);
    await waitForGit(gitProcess).catch(() => undefined);
    throw toError(error);
  }
}

export async function* parseNullDelimitedChunks(
  stream: AsyncIterable<Buffer | string>,
  maxFieldLength: number = RESOURCE_LIMITS.maxGitFieldLength,
  budget?: AnalysisBudget
): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  function* drainPending(): Generator<string> {
    let delimiterIndex = pending.indexOf("\0");
    while (delimiterIndex !== -1) {
      const value = pending.slice(0, delimiterIndex);
      pending = pending.slice(delimiterIndex + 1);
      if (Buffer.byteLength(value, "utf8") > maxFieldLength) {
        throw new GitResourceLimitError(
          `A Git output field exceeded the ${String(maxFieldLength)}-byte limit.`
        );
      }
      yield value;
      delimiterIndex = pending.indexOf("\0");
    }
  }

  for await (const chunk of stream) {
    const chunkBytes = typeof chunk === "string" ? Buffer.byteLength(chunk, "utf8") : chunk.byteLength;
    budget?.consumeGitStreamBytes(chunkBytes);
    pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
    yield* drainPending();

    if (Buffer.byteLength(pending, "utf8") > maxFieldLength) {
      throw new GitResourceLimitError(
        `A Git output field exceeded the ${String(maxFieldLength)}-byte limit.`
      );
    }
  }

  pending += decoder.end();
  yield* drainPending();
  if (pending.length > 0) {
    throw new GitResourceLimitError(
      "Git returned an unterminated NUL-delimited field."
    );
  }
}

async function consumeNullTerminated(
  stream: AsyncIterable<Buffer | string>,
  maxFieldLength: number,
  onValue: (value: string) => void | Promise<void>,
  skipEmpty: boolean,
  budget?: AnalysisBudget
): Promise<void> {
  for await (const value of parseNullDelimitedChunks(stream, maxFieldLength, budget)) {
    if (!skipEmpty || value.length > 0) {
      await onValue(value);
    }
  }
}

function writeGitInput(gitProcess: GitProcess, value: string): Promise<void> {
  if (gitProcess.inputError !== undefined) {
    return Promise.reject(gitProcess.inputError);
  }

  const input = `${value}\0`;
  gitProcess.budget.consumeGitStreamBytes(Buffer.byteLength(input, "utf8"));
  const accepted = gitProcess.child.stdin.write(input, "utf8");
  if (accepted) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      gitProcess.child.stdin.off("drain", onDrain);
      gitProcess.child.stdin.off("error", onError);
    };
    const onDrain = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    gitProcess.child.stdin.once("drain", onDrain);
    gitProcess.child.stdin.once("error", onError);
  });
}

function toRepositoryPath(repositoryRoot: string, filePath: string): string | undefined {
  if (!isAbsolute(filePath)) {
    return undefined;
  }

  const repositoryPath = relative(repositoryRoot, filePath);
  if (
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath) ||
    repositoryPath === ".." ||
    repositoryPath.startsWith(`..${sep}`)
  ) {
    return undefined;
  }

  return repositoryPath.split(sep).join("/");
}

export async function findGitRepositoryRoot(
  cwd: string,
  budget: AnalysisBudget = new AnalysisBudget()
): Promise<string | undefined> {
  try {
    const output = await readGitText(["-C", cwd, "rev-parse", "--show-toplevel"], budget);
    const repositoryRoot = output.endsWith("\n") ? output.slice(0, -1) : output;
    return repositoryRoot.length > 0 ? repositoryRoot : undefined;
  } catch (error: unknown) {
    if (
      error instanceof GitResourceLimitError ||
      error instanceof ResourceBudgetExceededError
    ) {
      throw error;
    }
    return undefined;
  }
}

export async function isGitCaseInsensitive(
  repositoryRoot: string,
  budget: AnalysisBudget = new AnalysisBudget()
): Promise<boolean> {
  try {
    const output = await readGitText([
      "-C",
      repositoryRoot,
      "config",
      "--bool",
      "--get",
      "core.ignorecase",
    ], budget);
    return output.trim() === "true";
  } catch (error: unknown) {
    if (
      error instanceof GitResourceLimitError ||
      error instanceof ResourceBudgetExceededError
    ) {
      throw error;
    }
    return false;
  }
}

export async function scanGitAttributes(
  repositoryRoot: string,
  additionalPaths: readonly string[] = [],
  handlers: GitAttributeScanHandlers = {},
  budget: AnalysisBudget = new AnalysisBudget()
): Promise<GitAttributeScanResult> {
  budget.checkElapsed();
  const additionalRepositoryPaths = new Set<string>();
  for (const additionalPath of additionalPaths) {
    budget.checkElapsed();
    const repositoryPath = toRepositoryPath(repositoryRoot, additionalPath);
    if (repositoryPath === undefined) {
      continue;
    }

    if (Buffer.byteLength(repositoryPath, "utf8") > RESOURCE_LIMITS.maxGitPathLength) {
      throw new GitResourceLimitError(
        `A repository path exceeded the ${String(RESOURCE_LIMITS.maxGitPathLength)}-byte limit.`
      );
    }
    additionalRepositoryPaths.add(repositoryPath);
    if (additionalRepositoryPaths.size > RESOURCE_LIMITS.maxGitPathCount) {
      throw new GitResourceLimitError(
        `The number of paths passed to Git exceeded the ${String(RESOURCE_LIMITS.maxGitPathCount)}-path limit.`
      );
    }
  }

  let listProcess: GitProcess | undefined;
  let checkProcess: GitProcess | undefined;
  try {
    listProcess = startGit([
      "-C",
      repositoryRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ], budget);
    checkProcess = startGit(
      ["-C", repositoryRoot, "check-attr", "--all", "--stdin", "-z"],
      budget
    );
  } catch (error: unknown) {
    if (listProcess !== undefined) {
      terminateGit(listProcess);
      await waitForGit(listProcess).catch(() => undefined);
    }
    if (checkProcess !== undefined) {
      terminateGit(checkProcess);
      await waitForGit(checkProcess).catch(() => undefined);
    }
    throw toError(error);
  }

  if (listProcess === undefined || checkProcess === undefined) {
    throw new Error("Git processes were not started.");
  }

  const activeListProcess: GitProcess = listProcess;
  const activeCheckProcess: GitProcess = checkProcess;
  let checkedPathCount = 0;
  let effectiveAttributeCount = 0;
  const checkFields: string[] = [];

  const attributesPromise = consumeNullTerminated(
    activeCheckProcess.child.stdout,
    RESOURCE_LIMITS.maxGitFieldLength,
    async (field) => {
      if (checkFields.length >= 3) {
        throw new GitResourceLimitError("Git returned malformed check-attr output.");
      }
      checkFields.push(field);
      if (checkFields.length !== 3) {
        return;
      }

      const [path, name, value] = checkFields;
      if (path === undefined || name === undefined || value === undefined) {
        throw new GitResourceLimitError("Git returned malformed check-attr output.");
      }

      effectiveAttributeCount += 1;
      if (effectiveAttributeCount > RESOURCE_LIMITS.maxGitAttributeCount) {
        throw new GitResourceLimitError(
          `The number of Git attribute results exceeded the ${String(RESOURCE_LIMITS.maxGitAttributeCount)}-result limit.`
        );
      }
      await handlers.onAttribute?.({ name, path, value });
      checkFields.length = 0;
    },
    false,
    budget
  );

  const listAndWritePromise = (async (): Promise<void> => {
    const listedPromise = consumeNullTerminated(
      activeListProcess.child.stdout,
      RESOURCE_LIMITS.maxGitPathLength,
      async (path) => {
        checkedPathCount += 1;
        if (checkedPathCount > RESOURCE_LIMITS.maxGitPathCount) {
          throw new GitResourceLimitError(
            `The number of repository paths exceeded the ${String(RESOURCE_LIMITS.maxGitPathCount)}-path limit.`
          );
        }
        additionalRepositoryPaths.delete(path);
        await handlers.onPath?.(path);
        await writeGitInput(activeCheckProcess, path);
      },
      true,
      budget
    );

    await listedPromise;
    for (const path of additionalRepositoryPaths) {
      checkedPathCount += 1;
      if (checkedPathCount > RESOURCE_LIMITS.maxGitPathCount) {
        throw new GitResourceLimitError(
          `The number of repository paths exceeded the ${String(RESOURCE_LIMITS.maxGitPathCount)}-path limit.`
        );
      }
      await handlers.onPath?.(path);
      await writeGitInput(activeCheckProcess, path);
    }

    activeCheckProcess.child.stdin.end();
    await waitForGit(activeListProcess);
  })();

  try {
    await Promise.all([listAndWritePromise, attributesPromise]);
    await waitForGit(activeCheckProcess);
    if (checkFields.length !== 0) {
      throw new GitResourceLimitError("Git returned incomplete check-attr output.");
    }
  } catch (error: unknown) {
    terminateGit(activeListProcess);
    terminateGit(activeCheckProcess);
    await Promise.allSettled([listAndWritePromise, attributesPromise]);
    throw toError(error);
  }

  return { checkedPathCount, effectiveAttributeCount };
}
