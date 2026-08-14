/*
 * Lifecycle adapted from anthropics/claude-code-action/src/entrypoints/run.ts.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import * as core from "@actions/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { finalizeWorkflowRunRoute, routeCommand, type RoutedCommand } from "./commands/router.js";
import { finishDiagnosis } from "./commands/diagnose.js";
import { finishImplementation } from "./commands/implement.js";
import { finishReview } from "./commands/review.js";
import { runAgentTask } from "./review/run.js";
import { formatCiEvidence } from "./ci/diagnose.js";
import { fetchCiEvidence } from "./github/checks.js";
import { createGitHubClient, type GitHubClient } from "./github/client.js";
import {
  fetchEntitySnapshot,
  fetchPullRequestSnapshot,
  type EntitySnapshot,
  type PullRequestSnapshot,
} from "./github/fetch.js";
import { parseGitHubContext, isWorkflowRunContext, type GitHubContext } from "./github/context.js";
import { isFailedWorkflowRun, readEventPayload } from "./github/payload.js";
import { checkActorPermissions } from "./github/permissions.js";
import { StickyProgressReporter } from "./github/progress.js";
import { revalidatePullRequestHead } from "./write/pr.js";
import { materializeRepositoryAtSha } from "./github/repository.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "./write/workspace.js";
import { evaluatePolicy, type SecurityPolicy } from "./security/policy.js";
import { sanitizeUntrustedText } from "./security/redaction.js";
import { loadInputs, type ActionInputs } from "./inputs.js";
import {
  describeActionFailure,
  type ActionPhase,
  type AgentRunSummary,
  type RunOutcome,
  type ValidationSummary,
} from "./result.js";

interface RunState {
  phase: ActionPhase;
  operation?: RoutedCommand["operation"];
  policy?: SecurityPolicy;
  progress?: StickyProgressReporter;
  runUrl?: string;
  agent?: AgentRunSummary;
  validationCommandCount?: number;
}

interface WriteOutcome {
  readonly writeStatus: "success" | "partial-success";
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
}

function runUrl(context: GitHubContext): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${context.repository.fullName}/actions/runs/${context.runId}`;
}

export function boundedText(value: string, maximumBytes: number): string {
  const raw = Buffer.from(value, "utf8");
  if (raw.byteLength <= maximumBytes) return value;
  const marker = Buffer.from("\n[truncated by dsh-action]", "utf8");
  let prefix = raw.subarray(0, Math.max(0, maximumBytes - marker.byteLength)).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") + marker.byteLength > maximumBytes) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + marker.toString("utf8");
}

/** Enforce the Claude-style operation/entity state machine before invoking DSH. */
export function assertOperationContext(
  command: RoutedCommand,
  context: GitHubContext,
  snapshot: EntitySnapshot | undefined,
): void {
  if (command.operation === "implement") {
    if (snapshot?.kind !== "issue") {
      throw new Error("@dsh implement is supported only on issues");
    }
    return;
  }
  if (command.operation === "review" || command.operation === "fix") {
    if (snapshot?.kind !== "pull_request") {
      throw new Error(`@dsh ${command.operation} is supported only on pull requests`);
    }
    return;
  }
  if (snapshot?.kind !== "pull_request" && !isWorkflowRunContext(context)) {
    throw new Error("@dsh diagnose requires a pull request or workflow_run context");
  }
}

function sanitizedSnapshot(snapshot: EntitySnapshot): unknown {
  if (snapshot.kind === "issue") {
    let commentBytes = 0;
    return {
      ...snapshot,
      title: boundedText(sanitizeUntrustedText(snapshot.title), 2 * 1024),
      body: boundedText(sanitizeUntrustedText(snapshot.body), 12 * 1024),
      comments: snapshot.comments.slice(-20).flatMap((comment) => {
        const body = boundedText(sanitizeUntrustedText(comment.body), 2 * 1024);
        const bytes = Buffer.byteLength(body, "utf8");
        if (commentBytes + bytes > 6 * 1024) return [];
        commentBytes += bytes;
        return [{ ...comment, body }];
      }),
    };
  }
  let contentBytes = 0;
  let commentBytes = 0;
  return {
    kind: snapshot.kind,
    number: snapshot.number,
    author: snapshot.author,
    baseSha: snapshot.baseSha,
    baseRef: snapshot.baseRef,
    baseRepository: snapshot.baseRepository,
    baseRepositoryId: snapshot.baseRepositoryId,
    headSha: snapshot.headSha,
    headRef: snapshot.headRef,
    headRepository: snapshot.headRepository,
    headRepositoryId: snapshot.headRepositoryId,
    draft: snapshot.draft,
    isFork: snapshot.isFork,
    diffTruncated: snapshot.diffTruncated,
    title: boundedText(sanitizeUntrustedText(snapshot.title), 2 * 1024),
    body: boundedText(sanitizeUntrustedText(snapshot.body), 12 * 1024),
    comments: snapshot.comments.slice(-20).flatMap((comment) => {
      const body = boundedText(sanitizeUntrustedText(comment.body), 2 * 1024);
      const bytes = Buffer.byteLength(body, "utf8");
      if (commentBytes + bytes > 6 * 1024) return [];
      commentBytes += bytes;
      return [{ ...comment, body }];
    }),
    changedFiles: snapshot.changedFiles.slice(0, 100).map((file) => {
      const remaining = Math.max(0, 36 * 1024 - contentBytes);
      const patch =
        file.patch === undefined
          ? undefined
          : boundedText(sanitizeUntrustedText(file.patch), Math.min(12 * 1024, remaining));
      contentBytes += patch === undefined ? 0 : Buffer.byteLength(patch, "utf8");
      const sourceRemaining = Math.max(0, 36 * 1024 - contentBytes);
      const source =
        file.source === undefined
          ? undefined
          : boundedText(sanitizeUntrustedText(file.source), Math.min(4 * 1024, sourceRemaining));
      contentBytes += source === undefined ? 0 : Buffer.byteLength(source, "utf8");
      return { ...file, patch, source };
    }),
  };
}

