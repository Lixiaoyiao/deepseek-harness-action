/*
 * The data-fetching lifecycle is adapted from anthropics/claude-code-action.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import { z } from "zod";

import type { GitHubClient } from "./client.js";
import type { GitHubContext } from "./context.js";

const MAX_FILE_CONTEXT_BYTES = 64 * 1024;
const MAX_TOTAL_CONTEXT_BYTES = 512 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const MAX_COMMENTS = 200;
const MAX_COMMENT_SCAN = 500;
const MAX_COMMENT_BYTES = 128 * 1024;
const MAX_COMMENT_BODY_BYTES = 16 * 1024;
const MAX_CHANGED_FILES = 1000;
const MAX_FILE_METADATA_BYTES = 128 * 1024;
const MAX_ENTITY_BODY_BYTES = 64 * 1024;
const MAX_ENTITY_TITLE_BYTES = 4 * 1024;

const triggerPayloadSchema = z
  .object({
    issue: z
      .object({
        title: z.string().nullable().optional(),
        body: z.string().nullable().optional(),
        user: z.object({ login: z.string() }).nullable().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      })
      .optional(),
    pull_request: z
      .object({
        title: z.string().nullable().optional(),
        body: z.string().nullable().optional(),
        user: z.object({ login: z.string() }).nullable().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      })
      .optional(),
    comment: z
      .object({
        id: z.number().int().positive(),
        body: z.string().nullable().optional(),
        user: z.object({ login: z.string() }).nullable().optional(),
        created_at: z.string().optional(),
        updated_at: z.string().optional(),
      })
      .optional(),
    review: z
      .object({
        id: z.number().int().positive(),
        body: z.string().nullable().optional(),
        user: z.object({ login: z.string() }).nullable().optional(),
        submitted_at: z.string().nullable().optional(),
      })
      .optional(),
  })
  .loose();

export interface RepositoryComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PullRequestFileContext {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly patch?: string;
  readonly patchMissing: boolean;
  readonly patchTruncated: boolean;
  readonly source?: string;
  readonly sourceTruncated: boolean;
}

export interface PullRequestSnapshot {
  readonly kind: "pull_request";
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly baseRepository: string;
  readonly baseRepositoryId: number;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepository: string | null;
  readonly headRepositoryId: number | null;
  readonly draft: boolean;
  readonly isFork: boolean;
  readonly changedFiles: readonly PullRequestFileContext[];
  readonly diffTruncated: boolean;
  readonly comments: readonly RepositoryComment[];
}

export async function assertPullRequestSnapshotCurrent(
  client: GitHubClient,
  owner: string,
  repo: string,
  snapshot: PullRequestSnapshot,
): Promise<void> {
  const response = await client.rest.pulls.get({ owner, repo, pull_number: snapshot.number });
  const actual = pullBinding(response);
  assertSamePullBinding(
    {
      headSha: snapshot.headSha,
      headRef: snapshot.headRef,
      headRepositoryId: snapshot.headRepositoryId,
      baseSha: snapshot.baseSha,
      baseRef: snapshot.baseRef,
      baseRepositoryId: snapshot.baseRepositoryId,
    },
    actual,
  );
  if (response.data.state !== "open") throw new Error("Pull request is no longer open");
}

export interface IssueSnapshot {
  readonly kind: "issue";
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly comments: readonly RepositoryComment[];
}

export type EntitySnapshot = PullRequestSnapshot | IssueSnapshot;

function originalEntityText(
  context: GitHubContext,
  kind: "issue" | "pull_request",
): { title?: string; body?: string; author?: string } {
  const parsed = triggerPayloadSchema.safeParse(context.payload);
  if (!parsed.success) return {};
  const entity =
    kind === "issue" ? parsed.data.issue : (parsed.data.pull_request ?? parsed.data.issue);
  if (entity === undefined) return {};
  return {
    ...(entity.title === null || entity.title === undefined ? {} : { title: entity.title }),
    ...(entity.body === null || entity.body === undefined ? {} : { body: entity.body }),
    ...(entity.user?.login === undefined ? {} : { author: entity.user.login }),
  };
}

function triggerTime(context: GitHubContext): number | null {
  const parsed = triggerPayloadSchema.safeParse(context.payload);
  if (!parsed.success) return null;
  const value = parsed.data.comment
    ? (parsed.data.comment.updated_at ?? parsed.data.comment.created_at)
    : (parsed.data.review?.submitted_at ??
      parsed.data.pull_request?.updated_at ??
      parsed.data.issue?.updated_at);
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function triggeringCommentId(context: GitHubContext): number | undefined {
  const parsed = triggerPayloadSchema.safeParse(context.payload);
  return parsed.success ? parsed.data.comment?.id : undefined;
}

/**
 * Preserve Claude Action's trigger-time snapshot invariant: comments created
 * or edited after the webhook that started this run cannot inject new data.
 */
