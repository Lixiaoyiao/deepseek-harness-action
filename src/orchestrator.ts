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
import { revalidatePullRequestHead } from "./write/pr.js";
import { materializeRepositoryAtSha } from "./github/repository.js";
import { createWorkspaceSnapshot, type WorkspaceSnapshot } from "./write/workspace.js";
import { evaluatePolicy, type SecurityPolicy } from "./security/policy.js";
import { redactSecrets, sanitizeUntrustedText } from "./security/redaction.js";
import { loadInputs, type ActionInputs } from "./inputs.js";

export interface RunOutcome {
  readonly conclusion: "success" | "neutral";
  readonly operation?: RoutedCommand["operation"];
  readonly summary: string;
  readonly findingsCount: number;
  readonly branchName?: string;
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
): Promise<Pick<RunOutcome, "branchName" | "pullRequestUrl">> {
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
    });
    return { branchName: result.branch, pullRequestUrl: result.url };
  }
  // Same-repository PR fixes are committed through the controller's GitHub API
  // after one final immutable-head check; DSH never receives that credential.
  if (snapshot.kind === "pull_request" && policy.capabilities.modifyWorkspace) {
    const { finishFix } = await import("./commands/fix.js");
    await revalidatePullRequestHead(
      client,
      context.repository.owner,
      context.repository.repo,
      snapshot.number,
      snapshot.headSha,
    );
    await finishFix({
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
    });
    return {};
  }
  throw new Error("The resolved entity does not support this write operation");
}

/** Claude Action-style prepare -> route -> authorize -> run -> finalize orchestration. */
export async function runAction(): Promise<RunOutcome> {
  const inputs = loadInputs();
  core.setSecret(inputs.githubToken);
  core.setSecret(inputs.deepseekApiKey);
  const payload = await readEventPayload(process.env.GITHUB_EVENT_PATH);
  const context = parseGitHubContext(process.env, payload);
  let command = routeCommand(context, inputs);
  if (
    command === null ||
    (context.rawEventName === "workflow_run" && !isFailedWorkflowRun(payload))
  ) {
    return {
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
      conclusion: "neutral",
      operation: command.operation,
      summary: "Draft pull requests are not reviewed automatically",
      findingsCount: 0,
    };
  }

  const client = createGitHubClient(inputs.githubToken);
  const permissions = await checkActorPermissions(client, context);
  const pullRequest = await resolvePullRequest(client, context);
  command = finalizeWorkflowRunRoute(context, command, pullRequest !== undefined);
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
  if (!policy.allowed) throw new Error(policy.reason);

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

    if (command.operation === "review" && snapshot?.kind === "pull_request") {
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
          runUrl: runUrl(context),
        },
        snapshot,
        agentResult,
        inputs.maxFindings,
      );
      return {
        conclusion: "success",
        operation: command.operation,
        summary: agentResult.output.summary,
        findingsCount: publication.selected,
      };
    }
    if (command.operation === "diagnose") {
      const issueNumber = snapshot?.number ?? pullRequest?.number;
      if (issueNumber !== undefined) {
        await finishDiagnosis(
          client,
          { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
          inputs.botUserId,
          agentResult,
          runUrl(context),
        );
      }
      return {
        conclusion: "success",
        operation: command.operation,
        summary: agentResult.output.summary,
        findingsCount: agentResult.output.findings.length,
      };
    }
    if (snapshot === undefined || workspaceCopy === undefined || boundWriteSha === undefined) {
      throw new Error("Write operation requires a trusted checked-out entity workspace");
    }
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
    );
    return {
      conclusion: "success",
      operation: command.operation,
      summary: agentResult.output.summary,
      findingsCount: agentResult.output.findings.length,
      ...write,
    };
  } finally {
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  }
}

export function reportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 4_000);
}
