/*
 * Permission checking is adapted from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */
import type { GitHubClient } from "./client.js";
import type { GitHubContext } from "./context.js";
import { getActorsToCheck, isAllowedActor } from "./actors.js";

export type RepositoryPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export interface ActorAccess {
  readonly actor: string;
  readonly accountType: "User" | "Bot" | "Organization" | "Mannequin" | "Unknown";
  readonly permission: RepositoryPermission;
  readonly hasWrite: boolean;
  readonly allowedBot: boolean;
}

export interface PermissionCheck {
  readonly actors: readonly ActorAccess[];
  readonly allActorsHaveWrite: boolean;
  readonly allActorsAllowedForWrite: boolean;
}

function hasWritePermission(permission: RepositoryPermission): boolean {
  return permission === "write" || permission === "maintain" || permission === "admin";
}

function normalizePermission(permission: string): RepositoryPermission {
  const supported: readonly string[] = ["none", "read", "triage", "write", "maintain", "admin"];
  if (!supported.includes(permission)) return "none";
  return permission as RepositoryPermission;
}

async function getActorAccess(
  client: GitHubClient,
  context: GitHubContext,
  actor: string,
  allowedBots: readonly string[],
): Promise<ActorAccess> {
  let accountType: ActorAccess["accountType"] = "Unknown";
  try {
    const response = await client.rest.users.getByUsername({ username: actor });
    const type = response.data.type;
    if (type === "User" || type === "Bot" || type === "Organization" || type === "Mannequin") {
      accountType = type;
    }
  } catch {
    // Permission lookup below remains authoritative and fails closed.
  }

  const permission: RepositoryPermission = await (async () => {
    try {
      const response = await client.rest.repos.getCollaboratorPermissionLevel({
        owner: context.repository.owner,
        repo: context.repository.repo,
        username: actor,
      });
      return normalizePermission(response.data.permission);
    } catch {
      return "none";
    }
  })();

  const botLike = accountType === "Bot" || accountType === "Unknown" || actor.endsWith("[bot]");
  const allowedBot = botLike && isAllowedActor(actor, allowedBots);
  const hasWrite = hasWritePermission(permission);
  return { actor, accountType, permission, hasWrite, allowedBot };
}

/** Resolve all relevant actor identities; API failures produce no write authority. */
export async function checkActorPermissions(
  client: GitHubClient,
  context: GitHubContext,
  allowedBots: readonly string[] = [],
): Promise<PermissionCheck> {
  const actors = await Promise.all(
    getActorsToCheck(context).map((actor) => getActorAccess(client, context, actor, allowedBots)),
  );
  return {
    actors,
    allActorsHaveWrite: actors.every(({ hasWrite }) => hasWrite),
    allActorsAllowedForWrite: actors.every(({ accountType, hasWrite, allowedBot }) =>
      accountType === "User" ? hasWrite : hasWrite && allowedBot,
    ),
  };
}
