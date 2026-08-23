import { getOctokit } from "@actions/github";

export type GitHubClient = ReturnType<typeof getOctokit>;

/** The controller owns this client; its token must never enter a DSH child environment. */
export function createGitHubClient(token: string, signal?: AbortSignal): GitHubClient {
  if (token.trim() === "") throw new Error("GitHub token is required");
  return getOctokit(token, {
    userAgent: "dsh-action/0.2",
    ...(signal === undefined ? {} : { request: { signal } }),
  });
}
