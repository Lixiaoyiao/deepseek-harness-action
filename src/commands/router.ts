import type { ActionInputs } from "../inputs.js";
import { areContextActorsAllowed, normalizeActor } from "../github/actors.js";
import type { GitHubContext } from "../github/context.js";
import { isAutomaticReviewAction } from "../github/events.js";
import { parseCommand, type Operation, type RequestedAccess } from "./parse.js";

export interface CommandSource {
  readonly kind: "explicit-input" | "explicit-prompt" | "mention" | "automatic-event";
  readonly body?: string;
}

export interface RoutedCommand {
  readonly operation: Operation;
  readonly source: CommandSource["kind"];
  readonly instructions: string;
  readonly requestedAccess: RequestedAccess;
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
    return { ...command, operation: "diagnose", requestedAccess: "read" };
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

function payloadStringProperty(
  payload: Readonly<Record<string, unknown>>,
  objectName: "label" | "assignee",
  propertyName: "name" | "login",
): string | undefined {
  const value = payload[objectName];
  if (typeof value !== "object" || value === null || !(propertyName in value)) return undefined;
  const property = (value as Record<string, unknown>)[propertyName];
  return typeof property === "string" ? property : undefined;
}

function configuredEntityTrigger(
  context: GitHubContext,
  inputs: ActionInputs,
): RoutedCommand | null {
  if (context.kind !== "entity") return null;
  const label = payloadStringProperty(context.payload, "label", "name");
  const labelMatches =
    inputs.labelTrigger !== "" &&
    context.eventAction === "labeled" &&
    label?.trim().toLowerCase() === inputs.labelTrigger.toLowerCase();
  const assignee = payloadStringProperty(context.payload, "assignee", "login");
  const assigneeMatches =
    inputs.assigneeTrigger !== "" &&
    context.eventAction === "assigned" &&
    assignee !== undefined &&
    normalizeActor(assignee) === normalizeActor(inputs.assigneeTrigger);
  if (!labelMatches && !assigneeMatches) return null;
  return context.isPullRequest
    ? {
        operation: "review",
        source: "automatic-event",
        instructions: inputs.prompt,
        requestedAccess: "read",
      }
    : {
        operation: "task",
        source: "automatic-event",
        instructions: inputs.prompt,
        requestedAccess: inputs.taskAccess,
      };
}

/** Route only trusted action input or the triggering comment/review body. */
export function routeCommand(context: GitHubContext, inputs: ActionInputs): RoutedCommand | null {
  // This is a maintainer-defined routing filter only. Authorization remains a
  // separate Controller decision after GitHub permission and fork checks.
  if (!areContextActorsAllowed(context, inputs.allowedActors)) return null;

  if (inputs.command !== "auto") {
    return {
      operation: inputs.command,
      source: "explicit-input",
      instructions: inputs.prompt,
      requestedAccess:
        inputs.command === "task"
          ? inputs.taskAccess
          : inputs.command === "fix" || inputs.command === "implement"
            ? "write"
            : "read",
    };
  }

  const body = mentionBody(context);
  if (body !== undefined) {
    const parsed = parseCommand(body, inputs.triggerPhrase);
    if (parsed !== null) return { ...parsed, source: "mention" };
  }

  const entityTrigger = configuredEntityTrigger(context, inputs);
  if (entityTrigger !== null) return entityTrigger;

  if (
    context.eventName === "pull_request" &&
    context.kind === "entity" &&
    isAutomaticReviewAction(context.eventAction)
  ) {
    return {
      operation: "review",
      source: "automatic-event",
      instructions: inputs.prompt,
      requestedAccess: "read",
    };
  }

  if (context.rawEventName === "workflow_run" && context.eventAction === "completed") {
    return {
      operation: inputs.allowWrite ? "fix" : "diagnose",
      source: "automatic-event",
      instructions: inputs.prompt,
      requestedAccess: inputs.allowWrite ? "write" : "read",
    };
  }

  if (context.kind === "automation" && inputs.prompt.trim() !== "") {
    return {
      operation: "task",
      source: "explicit-prompt",
      instructions: inputs.prompt,
      requestedAccess: inputs.taskAccess,
    };
  }

  return null;
}
