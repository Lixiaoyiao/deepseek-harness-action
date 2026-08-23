/*
 * Actor collection is adapted from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { GitHubContext } from "./context.js";

export function normalizeActor(actor: string): string {
  return actor
    .trim()
    .replace(/^@/u, "")
    .toLowerCase()
    .replace(/\[bot\]$/u, "");
}

export function isAllowedActor(actor: string, allowlist: readonly string[]): boolean {
  const raw = actor.trim().replace(/^@/u, "").toLowerCase();
  const normalized = normalizeActor(actor);
  return allowlist.some((entry) => {
    const pattern = entry.trim().replace(/^@/u, "").toLowerCase();
    if (pattern === "*") return true;
    if (pattern === "*[bot]") return raw.endsWith("[bot]");
    return normalizeActor(pattern) === normalized;
  });
}

export function areContextActorsAllowed(
  context: GitHubContext,
  allowlist: readonly string[],
): boolean {
  return getActorsToCheck(context).every((actor) => isAllowedActor(actor, allowlist));
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
