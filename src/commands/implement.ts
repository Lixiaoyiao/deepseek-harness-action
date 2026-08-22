import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import type { GitHubClient } from "../github/client.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import {
  assertRemoteBranchHead,
  createGitHubCommitFromWorkspace,
  createRemoteBranch,
} from "../write/github.js";
import {
  assertEquivalentImplementationCommit,
  assertImplementationCommitOwned,
  buildImplementationOperation,
  findReconciledImplementationCommit,
} from "../write/implementation.js";
import { revalidateIssueIdentity, type BoundIssueIdentity } from "../write/issue.js";
import { createPullRequest, findPullRequestByOperationKey } from "../write/pr.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
} from "../write/validate.js";
import type { WorkspaceSnapshot } from "../write/workspace.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import { stripTrackingMarkers } from "../review/tracking.js";
import {
  remainingValidationMs,
  withinValidationDeadline,
  type ValidationDeadline,
} from "../write/validation-deadline.js";

export interface FinishImplementationInput {
  readonly client: GitHubClient;
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueTitle: string;
  readonly issueIdentity: BoundIssueIdentity;
  readonly baseBranch: string;
  readonly snapshot: WorkspaceSnapshot;
  readonly boundHeadSha: string;
  readonly operationKey: string;
  readonly result: DshRunResult;
  readonly inputs: ActionInputs;
  readonly validationDeadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: "validation" | "write") => void;
}

export async function finishImplementation(
  input: FinishImplementationInput,
): Promise<{ branch: string; pullNumber: number; url: string }> {
  const validation: ValidationDeadline = {
    deadlineMs: input.validationDeadlineMs ?? Date.now() + 10 * 60_000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  input.onPhase?.("validation");
  const operation = buildImplementationOperation({
    owner: input.owner,
    repo: input.repo,
    issueNumber: input.issueNumber,
    issueState: input.issueIdentity.state,
    issueContentFingerprint: input.issueIdentity.contentFingerprint,
    baseSha: input.boundHeadSha,
    runIdentity: input.operationKey,
    branchPrefix: input.inputs.branchPrefix,
    branchNameTemplate: input.inputs.branchNameTemplate,
  });

  // A completed prior attempt is success, not another write. It may have caused
  // issue/base metadata to advance, so authenticate it by stable operation key.
  const completed = await withinValidationDeadline(
    async () =>
      findPullRequestByOperationKey(
        input.client,
        input.owner,
        input.repo,
        operation.branch,
        input.baseBranch,
        operation.key,
      ),
    validation,
  );
  if (completed !== null) {
    await withinValidationDeadline(
      async () =>
        assertImplementationCommitOwned(
          input.client,
          input.owner,
          input.repo,
          completed.headSha,
          operation.key,
          completed.snapshotFingerprint,
        ),
      validation,
    );
    return { branch: operation.branch, pullNumber: completed.number, url: completed.url };
  }

  let commitSha = await withinValidationDeadline(
    async () =>
      findReconciledImplementationCommit(
        input.client,
        input.owner,
        input.repo,
        operation,
        input.boundHeadSha,
      ),
    validation,
  );
  await withinValidationDeadline(async () => revalidateForImplementation(input), validation);
  assertWriteValidationConfigured(input.inputs.runTests, input.inputs.testCommands);
  const tests = await withinValidationDeadline(
    async () =>
      runValidationCommandsInDocker(
        input.snapshot.workerRoot,
        input.inputs.testCommands,
        input.inputs.containerImage,
        remainingValidationMs(validation),
        undefined,
        input.signal,
      ),
    validation,
  );
  assertValidationSucceeded(tests);
  throwIfCancelled(input.signal);
  await withinValidationDeadline(async () => revalidateForImplementation(input), validation);
  throwIfCancelled(input.signal);
  input.onPhase?.("write");

  // After Git object creation begins, preserve the idempotent reconciliation
  // path so cancellation cannot leave an avoidable half-written operation.
  const candidate = await createGitHubCommitFromWorkspace(
    input.client,
    {
      owner: input.owner,
      repo: input.repo,
      baseSha: input.boundHeadSha,
      message: operation.commitMessage,
    },
    input.snapshot,
  );
  await revalidateForImplementation(input);
  if (commitSha === null) {
    commitSha = candidate.sha;
    await revalidateForImplementation(input);
    await createRemoteBranch(input.client, input.owner, input.repo, operation.branch, commitSha);
  } else {
    await assertEquivalentImplementationCommit(
      input.client,
      input.owner,
      input.repo,
      commitSha,
      candidate.sha,
      operation,
      input.boundHeadSha,
    );
  }

  await assertRemoteBranchHead(input.client, input.owner, input.repo, operation.branch, commitSha);
  await revalidateForImplementation(input);
  const body = [
    operation.pullRequestMarker,
    sanitizeUntrustedText(stripTrackingMarkers(input.result.output.summary)).slice(0, 40_000),
    "",
    "Validation: configured commands passed.",
    "",
    `Closes #${String(input.issueNumber)}`,
    "",
    "Created by dsh-action.",
  ].join("\n");
  const pull = await createPullRequest(
    input.client,
    input.owner,
    input.repo,
    operation.branch,
    input.baseBranch,
    `Implement #${String(input.issueNumber)}: ${sanitizeUntrustedText(input.issueTitle).replace(/[\r\n]+/gu, " ")}`.slice(
      0,
      250,
    ),
    body,
    operation.pullRequestMarker,
  );
  return { branch: operation.branch, pullNumber: pull.number, url: pull.url };
}

async function revalidateForImplementation(input: FinishImplementationInput): Promise<void> {
  await assertRemoteBranchHead(
    input.client,
    input.owner,
    input.repo,
    input.baseBranch,
    input.boundHeadSha,
  );
  await revalidateIssueIdentity(
    input.client,
    input.owner,
    input.repo,
    input.issueNumber,
    input.issueIdentity,
  );
}
