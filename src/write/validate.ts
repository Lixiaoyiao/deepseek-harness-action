import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assertPinnedContainerImage } from "../dsh/runner.js";
import { runCommand, type CommandResult } from "../security/argv.js";

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

export interface ValidationResult {
  readonly argv: readonly string[];
  readonly result: CommandResult;
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
): Promise<readonly ValidationResult[]> {
  const env: NodeJS.ProcessEnv = {};
  for (const name of VALIDATION_ENV) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  const results: ValidationResult[] = [];
  for (const argv of commands) {
    const [command, ...args] = argv;
    if (command === undefined) throw new Error("Validation command must not be empty");
    const result = await runCommand({
      command,
      args,
      cwd,
      env,
      timeoutMs,
      maxOutputBytes: 2 * 1024 * 1024,
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
): Promise<readonly ValidationResult[]> {
  // Repeat the check at this boundary so future callers cannot run
  // trusted-write validation with a mutable image tag.
  assertPinnedContainerImage(containerImage);
  const validationParent = await mkdtemp(join(tmpdir(), "dsh-action-validation-"));
  const validationRoot = join(validationParent, "workspace");
  try {
    await cp(cwd, validationRoot, { recursive: true, force: false, errorOnExist: true });
    const results: ValidationResult[] = [];
    for (const argv of commands) {
      if (argv.length === 0) throw new Error("Validation command must not be empty");
      const dockerArgs = [
        "run",
        "--rm",
        "--network",
        "bridge",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
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
      const result = await runCommand({
        command: "docker",
        args: dockerArgs,
        cwd: validationRoot,
        env: process.env.PATH === undefined ? {} : { PATH: process.env.PATH },
        timeoutMs,
        maxOutputBytes: 2 * 1024 * 1024,
      });
      results.push({ argv, result });
      if (result.exitCode !== 0 || result.timedOut) break;
    }
    return results;
  } finally {
    await rm(validationParent, { force: true, recursive: true });
  }
}
