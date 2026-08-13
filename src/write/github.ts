import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { GitHubClient } from "../github/client.js";
import { assertPathWithin } from "../security/paths.js";
import { validateCommitSha, validateRefName } from "../security/refs.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "./workspace.js";

export interface GitHubCommitTarget {
  readonly owner: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly message: string;
}

export interface PublishedCommit {
  readonly sha: string;
  readonly paths: readonly string[];
}

const PROTECTED_PREFIXES = [".github/workflows/", ".github/actions/", ".dsh/", ".agents/"] as const;

const PROTECTED_BASENAMES = new Set([
  ".gitmodules",
  "action.yml",
  "codeowners",
  "dependabot.yml",
  "dependabot.yaml",
  "security.md",
]);

const MAX_PUBLISHED_FILES = 200;
const MAX_PUBLISHED_BYTES = 10 * 1024 * 1024;

export function assertWritablePath(path: string): void {
  const normalized = path.normalize("NFKC").replaceAll("\\", "/").toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const codeowners = basename === "codeowners";
  const dependabot = segments[0] === ".github" && PROTECTED_BASENAMES.has(basename);
  if (
    codeowners ||
    dependabot ||
    PROTECTED_BASENAMES.has(normalized) ||
    PROTECTED_PREFIXES.some(
      (protectedPath) =>
        normalized === protectedPath.replace(/\/$/u, "") || normalized.startsWith(protectedPath),
    )
  ) {
    throw new Error(`Protected path cannot be changed by DSH: ${path}`);
  }
}

/**
 * Materialize a validated worker snapshot using GitHub's Git Database API.
 * The controller token stays inside Octokit; it never enters git, DSH, tests,
 * argv, a remote URL, or a checkout credential file.
 */
export async function createGitHubCommitFromWorkspace(
  client: GitHubClient,
  target: GitHubCommitTarget,
  snapshot: WorkspaceSnapshot,
): Promise<PublishedCommit> {
  const baseSha = validateCommitSha(target.baseSha);
  if (target.message.trim() === "" || target.message.includes("\0")) {
    throw new Error("GitHub commit message must be non-empty and contain no NUL byte");
  }
  const changes = await inspectWorkspaceChanges(snapshot);
  if (changes.all.length === 0) throw new Error("DSH produced no file changes");
  if (changes.all.length > MAX_PUBLISHED_FILES) {
    throw new Error("DSH output exceeds the published file limit");
  }
  for (const path of changes.all) assertWritablePath(path);

  const baseCommit = await client.rest.git.getCommit({
    owner: target.owner,
    repo: target.repo,
    commit_sha: baseSha,
  });
  if (baseCommit.data.sha !== baseSha) {
    throw new Error("GitHub returned a commit that does not match the bound base SHA");
  }

  const tree: {
    path: string;
    mode?: "100644" | "100755";
    type?: "blob";
    sha: string | null;
  }[] = [];
  for (const path of changes.deleted) tree.push({ path, sha: null });
  let publishedBytes = 0;
  for (const path of [...changes.added, ...changes.modified]) {
    const absolute = await assertPathWithin(snapshot.workerRoot, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Only regular files may be published: ${path}`);
    }
    const content = await readFile(absolute);
    publishedBytes += content.byteLength;
    if (publishedBytes > MAX_PUBLISHED_BYTES) {
      throw new Error("DSH output exceeds the published byte limit");
    }
    const blob = await client.rest.git.createBlob({
      owner: target.owner,
      repo: target.repo,
      content: content.toString("base64"),
      encoding: "base64",
    });
    tree.push({
      path,
      mode: (metadata.mode & 0o111) === 0 ? "100644" : "100755",
      type: "blob",
      sha: blob.data.sha,
    });
  }
  const createdTree = await client.rest.git.createTree({
    owner: target.owner,
    repo: target.repo,
    base_tree: baseCommit.data.tree.sha,
    tree,
  });
  const commit = await client.rest.git.createCommit({
    owner: target.owner,
    repo: target.repo,
    message: target.message,
    tree: createdTree.data.sha,
    parents: [baseSha],
  });
  return { sha: validateCommitSha(commit.data.sha), paths: changes.all };
}

export async function getBranchHead(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<string> {
  validateRefName(branch);
  const response = await client.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
  return validateCommitSha(response.data.object.sha);
}

function responseStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

export async function getBranchHeadIfExists(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
): Promise<string | null> {
  try {
    return await getBranchHead(client, owner, repo, branch);
  } catch (error) {
    if (responseStatus(error) === 404) return null;
    throw error;
  }
}

export async function assertRemoteBranchHead(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  expectedSha: string,
): Promise<void> {
  const actual = await getBranchHead(client, owner, repo, branch);
  const expected = validateCommitSha(expectedSha);
  if (actual !== expected) throw new Error("Remote branch advanced during DSH execution");
}

export async function createRemoteBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<void> {
  validateRefName(branch);
  const expected = validateCommitSha(sha);
  try {
    await client.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha: expected,
    });
  } catch (error) {
    // A transport failure or 422 may be an ambiguous success. Reconcile only
    // the exact postcondition; a different branch head is a hard collision.
    let actual: string | null;
    try {
      actual = await getBranchHeadIfExists(client, owner, repo, branch);
    } catch {
      throw error;
    }
    if (actual === expected) return;
    if (actual !== null) {
      throw new Error("Remote branch exists at a different commit; refusing to overwrite it", {
        cause: error,
      });
    }
    throw error;
  }
}

export async function updateRemoteBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  branch: string,
  sha: string,
): Promise<void> {
  validateRefName(branch);
  const desiredSha = validateCommitSha(sha);
  try {
    await client.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: desiredSha,
      force: false,
    });
  } catch (error) {
    // The update may have reached GitHub even when the response was lost. A
    // controller-side read-after-write turns that ambiguous transport failure
    // into success only when the exact immutable target is now installed.
    try {
      if ((await getBranchHead(client, owner, repo, branch)) === desiredSha) return;
    } catch {
      // Preserve the original update error; the reconciliation read is only
      // evidence of success and must not obscure the failed mutation.
    }
    throw error;
  }
}

export function workspaceFile(snapshot: WorkspaceSnapshot, path: string): string {
  return resolve(snapshot.workerRoot, ...path.split("/"));
}
