import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertHeadSha,
  createBranch,
  createCommit,
  currentHeadSha,
  listChangedPaths,
  pushBranch,
  requireGitSuccess,
  runGit,
  stageExplicitPaths,
} from "../src/write/git.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];
const identity = { name: "dsh-action test", email: "dsh-action@example.invalid" };

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-action-git-"));
  roots.push(root);
  await requireGitSuccess(["init", "--initial-branch=main"], { cwd: root });
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("safe git controller", () => {
  it("discovers, stages, and commits only explicit paths", async () => {
    const root = await repository();
    await writeFile(join(root, "tracked.txt"), "first\n");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "untracked.txt"), "second\n");

    expect(await listChangedPaths(root)).toEqual(["nested/untracked.txt", "tracked.txt"]);
    const sha = await createCommit(root, "test: initial", ["tracked.txt"], identity);
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    await assertHeadSha(root, sha);
    await expect(assertHeadSha(root, "0".repeat(40))).rejects.toThrow("Checkout HEAD changed");
    expect(await listChangedPaths(root)).toEqual(["nested/untracked.txt"]);

    await expect(stageExplicitPaths(root, [])).rejects.toThrow("empty change set");
    await expect(
      createCommit(root, "bad\nmessage", ["nested/untracked.txt"], identity),
    ).rejects.toThrow("single line");
  });

  it("creates and non-force pushes one validated branch", async () => {
    const root = await repository();
    await writeFile(join(root, "file.txt"), "content\n");
    const sha = await createCommit(root, "test: initial", ["file.txt"], identity);
    await createBranch(root, "dsh/test-branch");

    const bare = await mkdtemp(join(tmpdir(), "dsh-action-remote-"));
    roots.push(bare);
    await execFileAsync("git", ["init", "--bare", bare]);
    await requireGitSuccess(["remote", "add", "origin", bare], { cwd: root });
    await pushBranch(root, "dsh/test-branch", {});

    const remote = await execFileAsync("git", [
      "--git-dir",
      bare,
      "rev-parse",
      "refs/heads/dsh/test-branch",
    ]);
    expect(remote.stdout.trim()).toBe(sha);
    await expect(pushBranch(root, "--receive-pack=evil", {})).rejects.toThrow();
  });

  it("classifies failures, empty commits, and command results", async () => {
    const root = await repository();
    const version = await runGit(["--version"], { cwd: root, maxOutputBytes: 1024 });
    expect(version.exitCode).toBe(0);
    expect(version.timedOut).toBe(false);
    expect(version.stdout).toContain("git version");

    await expect(requireGitSuccess(["definitely-not-a-command"], { cwd: root })).rejects.toThrow(
      "git definitely-not-a-command failed",
    );
    await writeFile(join(root, "file.txt"), "content\n");
    await createCommit(root, "test: initial", ["file.txt"], identity);
    await expect(createCommit(root, "test: empty", ["file.txt"], identity)).rejects.toThrow(
      "empty commit",
    );
    expect(await currentHeadSha(root)).toMatch(/^[0-9a-f]{40}$/u);
  });
});
