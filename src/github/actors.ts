/*
 * Actor collection is adapted from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { GitHubContext } from "./context.js";

export function normalizeActor(actor: string): string {
  return actor
    .trim()
    .toLowerCase()
    .replace(/\[bot\]$/u, "");
}

export function isAllowedActor(actor: string, allowlist: readonly string[]): boolean {
  const normalized = normalizeActor(actor);
  return allowlist.some((entry) => entry === "*" || normalizeActor(entry) === normalized);
}

/**
 * workflow_run checks both the receiver actor and the actors responsible for
 * the upstream run. A duplicated identity is checked once.
 */
export function getActorsToCheck(context: GitHubContext): readonly string[] {
  const actors = [context.actor];
  if (context.kind === "automation" && context.workflowRun !== undefined) {
    if (context.workflowRun.actor) actors.push(context.workflowRun.actor);
    if (context.workflowRun.triggeringActor) actors.push(context.workflowRun.triggeringActor);
  }
  return [...new Set(actors.map((actor) => actor.trim()).filter(Boolean))];
}