export function filterCommentsToTriggerTime(
  comments: readonly RepositoryComment[],
  context: GitHubContext,
): readonly RepositoryComment[] {
  const cutoff = triggerTime(context);
  if (cutoff === null) return [];
  const triggerId = triggeringCommentId(context);
  return comments.filter(({ id, createdAt, updatedAt }) => {
    const created = Date.parse(createdAt);
    const updated = Date.parse(updatedAt);
    if (!Number.isFinite(created) || !Number.isFinite(updated)) return false;
    if (id === triggerId) return created <= cutoff && updated <= cutoff;
    return created < cutoff && updated < cutoff;
  });
}

function normalizeComment(comment: {
  id: number;
  body?: string | null;
  created_at: string;
  updated_at: string;
  user?: { login?: string } | null;
}): RepositoryComment {
  return {
    id: comment.id,
    author: comment.user?.login ?? "ghost",
    body: comment.body ?? "",
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
  };
}

function originalTriggerComment(context: GitHubContext): RepositoryComment | null {
  const parsed = triggerPayloadSchema.safeParse(context.payload);
  if (!parsed.success || parsed.data.comment === undefined) return null;
  const comment = parsed.data.comment;
  const createdAt = comment.created_at;
  const updatedAt = comment.updated_at ?? createdAt;
  if (createdAt === undefined || updatedAt === undefined) return null;
  return {
    id: comment.id,
    author: comment.user?.login ?? "ghost",
    body: comment.body ?? "",
    createdAt,
    updatedAt,
  };
}

function boundedUtf8(value: string, limit: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= limit) return { text: value, truncated: false };
  if (limit <= 0) return { text: "", truncated: true };
  const marker = Buffer.from("\n[truncated by dsh-action]", "utf8");
  if (marker.byteLength >= limit) {
    let text = bytes.subarray(0, limit).toString("utf8");
    while (Buffer.byteLength(text, "utf8") > limit) text = text.slice(0, -1);
    return { text, truncated: true };
  }
  let prefix = bytes.subarray(0, limit - marker.byteLength).toString("utf8");
  while (Buffer.byteLength(prefix, "utf8") + marker.byteLength > limit) {
    prefix = prefix.slice(0, -1);
  }
  return {
    text: prefix + marker.toString("utf8"),
    truncated: true,
  };
}

async function fetchBlobText(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  remainingBytes: number,
): Promise<{ text?: string; bytes: number; truncated: boolean }> {
  if (remainingBytes <= 0) return { bytes: 0, truncated: true };
  try {
    const response = await client.rest.git.getBlob({ owner, repo, file_sha: sha });
    if (response.data.encoding !== "base64") return { bytes: 0, truncated: true };
    const raw = Buffer.from(response.data.content.replaceAll("\n", ""), "base64");
    if (raw.includes(0)) return { bytes: 0, truncated: false };
    const limit = Math.min(MAX_FILE_CONTEXT_BYTES, remainingBytes);
    const bounded = boundedUtf8(raw.toString("utf8"), limit);
    return {
      text: bounded.text,
      bytes: Buffer.byteLength(bounded.text, "utf8"),
      truncated: bounded.truncated,
    };
  } catch {
    return { bytes: 0, truncated: true };
  }
}

function lastPageFromLink(link: string | undefined): number {
  if (link === undefined) return 1;
  const match = /[?&]page=(\d+)[^>]*>; rel="last"/u.exec(link);
  if (match?.[1] === undefined) return 1;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
}

async function listRecentCommentsBounded(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<RepositoryComment[]> {
  const first = await client.rest.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
    page: 1,
  });
  const lastPage = lastPageFromLink(first.headers.link);
  if (lastPage === 1) return first.data.slice(-MAX_COMMENT_SCAN).map(normalizeComment);
  const comments: typeof first.data = [];
  let scanned = comments.length;
  for (let page = lastPage; page >= 1 && scanned < MAX_COMMENT_SCAN; page -= 1) {
    const response = await client.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      page,
    });
    comments.unshift(...response.data);
    scanned += response.data.length;
  }
  return comments.slice(-MAX_COMMENT_SCAN).map(normalizeComment);
}