async function resolvePullRequest(
  client: GitHubClient,
  context: GitHubContext,
): Promise<PullRequestSnapshot | undefined> {
  if (context.kind === "entity" && context.isPullRequest) {
    return fetchPullRequestSnapshot(client, context, context.entityNumber);
  }
  if (isWorkflowRunContext(context)) {
    const pullNumber = context.workflowRun.pullRequestNumbers[0];
    if (pullNumber !== undefined) return fetchPullRequestSnapshot(client, context, pullNumber);
  }
  return undefined;
}

function requireWorkspace(): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace === undefined || workspace === "") throw new Error("GITHUB_WORKSPACE is missing");
  return resolve(workspace);
}

async function buildContextPacket(
  client: GitHubClient,
  context: GitHubContext,
  command: RoutedCommand,
  snapshot: EntitySnapshot | undefined,
  inputs: ActionInputs,
): Promise<unknown> {
  let ci: string | undefined;
  if (
    (command.operation === "diagnose" || command.operation === "fix") &&
    snapshot?.kind === "pull_request"
  ) {
    ci = formatCiEvidence(
      await fetchCiEvidence(client, context.repository.owner, context.repository.repo, {
        headSha: snapshot.headSha,
        secrets: [inputs.githubToken, inputs.deepseekApiKey],
        ...(isWorkflowRunContext(context) ? { workflowRunId: context.workflowRun.id } : {}),
      }),
    );
  } else if (
    command.operation === "diagnose" &&
    isWorkflowRunContext(context) &&
    snapshot === undefined
  ) {
    ci = formatCiEvidence(
      await fetchCiEvidence(client, context.repository.owner, context.repository.repo, {
        headSha: context.workflowRun.headSha,
        workflowRunId: context.workflowRun.id,
        secrets: [inputs.githubToken, inputs.deepseekApiKey],
      }),
    );
  }
  return {
    event: { name: context.rawEventName, action: context.eventAction },
    repository: context.repository.fullName,
    entity: snapshot === undefined ? undefined : sanitizedSnapshot(snapshot),
    ci: ci === undefined ? undefined : boundedText(ci, 32 * 1024),
  };
}

