import { spawn } from "node:child_process";

const secretEnvironmentNames = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "DEEPSEEK_API_KEY",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
]);

function isSecretEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return secretEnvironmentNames.has(normalized) || normalized.startsWith("ACTIONS_ID_TOKEN_");
}

export function assertSafeArgv(command: string, args: readonly string[]): void {
  if (command.trim() === "" || command.includes("\0")) throw new Error("Invalid command");
  if (args.some((argument) => argument.includes("\0"))) throw new Error("argv contains a NUL byte");
}

/** Build a child environment from an explicit allowlist; secrets are denied even if named. */
export function buildChildEnvironment(
  source: NodeJS.ProcessEnv,
  allowlist: readonly string[],
  overrides: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of allowlist) {
    if (isSecretEnvironmentName(name)) continue;
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  for (const [name, value] of Object.entries(overrides)) {
    if (isSecretEnvironmentName(name)) {
      throw new Error(`Secret environment variable cannot enter child process: ${name}`);
    }
    result[name] = value;
  }
  return result;
}

export interface CommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputTruncated: boolean;
}

interface StreamCapture {
  readonly limit: number;
  readonly headLimit: number;
  readonly tailLimit: number;
  readonly head: Buffer;
  readonly tail: Buffer;
  headBytes: number;
  tailBytes: number;
  tailOffset: number;
  seen: number;
}

const outputTruncationMarker = Buffer.from("\n[...output truncated...]\n", "utf8");

function createStreamCapture(limit: number): StreamCapture {
  const headLimit = Math.floor(limit / 3);
  return {
    limit,
    headLimit,
    tailLimit: limit - headLimit,
    head: Buffer.alloc(headLimit),
    tail: Buffer.alloc(limit - headLimit),
    headBytes: 0,
    tailBytes: 0,
    tailOffset: 0,
    seen: 0,
  };
}

function writeCircular(target: Buffer, offset: number, source: Buffer): void {
  const first = Math.min(source.byteLength, target.byteLength - offset);
  source.copy(target, offset, 0, first);
  if (first < source.byteLength) source.copy(target, 0, first);
}

function captureChunk(capture: StreamCapture, chunk: Buffer): void {
  capture.seen += chunk.byteLength;
  const headRemaining = capture.headLimit - capture.headBytes;
  const headBytes = Math.max(0, Math.min(headRemaining, chunk.byteLength));
  if (headBytes > 0) {
    chunk.copy(capture.head, capture.headBytes, 0, headBytes);
    capture.headBytes += headBytes;
  }
  let remainder = chunk.subarray(headBytes);
  if (remainder.byteLength === 0 || capture.tailLimit === 0) return;
  if (remainder.byteLength >= capture.tailLimit) {
    remainder.subarray(remainder.byteLength - capture.tailLimit).copy(capture.tail);
    capture.tailBytes = capture.tailLimit;
    capture.tailOffset = 0;
    return;
  }
  if (capture.tailBytes < capture.tailLimit) {
    const appended = remainder.subarray(0, capture.tailLimit - capture.tailBytes);
    writeCircular(
      capture.tail,
      (capture.tailOffset + capture.tailBytes) % capture.tailLimit,
      appended,
    );
    capture.tailBytes += appended.byteLength;
    remainder = remainder.subarray(appended.byteLength);
  }
  if (remainder.byteLength > 0) {
    writeCircular(capture.tail, capture.tailOffset, remainder);
    capture.tailOffset = (capture.tailOffset + remainder.byteLength) % capture.tailLimit;
  }
}

function orderedTail(capture: StreamCapture): Buffer {
  if (capture.tailBytes === 0) return Buffer.alloc(0);
  if (capture.tailBytes < capture.tailLimit || capture.tailOffset === 0) {
    return capture.tail.subarray(0, capture.tailBytes);
  }
  return Buffer.concat([
    capture.tail.subarray(capture.tailOffset),
    capture.tail.subarray(0, capture.tailOffset),
  ]);
}

function decodeBoundary(buffer: Buffer, side: "head" | "tail"): string {
  let value = buffer.toString("utf8");
  if (side === "head") {
    while (value.endsWith("\uFFFD")) value = value.slice(0, -1);
  } else {
    while (value.startsWith("\uFFFD")) value = value.slice(1);
  }
  return value;
}

function renderCapture(capture: StreamCapture, budget: number): string {
  if (budget <= 0 || capture.seen === 0) return "";
  const headBuffer = capture.head.subarray(0, capture.headBytes);
  const tailBuffer = orderedTail(capture);
  if (capture.seen <= budget) {
    return Buffer.concat([headBuffer, tailBuffer]).toString("utf8");
  }
  if (budget <= outputTruncationMarker.byteLength) {
    return decodeBoundary(tailBuffer.subarray(Math.max(0, tailBuffer.byteLength - budget)), "tail");
  }
  const available = budget - outputTruncationMarker.byteLength;
  const headBytes = Math.floor(available / 3);
  const tailBytes = available - headBytes;
  const head = decodeBoundary(headBuffer.subarray(0, headBytes), "head");
  const tail = decodeBoundary(
    tailBuffer.subarray(Math.max(0, tailBuffer.byteLength - tailBytes)),
    "tail",
  );
  return head + outputTruncationMarker.toString("utf8") + tail;
}

function outputBudgets(stdoutBytes: number, stderrBytes: number, maximumBytes: number) {
  const half = Math.floor(maximumBytes / 2);
  let stdout = Math.min(stdoutBytes, half);
  let stderr = Math.min(stderrBytes, half);
  let remaining = maximumBytes - stdout - stderr;
  const stderrExtra = Math.min(remaining, stderrBytes - stderr);
  stderr += stderrExtra;
  remaining -= stderrExtra;
  stdout += Math.min(remaining, stdoutBytes - stdout);
  return { stdout, stderr };
}

/** Execute a binary using argv directly. No shell is created. */
export async function runCommand(options: CommandOptions): Promise<CommandResult> {
  assertSafeArgv(options.command, options.args);
  if (options.timeoutMs <= 0 || options.maxOutputBytes <= 0) {
    throw new Error("timeoutMs and maxOutputBytes must be positive");
  }

  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const stdout = createStreamCapture(options.maxOutputBytes);
    const stderr = createStreamCapture(options.maxOutputBytes);
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;

    child.stdout.on("data", (chunk: Buffer) => captureChunk(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => captureChunk(stderr, chunk));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      forceTimer.unref();
    }, options.timeoutMs);
    timer.unref();

    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      const budgets = outputBudgets(stdout.seen, stderr.seen, options.maxOutputBytes);
      resolvePromise({
        exitCode: code ?? 1,
        stdout: renderCapture(stdout, budgets.stdout),
        stderr: renderCapture(stderr, budgets.stderr),
        timedOut,
        outputTruncated: stdout.seen > budgets.stdout || stderr.seen > budgets.stderr,
      });
    });
  });
}
