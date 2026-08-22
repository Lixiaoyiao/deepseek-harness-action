/*
 * Comment endpoint selection follows anthropics/claude-code-action.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import type { GitHubClient } from "./client.js";
import { indexTrackingComments, type TrackingKind } from "../review/tracking.js";

export interface CommentTarget {
  readonly owner: string;
  readonly repo: string;
  readonly issueNumber: number;
}

export interface OwnedComment {
  readonly id: number;
  readonly body?: string | null;
  readonly user?: { id?: number | null } | null;
}

export interface CommentRequestOptions {
  readonly signal?: AbortSignal;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Comment request was cancelled");
}

/**
 * Octokit forwards `request.signal` to fetch. Keep a controller-owned race as
 * well so a custom client or test double that ignores the option cannot pin a
 * lifecycle publication forever after cancellation.
 */
async function waitForCommentRequest<T>(
  request: () => Promise<T>,
  signal: AbortSignal | undefined,
) {
  if (signal === undefined) return await request();
  if (signal.aborted) throw abortReason(signal);
  const promise = request();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish =
      (callback: (value: T) => void) =>
      (value: T): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback(value);
      };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(
        error instanceof Error ? error : new Error("Comment request failed", { cause: error }),
      );
    };
    const abort = (): void => fail(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(finish(resolve), fail);
  });
}

function requestSignal(
  signal: AbortSignal | undefined,
): { readonly request: { readonly signal: AbortSignal } } | Record<string, never> {
  return signal === undefined ? {} : { request: { signal } };
}

export async function listOwnedTrackingComments(
  client: GitHubClient,
  target: CommentTarget,
  expectedAuthorId: number,
  options: CommentRequestOptions = {},
) {
  const comments = await waitForCommentRequest(
    async () =>
      await client.paginate(client.rest.issues.listComments, {
        owner: target.owner,
        repo: target.repo,
        issue_number: target.issueNumber,
        per_page: 100,
        ...requestSignal(options.signal),
      }),
    options.signal,
  );
  return indexTrackingComments(comments, expectedAuthorId);
}

export async function upsertTrackingComment(
  client: GitHubClient,
  target: CommentTarget,
  expectedAuthorId: number,
  kind: Exclude<TrackingKind, "finding">,
  body: string,
  options: CommentRequestOptions = {},
): Promise<number> {
  const index = await listOwnedTrackingComments(client, target, expectedAuthorId, options);
  const existing =
    kind === "summary"
      ? index.summaries.at(-1)
      : kind === "diagnosis"
        ? index.diagnoses.at(-1)
        : kind === "task"
          ? index.tasks.at(-1)
          : index.writes.at(-1);
  if (existing !== undefined) {
    const response = await waitForCommentRequest(
      async () =>
        await client.rest.issues.updateComment({
          owner: target.owner,
          repo: target.repo,
          comment_id: existing.id,
          body,
          ...requestSignal(options.signal),
        }),
      options.signal,
    );
    return response.data.id;
  }
  try {
    const response = await waitForCommentRequest(
      async () =>
        await client.rest.issues.createComment({
          owner: target.owner,
          repo: target.repo,
          issue_number: target.issueNumber,
          body,
          ...requestSignal(options.signal),
        }),
      options.signal,
    );
    return response.data.id;
  } catch (error: unknown) {
    // A network error may be an ambiguous success. Reconcile the exact marker
    // before retrying so a rerun does not create a second sticky comment.
    const reconciled = await listOwnedTrackingComments(client, target, expectedAuthorId, options);
    const recovered =
      kind === "summary"
        ? reconciled.summaries.at(-1)
        : kind === "diagnosis"
          ? reconciled.diagnoses.at(-1)
          : kind === "task"
            ? reconciled.tasks.at(-1)
            : reconciled.writes.at(-1);
    if (recovered !== undefined) return recovered.id;
    throw error;
  }
}
