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

export async function listOwnedTrackingComments(
  client: GitHubClient,
  target: CommentTarget,
  expectedAuthorId: number,
) {
  const comments = await client.paginate(client.rest.issues.listComments, {
    owner: target.owner,
    repo: target.repo,
    issue_number: target.issueNumber,
    per_page: 100,
  });
  return indexTrackingComments(comments, expectedAuthorId);
}

export async function upsertTrackingComment(
  client: GitHubClient,
  target: CommentTarget,
  expectedAuthorId: number,
  kind: Exclude<TrackingKind, "finding">,
  body: string,
): Promise<number> {
  const index = await listOwnedTrackingComments(client, target, expectedAuthorId);
  const existing =
    kind === "summary"
      ? index.summaries.at(-1)
      : kind === "diagnosis"
        ? index.diagnoses.at(-1)
        : index.writes.at(-1);
  if (existing !== undefined) {
    const response = await client.rest.issues.updateComment({
      owner: target.owner,
      repo: target.repo,
      comment_id: existing.id,
      body,
    });
    return response.data.id;
  }
  try {
    const response = await client.rest.issues.createComment({
      owner: target.owner,
      repo: target.repo,
      issue_number: target.issueNumber,
      body,
    });
    return response.data.id;
  } catch (error: unknown) {
    // A network error may be an ambiguous success. Reconcile the exact marker
    // before retrying so a rerun does not create a second sticky comment.
    const reconciled = await listOwnedTrackingComments(client, target, expectedAuthorId);
    const recovered =
      kind === "summary"
        ? reconciled.summaries.at(-1)
        : kind === "diagnosis"
          ? reconciled.diagnoses.at(-1)
          : reconciled.writes.at(-1);
    if (recovered !== undefined) return recovered.id;
    throw error;
  }
}
