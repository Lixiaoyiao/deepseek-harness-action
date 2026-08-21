import type { DshRunResult } from "../dsh/runner.js";
import type { GitHubClient } from "../github/client.js";
import { upsertTrackingComment } from "../github/comments.js";
import { createTrackingMarker, stripTrackingMarkers } from "../review/tracking.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import { validateCommitSha } from "../security/refs.js";
import { revalidateIssueIdentity, type BoundIssueIdentity } from "../write/issue.js";
import {
  assertRemoteBranchHead,
  createGitHubCommitFromWorkspace,
  createRemoteBranch,
} from "../write/github.js";
import { createPullRequest, findTaskPullRequestByOperationKey } from "../write/pr.js";
import {
  assertEquivalentTaskCommit,
  assertTaskCommitOwned,
  buildAutomationTaskOperation,
  findReconciledTaskCommit,
} from "../write/task.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
} from "../write/validate.js";
import type { WorkspaceSnapshot } from "../write/workspace.js";

export async function publishTaskAnswer(
  client: GitHubClient,
  target: { owner: string; repo: string; issueNumber: number },
  expectedAuthorId: number,
  result: DshRunResult,
  runUrl: string,
): Promise<number> {
  const summary = sanitizeUntrustedText(stripTrackingMarkers(result.output.summary)).slice(
    0,
    60_000,
  );
  const body = [
    createTrackingMarker({ kind: "task" }),
    "## DeepSeek Harness task",
    "",
    summary,
    "",
    `<sub>[Workflow run](${runUrl}) · dsh-action</sub>`,
  ].join("\n");
  return await upsertTrackingComment(client, target, expectedAuthorId, "task", body);
}

export interface FinishAutomationTaskInput {
  readonly client: GitHubClient;
  readonly owner: string;
  readonly repo: string;
  readonly baseBranch: string;
  readonly boundHeadSha: string;
  readonly runIdentity: string;
  readonly taskIdentity: string;
  readonly snapshot: WorkspaceSnapshot;
  readonly result: DshRunResult;
  readonly runUrl: string;
  readonly runTests: boolean;
  readonly testCommands: readonly (readonly string[])[];
  readonly containerImage: string;
  readonly validationTimeoutMs: number;
  readonly relatedIssue?: {
    readonly number: number;
    readonly identity: BoundIssueIdentity;
  };
  readonly onPhase?: (phase: "validation" | "write") => void;
}

export async function finishAutomationTask(input: FinishAutomationTaskInput): Promise<{
  branch: string;
  pullNumber: number;
  url: string;
}> {
  const baseSha = validateCommitSha(input.boundHeadSha);
  const operation = buildAutomationTaskOperation({
    owner: input.owner,
    repo: input.repo,
    baseSha,
    runIdentity: input.runIdentity,
    taskIdentity: input.taskIdentity,
  });

  const completed = await findTaskPullRequestByOperationKey(
    input.client,
    input.owner,
    input.repo,
    operation.branch,
    input.baseBranch,
    operation.key,
  );
  if (completed !== null) {
    await assertTaskCommitOwned(
      input.client,
      input.owner,
      input.repo,
      completed.headSha,
      operation.key,
      completed.snapshotFingerprint,
    );
    return { branch: operation.branch, pullNumber: completed.number, url: completed.url };
  }
  let commitSha = await findReconciledTaskCommit(
    input.client,
    input.owner,
    input.repo,
    operation,
    baseSha,
  );

  await revalidateAutomationTask(input, baseSha);
  input.onPhase?.("validation");
  assertWriteValidationConfigured(input.runTests, input.testCommands);
  const tests = await runValidationCommandsInDocker(
    input.snapshot.workerRoot,
    input.testCommands,
    input.containerImage,
    input.validationTimeoutMs,
  );
  assertValidationSucceeded(tests);

  input.onPhase?.("write");
  await revalidateAutomationTask(input, baseSha);
  const commit = await createGitHubCommitFromWorkspace(
    input.client,
    {
      owner: input.owner,
      repo: input.repo,
      baseSha,
      message: operation.commitMessage,
    },
    input.snapshot,
  );
  await revalidateAutomationTask(input, baseSha);
  if (commitSha === null) {
    commitSha = commit.sha;
    await createRemoteBranch(input.client, input.owner, input.repo, operation.branch, commitSha);
  } else {
    await assertEquivalentTaskCommit(
      input.client,
      input.owner,
      input.repo,
      commitSha,
      commit.sha,
      operation,
      baseSha,
    );
  }
  await assertRemoteBranchHead(input.client, input.owner, input.repo, operation.branch, commitSha);
  await revalidateAutomationTask(input, baseSha);

  const summary = sanitizeUntrustedText(stripTrackingMarkers(input.result.output.summary)).slice(
    0,
    40_000,
  );
  const pull = await createPullRequest(
    input.client,
    input.owner,
    input.repo,
    operation.branch,
    input.baseBranch,
    `DSH task: ${summary.replace(/[\r\n]+/gu, " ").slice(0, 220)}`,
    [
      operation.pullRequestMarker,
      summary,
      "",
      "Validation: configured commands passed.",
      ...(input.relatedIssue === undefined
        ? []
        : ["", `Related to #${String(input.relatedIssue.number)}.`]),
      "",
      `<sub>[Workflow run](${input.runUrl}) · dsh-action</sub>`,
    ].join("\n"),
    operation.pullRequestMarker,
  );
  return { branch: operation.branch, pullNumber: pull.number, url: pull.url };
}

async function revalidateAutomationTask(
  input: FinishAutomationTaskInput,
  baseSha: string,
): Promise<void> {
  await assertRemoteBranchHead(input.client, input.owner, input.repo, input.baseBranch, baseSha);
  if (input.relatedIssue !== undefined) {
    await revalidateIssueIdentity(
      input.client,
      input.owner,
      input.repo,
      input.relatedIssue.number,
      input.relatedIssue.identity,
    );
  }
}
