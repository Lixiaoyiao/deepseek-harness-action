import * as core from "@actions/core";

import type { DshRunResult } from "../dsh/runner.js";
import type { ActionInputs } from "../inputs.js";
import type { GitHubClient } from "../github/client.js";
import { publishStatusComment } from "../github/status.js";
import type { BoundPullRequestIdentity } from "../write/pr.js";
import type { WorkspaceSnapshot } from "../write/workspace.js";
import {
  executeValidatedRepositoryWrite,
  type ControllerWriteControl,
} from "../write/transaction.js";
export interface FinishFixInput extends ControllerWriteControl {
  readonly client: GitHubClient;
  readonly target: { owner: string; repo: string; issueNumber: number };
  readonly expectedAuthorId: number;
  readonly snapshot: WorkspaceSnapshot;
  readonly identity: BoundPullRequestIdentity;
  readonly result: DshRunResult;
  readonly inputs: ActionInputs;
  readonly runUrl: string;
}

export async function finishFix(input: FinishFixInput): Promise<{
  commitSha: string;
  paths: readonly string[];
  status: "success" | "partial-success";
}> {
  const task = input.result.output.operation === "task";
  const label = task ? "task" : "fix";
  const created = await executeValidatedRepositoryWrite({
    client: input.client,
    repository: { owner: input.target.owner, repo: input.target.repo },
    workspace: input.snapshot,
    plan: {
      kind: "pr-head",
      target: { number: input.target.issueNumber, identity: input.identity },
      commitMessage: task ? "feat: apply DeepSeek Harness task" : "fix: apply DeepSeek Harness fix",
    },
    validation: {
      runTests: input.inputs.runTests,
      commands: input.inputs.testCommands,
      containerImage: input.inputs.containerImage,
    },
    control: input,
  });
  try {
    await publishStatusComment(
      input.client,
      input.target,
      input.expectedAuthorId,
      `DeepSeek Harness ${label} prepared`,
      `${input.result.output.summary}\n\nConfigured validation passed.\n\nCommit: \`${created.commitSha}\`\n\nChanged: ${created.paths.map((path) => `\`${path}\``).join(", ")}`,
      input.runUrl,
      task ? "task" : "write",
    );
    return { commitSha: created.commitSha, paths: created.paths, status: "success" };
  } catch {
    // The branch update is the authoritative write. A later comment failure
    // must not turn an already-pushed fix into a failed/retried mutation.
    core.warning(
      `Partial success: ${label} commit ${created.commitSha} was pushed, but its GitHub status comment could not be published.`,
    );
    try {
      await core.summary
        .addHeading(`DeepSeek Harness ${label}: partial success`, 2)
        .addRaw(
          `${task ? "Task" : "Fix"} commit \`${created.commitSha}\` was pushed, but the status comment could not be published.`,
        )
        .write();
    } catch {
      core.warning("The partial-success step summary could not be published either.");
    }
    return { commitSha: created.commitSha, paths: created.paths, status: "partial-success" };
  }
}
