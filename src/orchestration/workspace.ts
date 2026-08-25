import * as core from "@actions/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PolicyDeniedError } from "../errors.js";
import type { GitHubClient } from "../github/client.js";
import type { parseGitHubContext } from "../github/context.js";
import type { EntitySnapshot } from "../github/fetch.js";
import { materializeRepositoryAtSha } from "../github/repository.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, settleWithin } from "../lifecycle/deadline.js";
import type { SecurityPolicy } from "../security/policy.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "../write/workspace.js";
import { requireWorkspace } from "./context.js";

type GitHubContext = ReturnType<typeof parseGitHubContext>;

export interface PreparedWorkspace {
  readonly tempRoot: string;
  readonly agentWorkspace: string;
  readonly snapshot?: WorkspaceSnapshot;
  readonly boundWriteSha?: string;
}

async function removeTemporaryWorkspace(tempRoot: string): Promise<void> {
  try {
    const cleanup = await settleWithin(
      rm(tempRoot, { recursive: true, force: true }),
      PHASE_TIMEOUTS.cleanupMs,
    );
    if (!cleanup.settled) {
      core.warning("The temporary DeepSeek Harness workspace cleanup timed out.");
    }
  } catch {
    // Cleanup is secondary to an already-published review or completed remote write.
    core.warning("The temporary DeepSeek Harness workspace could not be removed.");
  }
}

/** Bind the worker to a materialized immutable repository revision or an empty workspace. */
export async function prepareWorkspace(options: {
  readonly client: GitHubClient;
  readonly context: GitHubContext;
  readonly snapshot?: EntitySnapshot;
  readonly baseBranch?: string;
  readonly inputs: ActionInputs;
  readonly policy: SecurityPolicy;
  readonly signal: AbortSignal;
  readonly onFailureBeforeCleanup?: (error: unknown) => void;
}): Promise<PreparedWorkspace> {
  const { client, context, snapshot, baseBranch, inputs, policy, signal } = options;
  requireWorkspace();
  let tempRoot: string | undefined;
  try {
    if (
      policy.trust !== "trusted-write" &&
      !(policy.trust === "trusted-read" && inputs.isolation === "docker")
    ) {
      tempRoot = await mkdtemp(join(tmpdir(), "dsh-action-empty-"));
      return { tempRoot, agentWorkspace: tempRoot };
    }

    tempRoot = await mkdtemp(join(tmpdir(), "dsh-action-workspace-"));
    const immutableSource = join(tempRoot, "source");
    const baseSha = await (async (): Promise<string> => {
      // Pull-request review/fix remains bound to the immutable PR head.
      if (snapshot?.kind === "pull_request") return snapshot.headSha;
      if (baseBranch === undefined) {
        throw new PolicyDeniedError("Cannot bind repository content without a base branch");
      }
      return await import("../write/github.js").then(({ getBranchHead }) =>
        getBranchHead(client, context.repository.owner, context.repository.repo, baseBranch),
      );
    })();
    throwIfCancelled(signal);
    await materializeRepositoryAtSha(
      client,
      context.repository.owner,
      context.repository.repo,
      baseSha,
      immutableSource,
    );
    throwIfCancelled(signal);
    const agentWorkspace = join(tempRoot, "repository");
    const workspaceSnapshot = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: immutableSource },
      agentWorkspace,
    );
    throwIfCancelled(signal);
    return {
      tempRoot,
      agentWorkspace,
      snapshot: workspaceSnapshot,
      boundWriteSha: baseSha,
    };
  } catch (error: unknown) {
    options.onFailureBeforeCleanup?.(error);
    if (tempRoot !== undefined) await removeTemporaryWorkspace(tempRoot);
    throw error;
  }
}

export async function disposeWorkspace(workspace: PreparedWorkspace): Promise<void> {
  await removeTemporaryWorkspace(workspace.tempRoot);
}
