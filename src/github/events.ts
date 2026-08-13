export const supportedEventNames = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
  "workflow_dispatch",
  "repository_dispatch",
  "schedule",
  "workflow_run",
] as const;

export type SupportedEventName = (typeof supportedEventNames)[number];

export const entityEventNames = [
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_target",
  "pull_request_review",
  "pull_request_review_comment",
] as const satisfies readonly SupportedEventName[];

export const automationEventNames = [
  "workflow_dispatch",
  "repository_dispatch",
  "schedule",
  "workflow_run",
] as const satisfies readonly SupportedEventName[];

export type SemanticEventName = Exclude<SupportedEventName, "pull_request_target">;

export function isSupportedEventName(value: string): value is SupportedEventName {
  return (supportedEventNames as readonly string[]).includes(value);
}

export function isAutomaticReviewAction(action: string | undefined): boolean {
  return (
    action === "opened" ||
    action === "synchronize" ||
    action === "ready_for_review" ||
    action === "reopened"
  );
}
