import type { GitHubClient } from "../github/client.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import {
  assertRemoteBranchHead,
  createGitHubCommitFromWorkspace,
  createRemoteBranch,
  updateRemoteBranch,
} from "./github.js";
import { revalidateIssueIdentity, type BoundIssueIdentity } from "./issue.js";
import {
  createPullRequest,
  findPullRequestByOperationKey,
  revalidatePullRequestIdentity,
  type BoundPullRequestIdentity,
} from "./pr.js";
import {
  remainingValidationMs,
  withinValidationDeadline,
  type ValidationDeadline,
} from "./validation-deadline.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
} from "./validate.js";
import { inspectWorkspaceChanges, type WorkspaceSnapshot } from "./workspace.js";
import {
  assertEquivalentOperationCommit,
  assertOwnedOperationCommit,
  findOwnedBranchCommit,
  type BranchWriteOperation,
  type BranchWriteOperationKind,
} from "./operation-commit.js";

export interface ControllerWriteControl {
  readonly revalidateAuthority: () => Promise<void>;
  readonly onValidationPassed?: () => void;
  readonly validationDeadlineMs?: number;
  readonly signal?: AbortSignal;
  readonly onPhase?: (phase: "validation" | "write") => void;
}

interface WriteValidationConfiguration {
  readonly runTests: boolean;
  readonly commands: readonly (readonly string[])[];
  readonly containerImage: string;
}

interface BaseBranchWriteTarget {
  readonly branch: string;
  readonly sha: string;
  readonly issue?: { readonly number: number; readonly identity: BoundIssueIdentity };
}

export interface NewPullRequestWritePlan {
  readonly kind: "new-pr";
  readonly target: BaseBranchWriteTarget;
  readonly operationKind: BranchWriteOperationKind;
  readonly operation: BranchWriteOperation;
  readonly publication: { readonly title: string; readonly body: string };
}

export interface PullHeadWritePlan {
  readonly kind: "pr-head";
  readonly target: { readonly number: number; readonly identity: BoundPullRequestIdentity };
  readonly commitMessage: string;
}

type RepositoryWritePlan = NewPullRequestWritePlan | PullHeadWritePlan;
interface RepositoryWriteOptions {
  readonly client: GitHubClient;
  readonly repository: { readonly owner: string; readonly repo: string };
  readonly workspace: WorkspaceSnapshot;
  readonly plan: RepositoryWritePlan;
  readonly validation: WriteValidationConfiguration;
  readonly control: ControllerWriteControl;
}
interface NewPullRequestWriteResult {
  readonly branch: string;
  readonly pullNumber: number;
  readonly url: string;
}
interface PullHeadWriteResult {
  readonly commitSha: string;
  readonly paths: readonly string[];
}

function controllerWriteDeadline(control: ControllerWriteControl): ValidationDeadline {
  return {
    deadlineMs: control.validationDeadlineMs ?? Date.now() + 10 * 60_000,
    ...(control.signal === undefined ? {} : { signal: control.signal }),
  };
}

async function revalidateWriteTarget(options: RepositoryWriteOptions): Promise<void> {
  const {
    client,
    repository: { owner, repo },
    plan,
  } = options;
  if (plan.kind === "pr-head") {
    await revalidatePullRequestIdentity(
      client,
      owner,
      repo,
      plan.target.number,
      plan.target.identity,
    );
    return;
  }
  await assertRemoteBranchHead(client, owner, repo, plan.target.branch, plan.target.sha);
  if (plan.target.issue !== undefined) {
    await revalidateIssueIdentity(
      client,
      owner,
      repo,
      plan.target.issue.number,
      plan.target.issue.identity,
    );
  }
}

async function validateWriteTransaction(
  options: RepositoryWriteOptions,
  budget: ValidationDeadline,
): Promise<void> {
  const { validation, control } = options;
  assertWriteValidationConfigured(validation.runTests, validation.commands);
  const tests = await withinValidationDeadline(
    async () =>
      runValidationCommandsInDocker(
        options.workspace.workerRoot,
        validation.commands,
        validation.containerImage,
        remainingValidationMs(budget),
        undefined,
        control.signal,
      ),
    budget,
  );
  assertValidationSucceeded(tests);
  control.onValidationPassed?.();
  throwIfCancelled(control.signal);
  await withinValidationDeadline(async () => revalidateWriteTarget(options), budget);
  await withinValidationDeadline(control.revalidateAuthority, budget);
  throwIfCancelled(control.signal);
}

