import { finishImplementation } from "../commands/implement.js";
import type { RoutedCommand } from "../commands/router.js";
import { finishAutomationTask } from "../commands/task.js";
import type { DshRunResult } from "../dsh/runner.js";
import type { GitHubClient } from "../github/client.js";
import type { GitHubContext } from "../github/context.js";
import type { EntitySnapshot } from "../github/fetch.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import type { SecurityPolicy } from "../security/policy.js";
import type { WorkspaceSnapshot } from "../write/workspace.js";
import { issueTaskIdentity, runUrl } from "./context.js";

export interface WriteOutcome {
  readonly writeStatus: "success" | "partial-success";
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}

/** Route an already-authorized result to the matching Controller write finalizer. */
export async function executeWrite(
  client: GitHubClient,
  context: GitHubContext,
  command: RoutedCommand,
  inputs: ActionInputs,
  policy: SecurityPolicy,
  snapshot: EntitySnapshot | undefined,
  workspaceCopy: WorkspaceSnapshot,
  boundWriteSha: string,
  agentResult: DshRunResult,
  validationDeadlineMs: number,
  taskIdentity: string,
  onPhase: (phase: "validation" | "write") => void,
  signal?: AbortSignal,
): Promise<WriteOutcome> {
  throwIfCancelled(signal);
  if (
    command.operation === "implement" &&
    snapshot?.kind === "issue" &&
    policy.capabilities.createPullRequest
  ) {
    const result = await finishImplementation({
      client,
      owner: context.repository.owner,
      repo: context.repository.repo,
      issueNumber: snapshot.number,
      issueTitle: snapshot.title,
      issueIdentity: {
        state: snapshot.state,
        updatedAt: snapshot.updatedAt,
        contentFingerprint: snapshot.contentFingerprint,
      },
      baseBranch: context.repository.defaultBranch ?? "main",
      snapshot: workspaceCopy,
      boundHeadSha: boundWriteSha,
      operationKey: context.runId,
      result: agentResult,
      inputs,
      validationDeadlineMs,
      ...(signal === undefined ? {} : { signal }),
      onPhase,
    });
    return {
      writeStatus: "success",
      branchName: result.branch,
      pullRequestNumber: result.pullNumber,
      pullRequestUrl: result.url,
    };
  }
  if (
    command.operation === "task" &&
    snapshot?.kind === "issue" &&
    policy.capabilities.createPullRequest
  ) {
    const result = await finishAutomationTask({
      client,
      owner: context.repository.owner,
      repo: context.repository.repo,
      baseBranch: context.repository.defaultBranch ?? "main",
      boundHeadSha: boundWriteSha,
      runIdentity: context.runId,
      taskIdentity: issueTaskIdentity(taskIdentity, snapshot),
      snapshot: workspaceCopy,
      result: agentResult,
      runUrl: runUrl(context),
      runTests: inputs.runTests,
      testCommands: inputs.testCommands,
      containerImage: inputs.containerImage,
      validationDeadlineMs,
      ...(signal === undefined ? {} : { signal }),
      relatedIssue: {
        number: snapshot.number,
        identity: {
          state: snapshot.state,
          updatedAt: snapshot.updatedAt,
          contentFingerprint: snapshot.contentFingerprint,
        },
      },
      onPhase,
    });
    return {
      writeStatus: "success",
      branchName: result.branch,
      pullRequestNumber: result.pullNumber,
      pullRequestUrl: result.url,
    };
  }
  // Same-repository PR fixes are committed through the controller's GitHub API
  // after one final immutable-head check; DSH never receives that credential.
  if (
    snapshot?.kind === "pull_request" &&
    policy.capabilities.modifyWorkspace &&
    policy.capabilities.commit &&
    policy.capabilities.push
  ) {
    const { finishFix } = await import("../commands/fix.js");
    const result = await finishFix({
      client,
      target: {
        owner: context.repository.owner,
        repo: context.repository.repo,
        issueNumber: snapshot.number,
      },
      expectedAuthorId: inputs.botUserId,
      snapshot: workspaceCopy,
      boundHeadSha: snapshot.headSha,
      headBranch: snapshot.headRef,
      identity: {
        headSha: snapshot.headSha,
        headRef: snapshot.headRef,
        headRepositoryId: snapshot.headRepositoryId ?? -1,
        baseRepositoryId: snapshot.baseRepositoryId,
      },
      result: agentResult,
      inputs,
      runUrl: runUrl(context),
      validationDeadlineMs,
      ...(signal === undefined ? {} : { signal }),
      onPhase,
    });
    return {
      writeStatus: result.status,
      commitSha: result.commitSha,
      changedPaths: result.paths,
    };
  }
  if (
    command.operation === "task" &&
    snapshot === undefined &&
    context.kind === "automation" &&
    policy.capabilities.createPullRequest
  ) {
    const result = await finishAutomationTask({
      client,
      owner: context.repository.owner,
      repo: context.repository.repo,
      baseBranch: context.repository.defaultBranch ?? "main",
      boundHeadSha: boundWriteSha,
      runIdentity: context.runId,
      taskIdentity,
      snapshot: workspaceCopy,
      result: agentResult,
      runUrl: runUrl(context),
      runTests: inputs.runTests,
      testCommands: inputs.testCommands,
      containerImage: inputs.containerImage,
      validationDeadlineMs,
      ...(signal === undefined ? {} : { signal }),
      onPhase,
    });
    return {
      writeStatus: "success",
      branchName: result.branch,
      pullRequestNumber: result.pullNumber,
      pullRequestUrl: result.url,
    };
  }
  throw new Error("The resolved entity does not support this write operation");
}
