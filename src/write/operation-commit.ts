import { ActionConfigurationError } from "../errors.js";
import type { GitHubClient } from "../github/client.js";
import { validateCommitSha } from "../security/refs.js";
import { EntityBindingChangedError } from "./errors.js";
import { getBranchHeadIfExists } from "./github.js";

export interface BranchWriteOperation {
  readonly key: string;
  readonly snapshotFingerprint: string;
  readonly branch: string;
  readonly commitMessage: string;
  readonly pullRequestMarker: string;
}

export type BranchWriteOperationKind = "implement" | "task";
const OWNERSHIP = {
  implement: {
    label: "implementation",
    keyTrailer: "DSH-Operation-Key",
    snapshotTrailer: "DSH-Issue-Snapshot",
  },
  task: { label: "task", keyTrailer: "DSH-Task-Key", snapshotTrailer: "DSH-Task-Snapshot" },
} as const;

/** Authenticate an orphaned ref by exact commit message and immutable parent. */
export async function findOwnedBranchCommit(
  kind: BranchWriteOperationKind,
  client: GitHubClient,
  owner: string,
  repo: string,
  operation: BranchWriteOperation,
  expectedBaseSha: string,
): Promise<string | null> {
  const head = await getBranchHeadIfExists(client, owner, repo, operation.branch);
  if (head === null) return null;
  const base = validateCommitSha(expectedBaseSha);
  const { data: commit } = await client.rest.git.getCommit({ owner, repo, commit_sha: head });
  if (
    commit.sha !== head ||
    commit.message !== operation.commitMessage ||
    commit.parents.length !== 1 ||
    commit.parents[0]?.sha !== base
  ) {
    throw new EntityBindingChangedError(
      `Stable ${OWNERSHIP[kind].label} branch does not belong to this operation snapshot`,
    );
  }
  return head;
}

/** A completed PR is reusable only when both Controller ownership trailers match. */
export async function assertOwnedOperationCommit(
  kind: BranchWriteOperationKind,
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  operationKey: string,
  snapshotFingerprint: string,
): Promise<void> {
  const protocol = OWNERSHIP[kind];
  if (!/^[a-f0-9]{24}$/u.test(operationKey) || !/^[a-f0-9]{24}$/u.test(snapshotFingerprint)) {
    throw new ActionConfigurationError(
      `Invalid ${kind === "task" ? "task" : "implementation"} operation identity`,
    );
  }
  const expected = validateCommitSha(sha);
  const { data: commit } = await client.rest.git.getCommit({ owner, repo, commit_sha: expected });
  const lines = commit.message.split(/\r?\n/u);
  if (
    commit.sha !== expected ||
    commit.parents.length !== 1 ||
    !lines.includes(`${protocol.keyTrailer}: ${operationKey}`) ||
    !lines.includes(`${protocol.snapshotTrailer}: ${snapshotFingerprint}`)
  ) {
    throw new EntityBindingChangedError(
      `Existing ${protocol.label} pull request is not owned by this operation`,
    );
  }
}

/** Reuse an owned orphan ref only if it contains the exact newly validated tree. */
export async function assertEquivalentOperationCommit(
  kind: BranchWriteOperationKind,
  client: GitHubClient,
  owner: string,
  repo: string,
  existingSha: string,
  candidateSha: string,
  operation: BranchWriteOperation,
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
    throw new EntityBindingChangedError(
      `Stable ${OWNERSHIP[kind].label} branch differs from the current verified workspace; refusing reuse`,
    );
  }
}