async function persistNewPullRequest(
  options: RepositoryWriteOptions & { readonly plan: NewPullRequestWritePlan },
  candidateSha: string,
  reconciledCommit: string | null,
): Promise<NewPullRequestWriteResult> {
  const {
    client,
    repository: { owner, repo },
    plan,
  } = options;
  const { operation, target } = plan;
  let commitSha = reconciledCommit;
  if (commitSha === null) {
    commitSha = candidateSha;
    await createRemoteBranch(client, owner, repo, operation.branch, commitSha);
  } else {
    await assertEquivalentOperationCommit(
      plan.operationKind,
      client,
      owner,
      repo,
      commitSha,
      candidateSha,
      operation,
      target.sha,
    );
  }
  await assertRemoteBranchHead(client, owner, repo, operation.branch, commitSha);
  await revalidateWriteTarget(options);
  const pull = await createPullRequest(
    client,
    owner,
    repo,
    operation.branch,
    target.branch,
    plan.publication.title,
    plan.publication.body,
    operation.pullRequestMarker,
  );
  return { branch: operation.branch, pullNumber: pull.number, url: pull.url };
}

/** One interface owns validation, current authority, binding and effect ordering for both real write adapters. */
export function executeValidatedRepositoryWrite(
  options: RepositoryWriteOptions & { readonly plan: NewPullRequestWritePlan },
): Promise<NewPullRequestWriteResult>;
export function executeValidatedRepositoryWrite(
  options: RepositoryWriteOptions & { readonly plan: PullHeadWritePlan },
): Promise<PullHeadWriteResult>;
export async function executeValidatedRepositoryWrite(
  options: RepositoryWriteOptions,
): Promise<NewPullRequestWriteResult | PullHeadWriteResult> {
  const {
    client,
    repository: { owner, repo },
    plan,
    control,
  } = options;
  const budget = controllerWriteDeadline(control);
  control.onPhase?.("validation");
  let reconciledCommit: string | null = null;
  if (plan.kind === "new-pr") {
    const { operation, target } = plan;
    const completed = await withinValidationDeadline(
      async () =>
        findPullRequestByOperationKey(
          plan.operationKind,
          client,
          owner,
          repo,
          operation.branch,
          target.branch,
          operation.key,
        ),
      budget,
    );
    // Authenticate a completed prior attempt without replaying writes or relying
    // on an Issue/base snapshot which the completed operation may have advanced.
    if (completed !== null) {
      await withinValidationDeadline(
        async () =>
          assertOwnedOperationCommit(
            plan.operationKind,
            client,
            owner,
            repo,
            completed.headSha,
            operation.key,
            completed.snapshotFingerprint,
          ),
        budget,
      );
      // The authenticated completed operation was already Controller-validated.
      // Preserve that successful evidence without rerunning tests or mutations.
      control.onValidationPassed?.();
      return { branch: operation.branch, pullNumber: completed.number, url: completed.url };
    }
    reconciledCommit = await withinValidationDeadline(
      async () =>
        findOwnedBranchCommit(plan.operationKind, client, owner, repo, operation, target.sha),
      budget,
    );
  }
  await withinValidationDeadline(async () => revalidateWriteTarget(options), budget);
  if (plan.kind === "pr-head") {
    const changes = await withinValidationDeadline(
      async () => inspectWorkspaceChanges(options.workspace),
      budget,
    );
    if (changes.all.length === 0)
      throw new Error("DSH reported a write but produced no file changes");
  }
  await validateWriteTransaction(options, budget);
  control.onPhase?.("write");
  // The authority gate precedes every initial persistent effect, including blobs.
  // After this seam, finish the bounded transport's existing reconciliation sequence
  // if cancellation races it, without replaying a ref or PR mutation.
  const candidate = await createGitHubCommitFromWorkspace(
    client,
    {
      owner,
      repo,
      baseSha: plan.kind === "new-pr" ? plan.target.sha : plan.target.identity.headSha,
      message: plan.kind === "new-pr" ? plan.operation.commitMessage : plan.commitMessage,
    },
    options.workspace,
  );
  await revalidateWriteTarget(options);
  if (plan.kind === "new-pr") {
    return await persistNewPullRequest({ ...options, plan }, candidate.sha, reconciledCommit);
  }
  await assertRemoteBranchHead(
    client,
    owner,
    repo,
    plan.target.identity.headRef,
    plan.target.identity.headSha,
  );
  await updateRemoteBranch(client, owner, repo, plan.target.identity.headRef, candidate.sha);
  return { commitSha: candidate.sha, paths: candidate.paths };
}
