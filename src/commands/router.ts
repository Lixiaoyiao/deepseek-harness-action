import type { ActionInputs } from "../inputs.js";
import type { GitHubContext } from "../github/context.js";
import { isAutomaticReviewAction } from "../github/events.js";
import { parseCommand, type Operation } from "./parse.js";

export interface CommandSource {
  readonly kind: "explicit-input" | "mention" | "automatic-event";
  readonly body?: string;
}

export interface RoutedCommand {
  readonly operation: Operation;
  readonly source: CommandSource["kind"];
  readonly instructions: string;
}

/**
 * A workflow_run can diagnose a branch without a PR, but fixing requires the
 * controller to bind a same-repository PR identity. Resolve that distinction
 * only after the GitHub API lookup has completed.
 */
export function finalizeWorkflowRunRoute(
  context: GitHubContext,
  command: RoutedCommand,
  hasResolvedPullRequest: boolean,
): RoutedCommand {
  if (
    context.rawEventName === "workflow_run" &&
    command.source === "automatic-event" &&
    command.operation === "fix" &&
    !hasResolvedPullRequest
  ) {
    return { ...command, operation: "diagnose" };
  }
  return command;
}

function mentionBody(context: GitHubContext): string | undefined {
  const payload = context.payload;
  if (context.rawEventName === "issue_comment") {
    const comment = payload.comment;
    if (typeof comment === "object" && comment !== null && "body" in comment) {
      return typeof comment.body === "string" ? comment.body : undefined;
    }
  }
  if (context.rawEventName === "pull_request_review") {
    const review = payload.review;
    if (typeof review === "object" && review !== null && "body" in review) {
      return typeof review.body === "string" ? review.body : undefined;
    }
  }
  if (context.rawEventName === "pull_request_review_comment") {
    const comment = payload.comment;
    if (typeof comment === "object" && comment !== null && "body" in comment) {
      return typeof comment.body === "string" ? comment.body : undefined;
    }
  }
  return undefined;
}

/** Route only trusted action input or the triggering comment/review body. */
export function routeCommand(context: GitHubContext, inputs: ActionInputs): RoutedCommand | null {
  if (inputs.command !== "auto") {
    return { operation: inputs.command, source: "explicit-input", instructions: inputs.prompt };
  }

  const body = mentionBody(context);
  if (body !== undefined) {
    const parsed = parseCommand(body);
    if (parsed !== null) return { ...parsed, source: "mention" };
  }

  if (
    context.eventName === "pull_request" &&
    context.kind === "entity" &&
    isAutomaticReviewAction(context.eventAction)
  ) {
    return { operation: "review", source: "automatic-event", instructions: inputs.prompt };
  }

  if (context.rawEventName === "workflow_run" && context.eventAction === "completed") {
    return {
      operation: inputs.allowWrite ? "fix" : "diagnose",
      source: "automatic-event",
      instructions: inputs.prompt,
    };
  }

  return null;
}
