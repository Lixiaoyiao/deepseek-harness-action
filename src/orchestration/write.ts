import type { AuthorizedRun } from "./prepare.js";
import { finishImplementation } from "../commands/implement.js";
import { finishAutomationTask } from "../commands/task.js";
import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import type { WorkspaceSnapshot } from "../write/workspace.js";
import { issueTaskIdentity, resolveBaseBranch, runUrl } from "./context.js";

export interface WriteOutcome {
  readonly writeStatus: "success" | "partial-success";
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}

/** Route an already-authorized result to the matching Controller write finalizer. */
export interface ExecuteWriteOptions {
  readonly authorized: Pick<
    AuthorizedRun,
    "client" | "context" | "command" | "policy" | "snapshot" | "revalidateAuthority"
  >;
  readonly inputs: ActionInputs;
  readonly workspaceCopy: WorkspaceSnapshot;
  readonly boundWriteSha: string;
  readonly agentResult: DshRunResult;
  readonly validationDeadlineMs: number;
  readonly taskIdentity: string;
  readonly onPhase: (phase: "validation" | "write") => void;
  readonly onValidationPassed: () => void;
  readonly signal?: AbortSignal;
}

export async function executeWrite(options: ExecuteWriteOptions): Promise<WriteOutcome> {
  const {
    authorized,
    inputs,
    workspaceCopy,
    boundWriteSha,
    agentResult,
    validationDeadlineMs,
    taskIdentity,
    onPhase,
    onValidationPassed,
    signal,
  } = options;
  const { client, context, command, policy, snapshot, revalidateAuthority } = authorized;
  throwIfCancelled(signal);
  const baseBranch = resolveBaseBranch(context, inputs.baseBranch);
  const requireBaseBranch = (): string => {
    if (baseBranch === undefined) {
      throw new Error("A repository base branch is required for pull-request creation");
    }
    return baseBranch;
  };
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
      baseBranch: requireBaseBranch(),
      snapshot: workspaceCopy,
      boundHeadSha: boundWriteSha,
      operationKey: context.runId,
      result: agentResult,
      inputs,
      validationDeadlineMs,
      ...(signal === undefined ? {} : { signal }),
      onPhase,
      revalidateAuthority,
      onValidationPassed,
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
      baseBranch: requireBaseBranch(),
      boundHeadSha: boundWriteSha,
      runIdentity: context.runId,
      taskIdentity: issueTaskIdentity(taskIdentity, snapshot),
      snapshot: workspaceCopy,
      result: agentResult,
      runUrl: runUrl(context),
      runTests: inputs.runTests,
      testCommands: inputs.testCommands,
      containerImage: inputs.containerImage,
      branchPrefix: inputs.branchPrefix,
      branchNameTemplate: inputs.branchNameTemplate,
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
      revalidateAuthority,
      onValidationPassed,
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
      revalidateAuthority,
      onValidationPassed,
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
      baseBranch: requireBaseBranch(),
      boundHeadSha: boundWriteSha,
      runIdentity: context.runId,
      taskIdentity,
      snapshot: workspaceCopy,
      result: agentResult,
      runUrl: runUrl(context),
      runTests: inputs.runTests,
      testCommands: inputs.testCommands,
      containerImage: inputs.containerImage,
      branchPrefix: inputs.branchPrefix,
      branchNameTemplate: inputs.branchNameTemplate,
      validationDeadlineMs,
      ...(signal === undefined ? {} : { signal }),
      onPhase,
      revalidateAuthority,
      onValidationPassed,
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
