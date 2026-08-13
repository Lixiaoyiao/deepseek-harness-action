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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let captured = 0;
    let outputTruncated = false;
    let timedOut = false;
    let forceTimer: NodeJS.Timeout | undefined;

    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      const remaining = options.maxOutputBytes - captured;
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }
      const accepted = chunk.subarray(0, remaining);
      chunks.push(accepted);
      captured += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) outputTruncated = true;
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));

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
      resolvePromise({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        outputTruncated,
      });
    });
  });
}
