import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { assertSafeArgv } from "../security/argv.js";
import {
  DshAbortedError,
  DshConfigurationError,
  DshOutputLimitError,
  DshSpawnError,
  DshTimeoutError,
} from "./errors.js";
import type { DshError } from "./errors.js";

export const DEFAULT_DSH_PROCESS_KILL_GRACE_MS = 2_000;

export interface DshProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Optional backend cleanup command, e.g. docker kill <random-name>. */
  readonly termination?: Omit<DshProcessSpec, "termination">;
}

export interface DshProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DshProcessLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxCombinedBytes: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshConfigurationError(`${name} must be a positive integer`);
  }
}

function killPosixTree(child: ChildProcessWithoutNullStreams, graceMs: number): void {
  const pid = child.pid;
  try {
    if (pid === undefined) child.kill("SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (pid === undefined) child.kill("SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, graceMs);
  forceTimer.unref();
}

function killWindowsTree(child: ChildProcessWithoutNullStreams, graceMs: number): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => child.kill());
  killer.unref();
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
  }, graceMs);
  forceTimer.unref();
}

function terminateTree(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
  platform: NodeJS.Platform,
  termination?: Omit<DshProcessSpec, "termination">,
): void {
  if (termination !== undefined) {
    const cleanup = spawn(termination.command, [...termination.args], {
      cwd: termination.cwd,
      env: termination.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    cleanup.once("error", () => undefined);
    cleanup.unref();
  }
  if (platform === "win32") killWindowsTree(child, graceMs);
  else killPosixTree(child, graceMs);
}

/**
 * Spawn one argv-only process with independent stdout/stderr and aggregate
 * caps. Timeout state is controller-owned because DSH exits 0 on SIGTERM.
 */
export async function executeBoundedDshProcess(
  spec: DshProcessSpec,
  limits: DshProcessLimits,
  platform: NodeJS.Platform = process.platform,
): Promise<DshProcessResult> {
  positiveInteger(limits.timeoutMs, "timeoutMs");
  positiveInteger(limits.maxStdoutBytes, "maxStdoutBytes");
  positiveInteger(limits.maxStderrBytes, "maxStderrBytes");
  positiveInteger(limits.maxCombinedBytes, "maxCombinedBytes");
  assertSafeArgv(spec.command, spec.args);

  if (limits.signal?.aborted === true) throw new DshAbortedError();

  return await new Promise<DshProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        detached: platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdin.end();
    } catch (error: unknown) {
      rejectPromise(new DshSpawnError("Failed to spawn DSH", { cause: error }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError: DshError | undefined;
    const graceMs = limits.killGraceMs ?? DEFAULT_DSH_PROCESS_KILL_GRACE_MS;

    const stop = (error: DshError): void => {
      if (terminalError !== undefined) return;
      terminalError = error;
      terminateTree(child, graceMs, platform, spec.termination);
    };

    const capture = (stream: "stdout" | "stderr", value: unknown): void => {
      if (terminalError !== undefined) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;

      const streamBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const streamLimit = stream === "stdout" ? limits.maxStdoutBytes : limits.maxStderrBytes;
      if (streamBytes > streamLimit) {
        stop(new DshOutputLimitError(stream, streamLimit));
        return;
      }
      if (stdoutBytes + stderrBytes > limits.maxCombinedBytes) {
        stop(new DshOutputLimitError("combined", limits.maxCombinedBytes));
        return;
      }
      (stream === "stdout" ? stdoutChunks : stderrChunks).push(chunk);
    };

    child.stdout.on("data", (value: unknown) => capture("stdout", value));
    child.stderr.on("data", (value: unknown) => capture("stderr", value));

    const timeout = setTimeout(() => stop(new DshTimeoutError(limits.timeoutMs)), limits.timeoutMs);
    timeout.unref();
    const abort = (): void => stop(new DshAbortedError());
    limits.signal?.addEventListener("abort", abort, { once: true });
    if (limits.signal?.aborted === true) abort();

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      limits.signal?.removeEventListener("abort", abort);
    };

    child.once("error", (error: Error) => {
      finish();
      rejectPromise(
        terminalError ??
          new DshSpawnError("Failed to spawn or communicate with DSH", { cause: error }),
      );
    });
    child.once("close", (exitCode, signal) => {
      finish();
      if (terminalError !== undefined) {
        rejectPromise(terminalError);
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });
}
