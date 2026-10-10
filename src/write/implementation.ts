import { createHash } from "node:crypto";

import { validateCommitSha } from "../security/refs.js";
import { buildDshBranch } from "./branch.js";
import type { BranchWriteOperation } from "./operation-commit.js";

export type ImplementationOperation = BranchWriteOperation;
interface BuildImplementationOperationInput {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueState: string;
  readonly issueContentFingerprint: string;
  readonly baseSha: string;
  /** GITHUB_RUN_ID: stable across attempts of the same workflow run. */
  readonly runIdentity: string;
  readonly branchPrefix?: string;
  readonly branchNameTemplate?: string;
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
  if (!/^[a-f0-9]{64}$/u.test(input.issueContentFingerprint)) {
    throw new Error("A valid issue content fingerprint is required for Issue -> PR");
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
  const snapshotFingerprint = fingerprint(
    [input.issueState, input.issueContentFingerprint, baseSha],
    24,
  );
  const commitMessage = [
    `feat: implement #${String(input.issueNumber)}`,
    "",
    `DSH-Operation-Key: ${key}`,
    `DSH-Issue-Snapshot: ${snapshotFingerprint}`,
  ].join("\n");
  return {
    key,
    snapshotFingerprint,
    branch: buildDshBranch(input.issueNumber, "implement", key, {
      ...(input.branchPrefix === undefined ? {} : { branchPrefix: input.branchPrefix }),
      ...(input.branchNameTemplate === undefined
        ? {}
        : { branchNameTemplate: input.branchNameTemplate }),
    }),
    commitMessage,
    pullRequestMarker: `<!-- dsh-action:implement:v1 operation=${key} snapshot=${snapshotFingerprint} -->`,
  };
}
