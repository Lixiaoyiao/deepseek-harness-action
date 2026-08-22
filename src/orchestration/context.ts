import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { formatCiEvidence } from "../ci/diagnose.js";
import type { RoutedCommand } from "../commands/router.js";
import { fetchCiEvidence } from "../github/checks.js";
import { isWorkflowRunContext, type GitHubContext } from "../github/context.js";
import type { GitHubClient } from "../github/client.js";
import {
  fetchPullRequestSnapshot,
  type EntitySnapshot,
  type PullRequestSnapshot,
} from "../github/fetch.js";
import type { ActionInputs } from "../inputs.js";
import { ActionConfigurationError, OperationContextError, PolicyDeniedError } from "../errors.js";
import { sanitizeUntrustedText } from "../security/redaction.js";

export function runUrl(context: GitHubContext): string {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  return `${server}/${context.repository.fullName}/actions/runs/${context.runId}`;
}

export function deferProgressUntilWriteValidation(
  command: Pick<RoutedCommand, "requestedAccess">,
): boolean {
  return command.requestedAccess === "write";
}

export function taskIdentity(
  command: RoutedCommand,
  inputs: ActionInputs,
  extensionAuditDigest: string,
  permissionDigest: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        operation: command.operation,
        access: command.requestedAccess,
        instructions: command.instructions,
        permissionProfile: inputs.permissionProfile,
        allowedTools: inputs.allowedTools,
        disallowedTools: inputs.disallowedTools,
        validationIntegrity: inputs.validationIntegrity,
        toolConfig: inputs.toolConfig,
        // This identity can influence public branch names and PR markers. Bind
        // it to the redacted audit surface, never the secret-bearing effective
        // MCP/Plugin configuration used by the private runtime lock.
        extensionAuditDigest,
        permissionDigest,
        allowPluginInstall: inputs.allowPluginInstall,
      }),
      "utf8",
    )
    .digest("hex");
}

export function issueTaskIdentity(
  baseIdentity: string,
  snapshot: Extract<EntitySnapshot, { kind: "issue" }>,
): string {
  return createHash("sha256")
    .update([baseIdentity, snapshot.state, snapshot.contentFingerprint].join("\0"), "utf8")
    .digest("hex");
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

/** Enforce the operation/entity state machine before invoking DSH. */
export function assertOperationContext(
  command: RoutedCommand,
  context: GitHubContext,
  snapshot: EntitySnapshot | undefined,
): void {
  const assertTrustedWriteTarget = (): void => {
    const defaultBranch = context.repository.defaultBranch;
    if (defaultBranch === undefined) {
      throw new PolicyDeniedError(
        "Cannot authorize a trusted write without the default branch identity",
      );
    }
    if (snapshot?.kind === "pull_request" && snapshot.headRef === defaultBranch) {
      throw new PolicyDeniedError(
        "Refusing to update the repository default branch from a pull-request write",
      );
    }
  };
  if (command.operation === "task") {
    if (command.requestedAccess === "write") assertTrustedWriteTarget();
    return;
  }
  if (command.operation === "implement") {
    if (snapshot?.kind !== "issue") {
      throw new OperationContextError("@dsh implement is supported only on issues");
    }
    if (command.requestedAccess === "write") assertTrustedWriteTarget();
    return;
  }
  if (command.operation === "review" || command.operation === "fix") {
    if (snapshot?.kind !== "pull_request") {
      throw new OperationContextError(
        `@dsh ${command.operation} is supported only on pull requests`,
      );
    }
    if (command.operation === "fix" && command.requestedAccess === "write") {
      assertTrustedWriteTarget();
    }
    return;
  }
  if (snapshot?.kind !== "pull_request" && !isWorkflowRunContext(context)) {
    throw new OperationContextError(
      "@dsh diagnose requires a pull request or workflow_run context",
    );
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

export async function resolvePullRequest(
  client: GitHubClient,
  context: GitHubContext,
): Promise<PullRequestSnapshot | undefined> {
  if (context.kind === "entity" && context.isPullRequest) {
    return await fetchPullRequestSnapshot(client, context, context.entityNumber);
  }
  if (isWorkflowRunContext(context)) {
    const pullNumber = context.workflowRun.pullRequestNumbers[0];
    if (pullNumber !== undefined) {
      return await fetchPullRequestSnapshot(client, context, pullNumber);
    }
  }
  return undefined;
}

export function requireWorkspace(): string {
  const workspace = process.env.GITHUB_WORKSPACE;
  if (workspace === undefined || workspace === "") {
    throw new ActionConfigurationError("GITHUB_WORKSPACE is missing");
  }
  return resolve(workspace);
}

export async function buildContextPacket(
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