function selectBoundedComments(
  comments: readonly RepositoryComment[],
  context: GitHubContext,
): readonly RepositoryComment[] {
  const trigger = originalTriggerComment(context);
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  if (trigger !== null) byId.set(trigger.id, trigger);
  const eligible = [...filterCommentsToTriggerTime([...byId.values()], context)].sort(
    (left, right) => {
      if (left.id === trigger?.id) return -1;
      if (right.id === trigger?.id) return 1;
      return Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id - left.id;
    },
  );

  const selected: RepositoryComment[] = [];
  let remainingBytes = MAX_COMMENT_BYTES;
  for (const comment of eligible.slice(0, MAX_COMMENTS)) {
    const bounded = boundedUtf8(comment.body, Math.min(MAX_COMMENT_BODY_BYTES, remainingBytes));
    if (bounded.text.length === 0 && comment.body.length > 0) continue;
    selected.push({ ...comment, body: bounded.text });
    remainingBytes -= Buffer.byteLength(bounded.text, "utf8");
  }
  return selected.sort(
    (left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id - right.id,
  );
}

async function listExistingComments(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  context: GitHubContext,
): Promise<readonly RepositoryComment[]> {
  const comments = await listRecentCommentsBounded(client, owner, repo, issueNumber);
  return selectBoundedComments(comments, context);
}

async function listPullRequestFilesBounded(
  client: GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
) {
  const files: Awaited<ReturnType<typeof client.rest.pulls.listFiles>>["data"] = [];
  for (let page = 1; page <= Math.ceil(MAX_CHANGED_FILES / 100); page += 1) {
    const response = await client.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
      page,
    });
    files.push(...response.data);
    if (response.data.length < 100) break;
  }
  return {
    files: files.slice(0, MAX_CHANGED_FILES),
    maybeTruncated: files.length >= MAX_CHANGED_FILES,
  };
}

interface PullBinding {
  headSha: string;
  headRef: string;
  headRepositoryId: number | null;
  baseSha: string;
  baseRef: string;
  baseRepositoryId: number;
}

function pullBinding(pull: Awaited<ReturnType<GitHubClient["rest"]["pulls"]["get"]>>): PullBinding {
  const headRepo = pull.data.head.repo as { id: number; full_name: string } | null;
  return {
    headSha: pull.data.head.sha,
    headRef: pull.data.head.ref,
    headRepositoryId: headRepo?.id ?? null,
    baseSha: pull.data.base.sha,
    baseRef: pull.data.base.ref,
    baseRepositoryId: pull.data.base.repo.id,
  };
}

function assertSamePullBinding(expected: PullBinding, actual: PullBinding): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Pull request changed while its review snapshot was being collected");
  }
}

