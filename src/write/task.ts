import { createHash } from "node:crypto";

import type { GitHubClient } from "../github/client.js";
import { validateCommitSha, validateRefName } from "../security/refs.js";
import { getBranchHeadIfExists } from "./github.js";

export interface AutomationTaskOperation {
  readonly key: string;
  readonly snapshotFingerprint: string;
  readonly branch: string;
  readonly commitMessage: string;
  readonly pullRequestMarker: string;
}

function fingerprint(parts: readonly string[], length = 24): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, length);
}

export function buildAutomationTaskOperation(input: {
  readonly owner: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly runIdentity: string;
  readonly taskIdentity: string;
}): AutomationTaskOperation {
  const baseSha = validateCommitSha(input.baseSha);
  if (input.runIdentity.trim() === "" || input.runIdentity.includes("\0")) {
    throw new Error("A stable GitHub run identity is required for automation tasks");
  }
  const key = fingerprint([
    input.owner.toLowerCase(),
    input.repo.toLowerCase(),
    input.runIdentity,
    input.taskIdentity,
  ]);
  const snapshotFingerprint = fingerprint([baseSha, input.taskIdentity]);
  const branch = validateRefName(`dsh/task-${key}`);
  const commitMessage = [
    "feat: apply DeepSeek Harness task",
    "",
    `DSH-Task-Key: ${key}`,
    `DSH-Task-Snapshot: ${snapshotFingerprint}`,
  ].join("\n");
  return {
    key,
    snapshotFingerprint,
    branch,
    commitMessage,
    pullRequestMarker: `<!-- dsh-action:task:v1 operation=${key} snapshot=${snapshotFingerprint} -->`,
  };
}

export async function findReconciledTaskCommit(
  client: GitHubClient,
  owner: string,
  repo: string,
  operation: AutomationTaskOperation,
  expectedBaseSha: string,
): Promise<string | null> {
  const head = await getBranchHeadIfExists(client, owner, repo, operation.branch);
  if (head === null) return null;
  const baseSha = validateCommitSha(expectedBaseSha);
  const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: head });
  if (
    commit.data.sha !== head ||
    commit.data.message !== operation.commitMessage ||
    commit.data.parents.length !== 1 ||
    commit.data.parents[0]?.sha !== baseSha
  ) {
    throw new Error("Stable task branch does not belong to this operation snapshot");
  }
  return head;
}

function hasTrailer(message: string, name: string, value: string): boolean {
  return message.split(/\r?\n/u).includes(`${name}: ${value}`);
}

export async function assertTaskCommitOwned(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  operationKey: string,
  snapshotFingerprint: string,
): Promise<void> {
  if (!/^[a-f0-9]{24}$/u.test(operationKey) || !/^[a-f0-9]{24}$/u.test(snapshotFingerprint)) {
    throw new Error("Invalid task operation identity");
  }
  const expectedSha = validateCommitSha(sha);
  const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: expectedSha });
  if (
    commit.data.sha !== expectedSha ||
    commit.data.parents.length !== 1 ||
    !hasTrailer(commit.data.message, "DSH-Task-Key", operationKey) ||
    !hasTrailer(commit.data.message, "DSH-Task-Snapshot", snapshotFingerprint)
  ) {
    throw new Error("Existing task pull request is not owned by this operation");
  }
}

export async function assertEquivalentTaskCommit(
  client: GitHubClient,
  owner: string,
  repo: string,
  existingSha: string,
  candidateSha: string,
  operation: AutomationTaskOperation,
  expectedBaseSha: string,
): Promise<void> {
  const existing = validateCommitSha(existingSha);
  const candidate = validateCommitSha(candidateSha);
  const base = validateCommitSha(expectedBaseSha);
  const [existingCommit, candidateCommit] = await Promise.all([
    client.rest.git.getCommit({ owner, repo, commit_sha: existing }),
    client.rest.git.getCommit({ owner, repo, commit_sha: candidate }),
  ]);
  const valid = [existingCommit.data, candidateCommit.data].every(
    (commit, index) =>
      commit.sha === (index === 0 ? existing : candidate) &&
      commit.message === operation.commitMessage &&
      commit.parents.length === 1 &&
      commit.parents[0]?.sha === base,
  );
  if (!valid || existingCommit.data.tree.sha !== candidateCommit.data.tree.sha) {
    throw new Error("Stable task branch differs from the current verified workspace");
  }
}
