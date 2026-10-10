import type { DshRunResult } from "../dsh/runner.js";
import type { GitHubClient } from "../github/client.js";
import { upsertTrackingComment } from "../github/comments.js";
import { createTrackingMarker, stripTrackingMarkers } from "../review/tracking.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import { validateCommitSha } from "../security/refs.js";

import type { BoundIssueIdentity } from "../write/issue.js";
import { buildAutomationTaskOperation } from "../write/task.js";
import type { WorkspaceSnapshot } from "../write/workspace.js";
import {
  executeValidatedRepositoryWrite,
  type ControllerWriteControl,
} from "../write/transaction.js";

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

export interface FinishAutomationTaskInput extends ControllerWriteControl {
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
  readonly branchPrefix?: string;
  readonly branchNameTemplate?: string;
  readonly relatedIssue?: {
    readonly number: number;
    readonly identity: BoundIssueIdentity;
  };
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
    ...(input.branchPrefix === undefined ? {} : { branchPrefix: input.branchPrefix }),
    ...(input.branchNameTemplate === undefined
      ? {}
      : { branchNameTemplate: input.branchNameTemplate }),
    ...(input.relatedIssue === undefined ? {} : { entityNumber: input.relatedIssue.number }),
  });

  const summary = sanitizeUntrustedText(stripTrackingMarkers(input.result.output.summary)).slice(
    0,
    40_000,
  );
  return await executeValidatedRepositoryWrite({
    client: input.client,
    repository: { owner: input.owner, repo: input.repo },
    workspace: input.snapshot,
    plan: {
      kind: "new-pr",
      operationKind: "task",
      target: {
        branch: input.baseBranch,
        sha: baseSha,
        ...(input.relatedIssue === undefined ? {} : { issue: input.relatedIssue }),
      },
      operation,
      publication: {
        title: `DSH task: ${summary.replace(/[\r\n]+/gu, " ").slice(0, 220)}`,
        body: [
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
      },
    },
    validation: {
      runTests: input.runTests,
      commands: input.testCommands,
      containerImage: input.containerImage,
    },
    control: input,
  });
}
