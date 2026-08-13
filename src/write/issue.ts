import type { GitHubClient } from "../github/client.js";

export interface BoundIssueIdentity {
  readonly state: string;
  readonly updatedAt: string;
}

/** Revalidate mutable issue state immediately before every externally visible write. */
export async function revalidateIssueIdentity(
  client: GitHubClient,
  owner: string,
  repo: string,
  issueNumber: number,
  expected: BoundIssueIdentity,
): Promise<void> {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error("Issue number must be a positive integer");
  }
  if (expected.state !== "open") {
    throw new Error("Issue is not open; refusing to create an implementation pull request");
  }
  if (!Number.isFinite(Date.parse(expected.updatedAt))) {
    throw new Error("Bound issue updated_at timestamp is invalid");
  }

  const issue = await client.rest.issues.get({ owner, repo, issue_number: issueNumber });
  if (
    issue.data.number !== issueNumber ||
    issue.data.state !== expected.state ||
    issue.data.updated_at !== expected.updatedAt ||
    "pull_request" in issue.data
  ) {
    throw new Error("Issue changed during the run; refusing the trusted write");
  }
}
