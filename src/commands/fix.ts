import * as core from "@actions/core";

import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import type { GitHubClient } from "../github/client.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { publishStatusComment } from "../github/status.js";
import { revalidatePullRequestIdentity, type BoundPullRequestIdentity } from "../write/pr.js";
import {
  assertRemoteBranchHead,
  createGitHubCommitFromWorkspace,
  updateRemoteBranch,
} from "../write/github.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
} from "../write/validate.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "../write/workspace.js";
import {
  remainingValidationMs,
  withinValidationDeadline,
  type ValidationDeadline,
} from "../write/validation-deadline.js";

export interface FinishFixInput {
  readonly client: GitHubClient;
  readonly target: { owner: string; repo: string; issueNumber: number };
  readonly expectedAuthorId: number;
  readonly snapshot: WorkspaceSnapshot;
  readonly boundHeadSha: string;
  readonly headBranch: string;
  readonly identity: BoundPullRequestIdentity;
  readonly result: DshRunResult;
  readonly inputs: ActionInputs;
  readonly runUrl: string;
  readonly validationDeadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: "validation" | "write") => void;
}

export async function finishFix(input: FinishFixInput): Promise<{
  commitSha: string;
  paths: readonly string[];
  status: "success" | "partial-success";
}> {
  const task = input.result.output.operation === "task";
  const label = task ? "task" : "fix";
  const validation: ValidationDeadline = {
    deadlineMs: input.validationDeadlineMs ?? Date.now() + 10 * 60_000,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
  input.onPhase?.("validation");
  await withinValidationDeadline(
    async () =>
      revalidatePullRequestIdentity(
        input.client,
        input.target.owner,
        input.target.repo,
        input.target.issueNumber,
        input.identity,
      ),
    validation,
  );
  const changes = await withinValidationDeadline(
    async () => inspectWorkspaceChanges(input.snapshot),
    validation,
  );
  if (changes.all.length === 0) {
    throw new Error(`DSH reported a ${label} but produced no file changes`);
  }

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

  input.onPhase?.("write");
  await withinValidationDeadline(
    async () =>
      revalidatePullRequestIdentity(
        input.client,
        input.target.owner,
        input.target.repo,
        input.target.issueNumber,
        input.identity,
      ),
    validation,
  );
  throwIfCancelled(input.signal);
  // Crossing this boundary may create Git objects. Complete the existing
  // reconcile/update sequence even if cancellation arrives afterwards.
  const created = await createGitHubCommitFromWorkspace(
    input.client,
    {
      owner: input.target.owner,
      repo: input.target.repo,
      baseSha: input.boundHeadSha,
      message: task ? "feat: apply DeepSeek Harness task" : "fix: apply DeepSeek Harness fix",
    },
    input.snapshot,
  );
  await revalidatePullRequestIdentity(
    input.client,
    input.target.owner,
    input.target.repo,
    input.target.issueNumber,
    input.identity,
  );
  await assertRemoteBranchHead(
    input.client,
    input.target.owner,
    input.target.repo,
    input.headBranch,
    input.boundHeadSha,
  );
  await updateRemoteBranch(
    input.client,
    input.target.owner,
    input.target.repo,
    input.headBranch,
    created.sha,
  );
  try {
    await publishStatusComment(
      input.client,
      input.target,
      input.expectedAuthorId,
      `DeepSeek Harness ${label} prepared`,
      `${input.result.output.summary}\n\nConfigured validation passed.\n\nCommit: \`${created.sha}\`\n\nChanged: ${created.paths.map((path) => `\`${path}\``).join(", ")}`,
      input.runUrl,
      task ? "task" : "write",
    );
    return { commitSha: created.sha, paths: created.paths, status: "success" };
  } catch {
    // The branch update is the authoritative write. A later comment failure
    // must not turn an already-pushed fix into a failed/retried mutation.
    core.warning(
      `Partial success: ${label} commit ${created.sha} was pushed, but its GitHub status comment could not be published.`,
    );
    try {
      await core.summary
        .addHeading(`DeepSeek Harness ${label}: partial success`, 2)
        .addRaw(
          `${task ? "Task" : "Fix"} commit \`${created.sha}\` was pushed, but the status comment could not be published.`,
        )
        .write();
    } catch {
      core.warning("The partial-success step summary could not be published either.");
    }
    return { commitSha: created.sha, paths: created.paths, status: "partial-success" };
  }
}
