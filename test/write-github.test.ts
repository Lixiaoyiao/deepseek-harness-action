import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import {
  assertWritablePath,
  createGitHubCommitFromWorkspace,
  updateRemoteBranch,
} from "../src/write/github.js";
import { createWorkspaceSnapshot } from "../src/write/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GitHub database writes", () => {
  it("uses the bound commit's tree object as createTree.base_tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-github-write-"));
    roots.push(root);
    const source = join(root, "source");
    const worker = join(root, "worker");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(source));
    await writeFile(join(source, "a.txt"), "old\n");
    const snapshot = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: source },
      worker,
    );
    await writeFile(join(worker, "a.txt"), "new\n");

    const createTree = vi.fn().mockResolvedValue({ data: { sha: "d".repeat(40) } });
    const client = {
      rest: {
        git: {
          getCommit: vi.fn().mockResolvedValue({
            data: { sha: "a".repeat(40), tree: { sha: "b".repeat(40) } },
          }),
          createBlob: vi.fn().mockResolvedValue({ data: { sha: "c".repeat(40) } }),
          createTree,
          createCommit: vi.fn().mockResolvedValue({ data: { sha: "e".repeat(40) } }),
        },
      },
    } as unknown as GitHubClient;

    await createGitHubCommitFromWorkspace(
      client,
      { owner: "o", repo: "r", baseSha: "a".repeat(40), message: "fix: safe" },
      snapshot,
    );
    expect(createTree).toHaveBeenCalledWith(expect.objectContaining({ base_tree: "b".repeat(40) }));
  });

  it.each([
    ".github/CODEOWNERS",
    "docs/CODEOWNERS",
    ".github/dependabot.yml",
    ".github/workflows/release.yml",
    "SECURITY.md",
  ])("rejects protected control-plane path %s", (path) => {
    expect(() => assertWritablePath(path)).toThrow("Protected path");
  });

  it("reconciles an ambiguous updateRef error when the branch reached the desired SHA", async () => {
    const desired = "e".repeat(40);
    const updateError = new Error("response lost");
    const getRef = vi.fn().mockResolvedValue({ data: { object: { sha: desired } } });
    const client = {
      rest: { git: { updateRef: vi.fn().mockRejectedValue(updateError), getRef } },
    } as unknown as GitHubClient;

    await expect(updateRemoteBranch(client, "o", "r", "feature", desired)).resolves.toBeUndefined();
    expect(getRef).toHaveBeenCalledWith({ owner: "o", repo: "r", ref: "heads/feature" });
  });

  it("preserves updateRef failure when reconciliation finds a different SHA", async () => {
    const updateError = new Error("update rejected");
    const client = {
      rest: {
        git: {
          updateRef: vi.fn().mockRejectedValue(updateError),
          getRef: vi.fn().mockResolvedValue({ data: { object: { sha: "d".repeat(40) } } }),
        },
      },
    } as unknown as GitHubClient;

    await expect(updateRemoteBranch(client, "o", "r", "feature", "e".repeat(40))).rejects.toBe(
      updateError,
    );
  });
});
