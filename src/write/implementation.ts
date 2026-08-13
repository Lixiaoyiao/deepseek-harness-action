import { createHash } from "node:crypto";

import type { GitHubClient } from "../github/client.js";
import { validateCommitSha } from "../security/refs.js";
import { buildDshBranch } from "./branch.js";
import { getBranchHeadIfExists } from "./github.js";

export interface ImplementationOperation {
  readonly key: string;
  readonly snapshotFingerprint: string;
  readonly branch: string;
  readonly commitMessage: string;
  readonly pullRequestMarker: string;
}

interface BuildImplementationOperationInput {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueState: string;
  readonly issueUpdatedAt: string;
  readonly baseSha: string;
  /** GITHUB_RUN_ID: stable across attempts of the same workflow run. */
  readonly runIdentity: string;
}

function fingerprint(parts: readonly string[], length: number): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, length);
}

/** Build an unguessable-enough, deterministic identity for one Issue -> PR operation. */
export function buildImplementationOperation(
  input: BuildImplementationOperationInput,
): ImplementationOperation {
  const baseSha = validateCommitSha(input.baseSha);
  if (input.runIdentity.trim() === "" || input.runIdentity.includes("\0")) {
    throw new Error("A stable GitHub run identity is required for Issue -> PR");
  }
  const key = fingerprint(
    [
      input.owner.toLowerCase(),
      input.repo.toLowerCase(),
      String(input.issueNumber),
      input.runIdentity,
    ],
    24,
  );
  const snapshotFingerprint = fingerprint([input.issueState, input.issueUpdatedAt, baseSha], 24);
  const commitMessage = [
    `feat: implement #${String(input.issueNumber)}`,
    "",
    `DSH-Operation-Key: ${key}`,
    `DSH-Issue-Snapshot: ${snapshotFingerprint}`,
  ].join("\n");
  return {
    key,
    snapshotFingerprint,
    branch: buildDshBranch(input.issueNumber, "implement", key),
    commitMessage,
    pullRequestMarker: `<!-- dsh-action:implement:v1 operation=${key} snapshot=${snapshotFingerprint} -->`,
  };
}

/**
 * Recognize an orphaned branch from a prior attempt only when its parent and
 * controller-owned commit trailers match this exact operation and issue snapshot.
 */
export async function findReconciledImplementationCommit(
  client: GitHubClient,
  owner: string,
  repo: string,
  operation: ImplementationOperation,
  expectedBaseSha: string,
): Promise<string | null> {
  const head = await getBranchHeadIfExists(client, owner, repo, operation.branch);
  if (head === null) return null;

  const baseSha = validateCommitSha(expectedBaseSha);
  const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: head });
  const parents = commit.data.parents;
  if (
    commit.data.sha !== head ||
    commit.data.message !== operation.commitMessage ||
    parents.length !== 1 ||
    parents[0]?.sha !== baseSha
  ) {
    throw new Error(
      "Stable implementation branch already exists but does not belong to this operation snapshot",
    );
  }
  return head;
}

function hasCommitTrailer(message: string, name: string, value: string): boolean {
  return message.split(/\r?\n/u).includes(`${name}: ${value}`);
}

/** Authenticate a completed operation without requiring its now-stale issue snapshot. */
export async function assertImplementationCommitOwned(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  operationKey: string,
  snapshotFingerprint: string,
): Promise<void> {
  if (!/^[a-f0-9]{24}$/u.test(operationKey)) throw new Error("Invalid operation key");
  if (!/^[a-f0-9]{24}$/u.test(snapshotFingerprint)) {
    throw new Error("Invalid issue snapshot fingerprint");
  }
  const expectedSha = validateCommitSha(sha);
  const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: expectedSha });
  if (
    commit.data.sha !== expectedSha ||
    commit.data.parents.length !== 1 ||
    !hasCommitTrailer(commit.data.message, "DSH-Operation-Key", operationKey) ||
    !hasCommitTrailer(commit.data.message, "DSH-Issue-Snapshot", snapshotFingerprint)
  ) {
    throw new Error("Existing implementation pull request is not owned by this operation");
  }
}

/** Ensure an orphaned stable branch contains exactly the newly generated tree. */
export async function assertEquivalentImplementationCommit(
  client: GitHubClient,
  owner: string,
  repo: string,
  existingSha: string,
  candidateSha: string,
  operation: ImplementationOperation,
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
    throw new Error(
      "Stable implementation branch differs from the current verified workspace; refusing reuse",
    );
  }
}
