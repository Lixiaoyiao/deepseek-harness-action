/* Derived in part from anthropics/claude-code-action tests, MIT licensed. */
import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { parseGitHubContext } from "../src/github/context.js";
import { checkActorPermissions } from "../src/github/permissions.js";
import { pullRequestContext } from "./helpers.js";

function clientWith(
  permissionFor: (actor: string) => string | Error,
  typeFor: (actor: string) => string | Error = () => "User",
): GitHubClient {
  return {
    rest: {
      users: {
        getByUsername: vi.fn(({ username }: { username: string }) => {
          const value = typeFor(username);
          return value instanceof Error
            ? Promise.reject(value)
            : Promise.resolve({ data: { type: value } });
        }),
      },
      repos: {
        getCollaboratorPermissionLevel: vi.fn(({ username }: { username: string }) => {
          const value = permissionFor(username);
          return value instanceof Error
            ? Promise.reject(value)
            : Promise.resolve({ data: { permission: value } });
        }),
      },
    },
  } as unknown as GitHubClient;
}

describe("checkActorPermissions", () => {
  it.each(["write", "maintain", "admin"])("accepts trusted user permission %s", async (level) => {
    const result = await checkActorPermissions(
      clientWith(() => level),
      pullRequestContext(),
    );
    expect(result.allActorsAllowedForWrite).toBe(true);
  });

  it("fails closed when permission lookup fails", async () => {
    const result = await checkActorPermissions(
      clientWith(() => new Error("GitHub unavailable")),
      pullRequestContext(),
    );
    expect(result).toMatchObject({
      allActorsHaveWrite: false,
      allActorsAllowedForWrite: false,
    });
  });

  it("requires an explicitly allowed bot as well as repository write permission", async () => {
    const client = clientWith(
      () => "write",
      () => "Bot",
    );
    const denied = await checkActorPermissions(client, pullRequestContext());
    const allowed = await checkActorPermissions(client, pullRequestContext(), ["alice[bot]"]);
    expect(denied.allActorsAllowedForWrite).toBe(false);
    expect(allowed.allActorsAllowedForWrite).toBe(true);
  });

  it("checks receiver, upstream actor, and rerunner for workflow_run", async () => {
    const context = parseGitHubContext(
      { GITHUB_EVENT_NAME: "workflow_run", GITHUB_ACTOR: "receiver" },
      {
        action: "completed",
        repository: {
          id: 1,
          name: "repo",
          full_name: "octo/repo",
          owner: { login: "octo" },
        },
        workflow_run: {
          id: 2,
          head_sha: "a".repeat(40),
          actor: { login: "originator" },
          triggering_actor: { login: "rerunner" },
        },
      },
    );
    const client = clientWith((actor) => (actor === "originator" ? "read" : "write"));
    const result = await checkActorPermissions(client, context);
    expect(result.actors.map(({ actor }) => actor)).toEqual(["receiver", "originator", "rerunner"]);
    expect(result.allActorsAllowedForWrite).toBe(false);
  });
});