async function executeWrite(
  client: GitHubClient,
  context: GitHubContext,
  command: RoutedCommand,
  inputs: ActionInputs,
  policy: SecurityPolicy,
  snapshot: EntitySnapshot,
  workspaceCopy: WorkspaceSnapshot,
  boundWriteSha: string,
  agentResult: Awaited<ReturnType<typeof runAgentTask>>,
  onPhase: (phase: "validation" | "write") => void,
): Promise<WriteOutcome> {
  if (command.operation === "implement" && snapshot.kind === "issue") {
    const result = await finishImplementation({
      client,
      owner: context.repository.owner,
      repo: context.repository.repo,
      issueNumber: snapshot.number,
      issueTitle: snapshot.title,
      issueIdentity: { state: snapshot.state, updatedAt: snapshot.updatedAt },
      baseBranch: context.repository.defaultBranch ?? "main",
      snapshot: workspaceCopy,
      boundHeadSha: boundWriteSha,
      operationKey: context.runId,
      result: agentResult,
      inputs,
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
  if (snapshot.kind === "pull_request" && policy.capabilities.modifyWorkspace) {
    const { finishFix } = await import("./commands/fix.js");
    onPhase("write");
    await revalidatePullRequestHead(
      client,
      context.repository.owner,
      context.repository.repo,
      snapshot.number,
      snapshot.headSha,
    );
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
      onPhase,
    });
    return {
      writeStatus: result.status,
      commitSha: result.commitSha,
      changedPaths: result.paths,
    };
  }
  throw new Error("The resolved entity does not support this write operation");
}

function outcomeContext(state: RunState, startedAt: number) {
  return {
    schemaVersion: 1 as const,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(state.runUrl === undefined ? {} : { runUrl: state.runUrl }),
    ...(state.policy === undefined ? {} : { policy: state.policy }),
    ...(state.agent === undefined ? {} : { agent: state.agent }),
    ...(state.progress?.commentId === undefined ? {} : { commentId: state.progress.commentId }),
  };
}

function successfulValidation(inputs: ActionInputs): ValidationSummary {
  return {
    status: inputs.runTests ? "passed" : "skipped",
    commandCount: inputs.testCommands.length,
  };
}

/** Claude Action-style prepare -> route -> authorize -> run -> finalize orchestration. */
async function runActionInternal(state: RunState, startedAt: number): Promise<RunOutcome> {
  state.phase = "configuration";
  const inputs = loadInputs();
  state.validationCommandCount = inputs.testCommands.length;
  core.setSecret(inputs.githubToken);
  core.setSecret(inputs.deepseekApiKey);

  state.phase = "routing";
  const payload = await readEventPayload(process.env.GITHUB_EVENT_PATH);
  const context = parseGitHubContext(process.env, payload);
  const currentRunUrl = runUrl(context);
  state.runUrl = currentRunUrl;
  let command = routeCommand(context, inputs);
  if (command !== null) state.operation = command.operation;
  if (
    command === null ||
    (context.rawEventName === "workflow_run" && !isFailedWorkflowRun(payload))
  ) {
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "neutral",
      summary: "No matching @dsh command or automatic event",
      findingsCount: 0,
    };
  }
  if (
    command.source === "automatic-event" &&
    context.kind === "entity" &&
    context.pullRequest?.draft === true
  ) {
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "neutral",
      operation: command.operation,
      summary: "Draft pull requests are not reviewed automatically",
      findingsCount: 0,
    };
  }

  const client = createGitHubClient(inputs.githubToken);
  state.phase = "authorization";
  const permissions = await checkActorPermissions(client, context);
  state.phase = "context";
  const pullRequest = await resolvePullRequest(client, context);
  command = finalizeWorkflowRunRoute(context, command, pullRequest !== undefined);
  state.operation = command.operation;
  let snapshot: EntitySnapshot | undefined = pullRequest;
  if (snapshot === undefined && context.kind === "entity") {
    snapshot = await fetchEntitySnapshot(
      client,
      context,
      context.entityNumber,
      context.isPullRequest,
    );
  }
  assertOperationContext(command, context, snapshot);

  state.phase = "authorization";
  const policy = evaluatePolicy({
    context,
    operation: command.operation,
    allowWrite: inputs.allowWrite,
    permissions,
    commandSource: command.source,
    allowWorkflowRunWrite:
      context.rawEventName === "workflow_run" &&
      command.operation === "fix" &&
      pullRequest !== undefined,
    ...(pullRequest === undefined ? {} : { resolvedPullRequest: { isFork: pullRequest.isFork } }),
  });
  state.policy = policy;
  if (!policy.allowed) throw new Error(policy.reason);

  const issueNumber = snapshot?.number ?? pullRequest?.number;
  if (inputs.progressComment && issueNumber !== undefined) {
    state.progress = new StickyProgressReporter({
      client,
      target: { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
      expectedAuthorId: inputs.botUserId,
      operation: command.operation,
      policy,
      runUrl: currentRunUrl,
    });
    await state.progress.update(
      "context",
      "Permission checks passed. Preparing a bounded, immutable context snapshot.",
    );
  }

  state.phase = "context";
  const workspace = requireWorkspace();
  let tempRoot: string | undefined;
  let workspaceCopy: WorkspaceSnapshot | undefined;
  let boundWriteSha: string | undefined;
  try {
    let agentWorkspace = workspace;
    if (
      policy.trust === "trusted-write" ||
      (policy.trust === "trusted-read" && inputs.isolation === "docker")
    ) {
      tempRoot = await mkdtemp(join(tmpdir(), "dsh-action-workspace-"));
      const immutableSource = join(tempRoot, "source");
      const baseSha =
        snapshot?.kind === "pull_request"
          ? snapshot.headSha
          : await import("./write/github.js").then(({ getBranchHead }) =>
              getBranchHead(
                client,
                context.repository.owner,
                context.repository.repo,
                context.repository.defaultBranch ?? "main",
              ),
            );
      boundWriteSha = baseSha;
      await materializeRepositoryAtSha(
        client,
        context.repository.owner,
        context.repository.repo,
        baseSha,
        immutableSource,
      );
      agentWorkspace = join(tempRoot, "repository");
      workspaceCopy = await createWorkspaceSnapshot(immutableSource, agentWorkspace);
    } else {
      tempRoot = await mkdtemp(join(tmpdir(), "dsh-action-empty-"));
      agentWorkspace = tempRoot;
    }
    const packet = await buildContextPacket(client, context, command, snapshot, inputs);

    state.phase = "agent";
    await state.progress?.update(
      "agent",
      "The isolated worker is running. Repository and event content remain untrusted data.",
    );
    const agentResult = await runAgentTask(
      {
        operation: command.operation,
        policy,
        contextPacket: packet,
        instructions: command.instructions,
        workspacePath: agentWorkspace,
      },
      inputs,
    );
    state.agent = {
      durationMs: agentResult.durationMs,
      isolation: agentResult.isolationReport,
    };

    if (command.operation === "review" && snapshot?.kind === "pull_request") {
      state.phase = "publication";
      await state.progress?.update(
        "finalizing",
        "Structured output passed validation. Mapping findings to the current diff and publishing.",
      );
      await revalidatePullRequestHead(
        client,
        context.repository.owner,
        context.repository.repo,
        snapshot.number,
        snapshot.headSha,
      );
      const publication = await finishReview(
        client,
        {
          owner: context.repository.owner,
          repo: context.repository.repo,
          pullNumber: snapshot.number,
          expectedAuthorId: inputs.botUserId,
          runUrl: currentRunUrl,
        },
        snapshot,
        agentResult,
        inputs.maxFindings,
      );
      return {
        ...outcomeContext(state, startedAt),
        conclusion: "success",
        operation: command.operation,
        summary: agentResult.output.summary,
        findingsCount: publication.selected,
        publication,
        validation: { status: "not-applicable", commandCount: 0 },
      };
    }
    if (command.operation === "diagnose") {
      state.phase = "publication";
      await state.progress?.update(
        "finalizing",
        "Structured output passed validation. Publishing the bounded CI diagnosis.",
      );
      if (issueNumber !== undefined) {
        await finishDiagnosis(
          client,
          { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
          inputs.botUserId,
          agentResult,
          currentRunUrl,
        );
      }
      return {
        ...outcomeContext(state, startedAt),
        conclusion: "success",
        operation: command.operation,
        summary: agentResult.output.summary,
        findingsCount: agentResult.output.findings.length,
        validation: { status: "not-applicable", commandCount: 0 },
      };
    }
    if (snapshot === undefined || workspaceCopy === undefined || boundWriteSha === undefined) {
      throw new Error("Write operation requires a trusted checked-out entity workspace");
    }

    state.phase = "validation";
    await state.progress?.update(
      "finalizing",
      inputs.runTests
        ? "The structured change is ready. Running configured validation before any GitHub write."
        : "The structured change is ready. Applying the explicitly unverified trusted write.",
    );
    const write = await executeWrite(
      client,
      context,
      command,
      inputs,
      policy,
      snapshot,
      workspaceCopy,
      boundWriteSha,
      agentResult,
      (phase) => {
        state.phase = phase;
      },
    );
    if (command.operation === "implement") {
      await state.progress?.complete(
        `Implementation completed and pull request ${write.pullRequestUrl ?? "was created"}.`,
      );
    } else if (write.writeStatus === "partial-success") {
      await state.progress?.complete(
        `Commit \`${write.commitSha ?? "unknown"}\` was pushed, but the detailed final status publication reported a partial success.`,
      );
    }
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "success",
      operation: command.operation,
      summary: agentResult.output.summary,
      findingsCount: agentResult.output.findings.length,
      validation: successfulValidation(inputs),
      ...write,
    };
  } finally {
    if (tempRoot !== undefined) {
      try {
        await rm(tempRoot, { recursive: true, force: true });
      } catch {
        // Cleanup is secondary. It must not turn an already-published review or
        // completed remote write into a failed run that may be retried.
        core.warning("The temporary DeepSeek Harness workspace could not be removed.");
      }
    }
  }
}

export async function runAction(): Promise<RunOutcome> {
  const startedAt = Date.now();
  const state: RunState = { phase: "configuration" };
  try {
    return await runActionInternal(state, startedAt);
  } catch (error: unknown) {
    const failure = describeActionFailure(error, state.phase);
    await state.progress?.fail(failure);
    const validation: ValidationSummary | undefined =
      failure.phase === "validation"
        ? { status: "failed", commandCount: state.validationCommandCount ?? 0 }
        : undefined;
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "failure",
      ...(state.operation === undefined ? {} : { operation: state.operation }),
      summary: failure.title,
      findingsCount: 0,
      ...(validation === undefined ? {} : { validation }),
      error: failure,
    };
  }
}

export function reportFailure(error: unknown): string {
  return describeActionFailure(error, "agent").message;
}
