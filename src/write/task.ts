import { createHash } from "node:crypto";

import { validateCommitSha } from "../security/refs.js";
import { buildControllerBranchName } from "./branch.js";
import type { BranchWriteOperation } from "./operation-commit.js";

export type AutomationTaskOperation = BranchWriteOperation;
function fingerprint(parts: readonly string[], length = 24): string {
  return createHash("sha256").update(parts.join("\0"), "utf8").digest("hex").slice(0, length);
}

export function buildAutomationTaskOperation(input: {
  readonly owner: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly runIdentity: string;
  readonly taskIdentity: string;
  readonly branchPrefix?: string;
  readonly branchNameTemplate?: string;
  readonly entityNumber?: number;
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
  if (
    input.entityNumber !== undefined &&
    (!Number.isSafeInteger(input.entityNumber) || input.entityNumber < 1)
  ) {
    throw new Error("Task entity number must be a positive integer");
  }
  const branch = buildControllerBranchName({
    ...(input.branchPrefix === undefined ? {} : { branchPrefix: input.branchPrefix }),
    ...(input.branchNameTemplate === undefined
      ? {}
      : { branchNameTemplate: input.branchNameTemplate }),
    key,
    operation: "task",
    entityType: input.entityNumber === undefined ? "task" : "issue",
    entityNumber: input.entityNumber === undefined ? "task" : String(input.entityNumber),
    legacySuffix: `task-${key}`,
  });
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