export async function fetchPullRequestSnapshot(
  client: GitHubClient,
  context: GitHubContext,
  pullNumber: number,
): Promise<PullRequestSnapshot> {
  const { owner, repo } = context.repository;
  const pull = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pull.data.state !== "open") throw new Error("Pull request is no longer open");
  const binding = pullBinding(pull);
  if (context.kind === "entity" && context.pullRequest?.number === pullNumber) {
    assertSamePullBinding(
      {
        headSha: context.pullRequest.headSha,
        headRef: context.pullRequest.headRef,
        headRepositoryId: context.pullRequest.headRepositoryId,
        baseSha: context.pullRequest.baseSha,
        baseRef: context.pullRequest.baseRef,
        baseRepositoryId: context.pullRequest.baseRepositoryId,
      },
      binding,
    );
  }
  const [{ files, maybeTruncated: filesTruncated }, comments] = await Promise.all([
    listPullRequestFilesBounded(client, owner, repo, pullNumber),
    listExistingComments(client, owner, repo, pullNumber, context),
  ]);

  let sourceBytes = 0;
  let diffBytes = 0;
  let diffTruncated = filesTruncated;
  let metadataBytes = 0;
  const changedFiles: PullRequestFileContext[] = [];

  for (const file of files) {
    const fileMetadataBytes = Buffer.byteLength(
      `${file.filename}\0${file.previous_filename ?? ""}`,
      "utf8",
    );
    if (metadataBytes + fileMetadataBytes > MAX_FILE_METADATA_BYTES) {
      diffTruncated = true;
      break;
    }
    metadataBytes += fileMetadataBytes;
    const patchMissing = file.patch === undefined;
    let patchTruncated = false;
    let patch: string | undefined;
    if (file.patch !== undefined) {
      const bounded = boundedUtf8(file.patch, Math.max(0, MAX_DIFF_BYTES - diffBytes));
      patch = bounded.text;
      diffBytes += Buffer.byteLength(patch, "utf8");
      diffTruncated ||= bounded.truncated;
      patchTruncated = bounded.truncated;
    } else {
      diffTruncated = true;
    }

    let source: string | undefined;
    let sourceTruncated = false;
    if (file.status !== "removed" && file.sha !== null && sourceBytes < MAX_TOTAL_CONTEXT_BYTES) {
      const blob = await fetchBlobText(
        client,
        owner,
        repo,
        file.sha,
        MAX_TOTAL_CONTEXT_BYTES - sourceBytes,
      );
      source = blob.text;
      sourceBytes += blob.bytes;
      sourceTruncated = blob.truncated;
    }

    changedFiles.push({
      path: file.filename,
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      ...(patch === undefined ? {} : { patch }),
      patchMissing,
      patchTruncated,
      ...(source === undefined ? {} : { source }),
      sourceTruncated,
    });
  }

  const verifiedPull = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  assertSamePullBinding(binding, pullBinding(verifiedPull));
  if (verifiedPull.data.state !== "open") throw new Error("Pull request is no longer open");

  const headRepo = pull.data.head.repo as { id: number; full_name: string } | null;
  const headRepository = headRepo?.full_name ?? null;
  const headRepositoryId = headRepo?.id ?? null;
  const baseRepository = pull.data.base.repo.full_name;
  const baseRepositoryId = pull.data.base.repo.id;
  const original = originalEntityText(context, "pull_request");
  return {
    kind: "pull_request",
    number: pull.data.number,
    title: boundedUtf8(original.title ?? pull.data.title, MAX_ENTITY_TITLE_BYTES).text,
    body: boundedUtf8(original.body ?? pull.data.body ?? "", MAX_ENTITY_BODY_BYTES).text,
    author: original.author ?? pull.data.user.login,
    baseSha: pull.data.base.sha,
    baseRef: pull.data.base.ref,
    baseRepository,
    baseRepositoryId,
    headSha: pull.data.head.sha,
    headRef: pull.data.head.ref,
    headRepository,
    headRepositoryId,
    draft: pull.data.draft ?? false,
    isFork: headRepositoryId !== baseRepositoryId,
    changedFiles,
    diffTruncated,
    comments,
  };
}

export async function fetchIssueSnapshot(
  client: GitHubClient,
  context: GitHubContext,
  issueNumber: number,
): Promise<IssueSnapshot> {
  const { owner, repo } = context.repository;
  const issue = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
  const comments = await listExistingComments(client, owner, repo, issueNumber, context);
  const verifiedIssue = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (
    issue.data.number !== verifiedIssue.data.number ||
    issue.data.updated_at !== verifiedIssue.data.updated_at ||
    issue.data.state !== verifiedIssue.data.state
  ) {
    throw new Error("Issue changed while its snapshot was being collected");
  }
  const original = originalEntityText(context, "issue");
  return {
    kind: "issue",
    number: issue.data.number,
    title: boundedUtf8(original.title ?? issue.data.title, MAX_ENTITY_TITLE_BYTES).text,
    body: boundedUtf8(original.body ?? issue.data.body ?? "", MAX_ENTITY_BODY_BYTES).text,
    author: original.author ?? issue.data.user?.login ?? "ghost",
    state: issue.data.state,
    updatedAt: issue.data.updated_at,
    comments,
  };
}

export async function fetchEntitySnapshot(
  client: GitHubClient,
  context: GitHubContext,
  entityNumber: number,
  isPullRequest: boolean,
): Promise<EntitySnapshot> {
  return isPullRequest
    ? fetchPullRequestSnapshot(client, context, entityNumber)
    : fetchIssueSnapshot(client, context, entityNumber);
}

export function extractOriginalTriggerText(context: GitHubContext): string {
  const parsed = triggerPayloadSchema.safeParse(context.payload);
  if (!parsed.success) return "";
  return (
    parsed.data.comment?.body ??
    parsed.data.review?.body ??
    parsed.data.pull_request?.body ??
    parsed.data.issue?.body ??
    ""
  );
}
