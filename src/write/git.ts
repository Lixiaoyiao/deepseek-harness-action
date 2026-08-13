import { relative } from "node:path";

import { assertPathWithin } from "../security/paths.js";
import { runCommand, type CommandResult } from "../security/argv.js";
import { validateCommitSha, validateRefName } from "../security/refs.js";

const GIT_ENV_ALLOWLIST = [
  "PATH",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
] as const;

export interface GitRunnerOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly extraEnv?: Readonly<Record<string, string>>;
}

function gitEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of GIT_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) environment[key] = value;
  return environment;
}

export async function runGit(
  args: readonly string[],
  options: GitRunnerOptions,
): Promise<CommandResult> {
  return runCommand({
    command: "git",
    args,
    cwd: options.cwd,
    env: gitEnvironment(options.extraEnv),
    timeoutMs: options.timeoutMs ?? 120_000,
    maxOutputBytes: options.maxOutputBytes ?? 1024 * 1024,
  });
}

export async function requireGitSuccess(
  args: readonly string[],
  options: GitRunnerOptions,
): Promise<CommandResult> {
  const result = await runGit(args, options);
  if (result.timedOut) throw new Error(`git ${args[0] ?? "command"} timed out`);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0] ?? "command"} failed: ${result.stderr.slice(0, 4_000)}`);
  }
  return result;
}

export async function currentHeadSha(cwd: string): Promise<string> {
  const result = await requireGitSuccess(["rev-parse", "HEAD"], { cwd });
  return validateCommitSha(result.stdout.trim());
}

export async function assertHeadSha(cwd: string, expectedSha: string): Promise<void> {
  const expected = validateCommitSha(expectedSha);
  const actual = await currentHeadSha(cwd);
  if (actual !== expected)
    throw new Error(`Checkout HEAD changed: expected ${expected}, got ${actual}`);
}

export async function listChangedPaths(cwd: string): Promise<readonly string[]> {
  const result = await requireGitSuccess(
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    {
      cwd,
    },
  );
  const records = result.stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record === undefined || record.length < 4) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (
      status.startsWith("R") ||
      status.startsWith("C") ||
      status.endsWith("R") ||
      status.endsWith("C")
    ) {
      const destination = records[index + 1];
      if (destination !== undefined) {
        paths.push(destination);
        index += 1;
      }
    } else {
      paths.push(path);
    }
  }
  const normalized: string[] = [];
  for (const path of paths) {
    const resolved = await assertPathWithin(cwd, path);
    normalized.push(relative(cwd, resolved).replaceAll("\\", "/"));
  }
  return [...new Set(normalized)].sort();
}

export async function stageExplicitPaths(cwd: string, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) throw new Error("Refusing to stage an empty change set");
  for (const path of paths) await assertPathWithin(cwd, path);
  await requireGitSuccess(["add", "--", ...paths], { cwd });
}

export async function createCommit(
  cwd: string,
  message: string,
  paths: readonly string[],
  identity?: { readonly name: string; readonly email: string },
): Promise<string> {
  if (message.includes("\0") || /[\r\n]/u.test(message) || message.trim() === "") {
    throw new Error("Commit message must be a non-empty single line");
  }
  await stageExplicitPaths(cwd, paths);
  const staged = await runGit(["diff", "--cached", "--quiet", "--exit-code"], { cwd });
  if (staged.timedOut) throw new Error("git diff timed out");
  if (staged.exitCode === 0) throw new Error("Refusing to create an empty commit");
  if (staged.exitCode !== 1) throw new Error(`git diff failed: ${staged.stderr.slice(0, 4_000)}`);
  const identityArgs =
    identity === undefined
      ? []
      : ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
  await requireGitSuccess([...identityArgs, "commit", "--no-verify", "-m", message], { cwd });
  return currentHeadSha(cwd);
}

export async function createBranch(cwd: string, branch: string): Promise<void> {
  validateRefName(branch);
  await requireGitSuccess(["switch", "-c", branch], { cwd });
}

/** Pushes one validated branch, non-force, to the fixed origin remote. */
export async function pushBranch(
  cwd: string,
  branch: string,
  environment: Readonly<Record<string, string>>,
): Promise<void> {
  validateRefName(branch);
  await requireGitSuccess(["push", "--porcelain", "origin", `HEAD:refs/heads/${branch}`], {
    cwd,
    extraEnv: environment,
    timeoutMs: 180_000,
  });
}
