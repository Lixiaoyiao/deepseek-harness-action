import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { assertPinnedContainerImage } from "../dsh/runner.js";
import {
  ActionConfigurationError,
  ClassifiedActionError,
  PolicyDeniedError,
  type ActionErrorIdentity,
} from "../errors.js";
import { runCommand, type CommandResult } from "../security/argv.js";
import { isIgnoredGeneratedRootEntry } from "./workspace.js";

const VALIDATION_ENV = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMP",
  "TEMP",
  "CI",
  "LANG",
  "LC_ALL",
] as const;

export type ValidationProcessRunner = (
  options: Parameters<typeof runCommand>[0],
) => Promise<CommandResult>;

export interface ValidationResult {
  readonly argv: readonly string[];
  readonly result: CommandResult;
}

/** A trusted write is never authorized without an executed validation suite. */
export function assertWriteValidationConfigured(
  runTests: boolean,
  commands: readonly (readonly string[])[],
): void {
  if (!runTests) {
    throw new PolicyDeniedError(
      "run-tests=false cannot authorize a repository write; trusted writes require Controller validation",
    );
  }
  if (commands.length === 0) {
    throw new PolicyDeniedError(
      "test-commands must contain at least one command before a repository write",
    );
  }
}

function validationDeadline(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ActionConfigurationError("Validation timeout must be a positive integer");
  }
  return Date.now() + timeoutMs;
}

function deadlineExceededResult(): CommandResult {
  return {
    exitCode: 1,
    stdout: "",
    stderr: "Validation did not start because the overall validation deadline was exhausted.",
    timedOut: true,
    outputTruncated: false,
  };
}

function includeInValidationCopy(workspaceRoot: string, source: string): boolean {
  const path = relative(workspaceRoot, source);
  if (path === "") return true;
  const rootEntry = path.split(sep)[0];
  return rootEntry !== undefined && !isIgnoredGeneratedRootEntry(rootEntry);
}

export type ValidationErrorCode =
  "VALIDATION_FAILED" | "VALIDATION_TIMEOUT" | "VALIDATION_INTEGRITY";

export class ValidationFailureError extends ClassifiedActionError<ValidationErrorCode> {
  public readonly argv: readonly string[];
  public readonly exitCode: number;
  public readonly timedOut: boolean;
  public readonly outputTruncated: boolean;
  public readonly result: CommandResult;

  public constructor(
    failure: ValidationResult,
    identity?: ActionErrorIdentity<ValidationErrorCode>,
  ) {
    const command = failure.argv.join(" ");
    const status = failure.result.timedOut
      ? "timed out"
      : `exited with code ${String(failure.result.exitCode)}`;
    const code = failure.result.timedOut ? "VALIDATION_TIMEOUT" : "VALIDATION_FAILED";
    super(
      `Validation command ${JSON.stringify(command)} ${status}${failure.result.outputTruncated ? "; captured output was truncated" : ""}`,
      identity ?? { code, category: "domain", retryable: failure.result.timedOut },
    );
    this.argv = failure.argv;
    this.exitCode = failure.result.exitCode;
    this.timedOut = failure.result.timedOut;
    this.outputTruncated = failure.result.outputTruncated;
    this.result = failure.result;
  }
}

export function assertValidationSucceeded(results: readonly ValidationResult[]): void {
  const failed = results.find(({ result }) => result.exitCode !== 0 || result.timedOut);
  if (failed !== undefined) throw new ValidationFailureError(failed);
}

function hostUserForContainer(): string {
  return process.platform === "win32"
    ? "0:0"
    : `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
}

/** Runs operator-provided argv without a shell and without controller secrets. */
export async function runValidationCommands(
  cwd: string,
  commands: readonly (readonly string[])[],
  timeoutMs = 10 * 60_000,
  signal?: AbortSignal,
): Promise<readonly ValidationResult[]> {
  const deadline = validationDeadline(timeoutMs);
  const env: NodeJS.ProcessEnv = {};
  for (const name of VALIDATION_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const results: ValidationResult[] = [];
  for (const argv of commands) {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("Validation command must not be empty");
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      results.push({ argv, result: deadlineExceededResult() });
      break;
    }
    const result = await runCommand({
      command,
      args,
      cwd,
      env,
      timeoutMs: remainingMs,
      maxOutputBytes: 2 * 1024 * 1024,
      ...(signal === undefined ? {} : { signal }),
    });
    results.push({ argv, result });
    if (result.exitCode !== 0 || result.timedOut) break;
  }
  return results;
}

export async function runValidationCommandsInDocker(
  cwd: string,
  commands: readonly (readonly string[])[],
  containerImage: string,
  timeoutMs = 10 * 60_000,
  processRunner: ValidationProcessRunner = runCommand,
  signal?: AbortSignal,
): Promise<readonly ValidationResult[]> {
  // Repeat the check at this boundary so future callers cannot run
  // trusted-write validation with a mutable image tag.
  assertPinnedContainerImage(containerImage);
  const deadline = validationDeadline(timeoutMs);
  const validationParent = await mkdtemp(join(tmpdir(), "dsh-action-validation-"));
  const validationRoot = join(validationParent, "workspace");
  try {
    await cp(cwd, validationRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => includeInValidationCopy(cwd, source),
    });
    const results: ValidationResult[] = [];
    for (const argv of commands) {
      if (argv.length === 0) throw new Error("Validation command must not be empty");
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        results.push({ argv, result: deadlineExceededResult() });
        break;
      }
      const containerName = `dsh-action-validation-${randomUUID()}`;
      const dockerArgs = [
        "run",
        "--rm",
        "--init",
        "--name",
        containerName,
        "--network",
        "bridge",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--cpus",
        "2",
        "--user",
        hostUserForContainer(),
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=256m",
        "--tmpfs",
        "/dsh-validation-home:rw,nosuid,nodev,size=256m",
        "--mount",
        `type=bind,source=${validationRoot},target=/workspace`,
        "--workdir",
        "/workspace",
        "--env",
        "CI=true",
        "--env",
        "HOME=/dsh-validation-home",
        "--env",
        "npm_config_cache=/dsh-validation-home/npm-cache",
        containerImage,
        ...argv,
      ];
      const cleanup = async (): Promise<void> => {
        try {
          await processRunner({
            command: "docker",
            args: ["rm", "--force", containerName],
            cwd: validationRoot,
            env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
            timeoutMs: 10_000,
            maxOutputBytes: 16 * 1024,
          });
        } catch {
          // A named --rm container may already be gone. Cleanup is best effort.
        }
      };
      let result: CommandResult;
      try {
        result = await processRunner({
          command: "docker",
          args: dockerArgs,
          cwd: validationRoot,
          env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
          timeoutMs: remainingMs,
          maxOutputBytes: 2 * 1024 * 1024,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error: unknown) {
        await cleanup();
        throw error;
      }
      if (result.timedOut || result.exitCode !== 0) await cleanup();
      results.push({ argv, result });
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    return results;
  } finally {
    await rm(validationParent, { force: true, recursive: true });
  }
}
