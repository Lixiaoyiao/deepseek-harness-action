import * as core from "@actions/core";

import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import type { GitHubClient } from "../github/client.js";
import { publishStatusComment } from "../github/status.js";
import { revalidatePullRequestIdentity, type BoundPullRequestIdentity } from "../write/pr.js";
import {
  assertRemoteBranchHead,
  createGitHubCommitFromWorkspace,
  updateRemoteBranch,
} from "../write/github.js";
import { assertValidationSucceeded, runValidationCommandsInDocker } from "../write/validate.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "../write/workspace.js";

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
  readonly onPhase?: (phase: "validation" | "write") => void;
}

export async function finishFix(input: FinishFixInput): Promise<{
  commitSha: string;
  paths: readonly string[];
  status: "success" | "partial-success";
}> {
  input.onPhase?.("validation");
  await revalidatePullRequestIdentity(
    input.client,
    input.target.owner,
    input.target.repo,
    input.target.issueNumber,
    input.identity,
  );
  const changes = await inspectWorkspaceChanges(input.snapshot);
  if (changes.all.length === 0) throw new Error("DSH reported a fix but produced no file changes");

  if (input.inputs.runTests && input.inputs.testCommands.length === 0) {
    throw new Error(
      "run-tests is true but test-commands is empty; set run-tests=false for an explicit unverified write",
    );
  }
  const verified = input.inputs.runTests;
  if (verified) {
    const tests = await runValidationCommandsInDocker(
      input.snapshot.workerRoot,
      input.inputs.testCommands,
      input.inputs.containerImage,
    );
    assertValidationSucceeded(tests);
  }

  input.onPhase?.("write");
  await revalidatePullRequestIdentity(
    input.client,
    input.target.owner,
    input.target.repo,
    input.target.issueNumber,
    input.identity,
  );
  const created = await createGitHubCommitFromWorkspace(
    input.client,
    {
      owner: input.target.owner,
      repo: input.target.repo,
      baseSha: input.boundHeadSha,
      message: "fix: apply DeepSeek Harness fix",
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
      verified ? "DeepSeek Harness fix prepared" : "DeepSeek Harness fix prepared (unverified)",
      `${input.result.output.summary}\n\n${verified ? "Configured validation passed." : "No validation commands were configured; this change is unverified."}\n\nCommit: \`${created.sha}\`\n\nChanged: ${created.paths.map((path) => `\`${path}\``).join(", ")}`,
      input.runUrl,
    );
    return { commitSha: created.sha, paths: created.paths, status: "success" };
  } catch {
    // The branch update is the authoritative write. A later comment failure
    // must not turn an already-pushed fix into a failed/retried mutation.
    core.warning(
      `Partial success: fix commit ${created.sha} was pushed, but its GitHub status comment could not be published.`,
    );
    try {
      await core.summary
        .addHeading("DeepSeek Harness fix: partial success", 2)
        .addRaw(
          `Fix commit \`${created.sha}\` was pushed, but the status comment could not be published.`,
        )
        .write();
    } catch {
      core.warning("The partial-success step summary could not be published either.");
    }
    return { commitSha: created.sha, paths: created.paths, status: "partial-success" };
  }
}
