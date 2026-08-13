import type { GitHubClient } from "../github/client.js";
import { validateCommitSha, validateRefName } from "../security/refs.js";

export async function revalidatePullRequestHead(
  client: GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
  expectedSha: string,
): Promise<void> {
  const expected = validateCommitSha(expectedSha);
  const pull = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pull.data.head.sha !== expected) {
    throw new Error(
      "Pull request head changed during the run; refusing stale write or publication",
    );
  }
}

export interface BoundPullRequestIdentity {
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepositoryId: number;
  readonly baseRepositoryId: number;
}

/** Revalidate every mutable PR identity field before a trusted write. */
export async function revalidatePullRequestIdentity(
  client: GitHubClient,
  owner: string,
  repo: string,
  pullNumber: number,
  expected: BoundPullRequestIdentity,
): Promise<void> {
  const expectedSha = validateCommitSha(expected.headSha);
  validateRefName(expected.headRef);
  const pull = await client.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const headRepo = pull.data.head.repo;
  if (
    pull.data.state !== "open" ||
    pull.data.head.sha !== expectedSha ||
    pull.data.head.ref !== expected.headRef ||
    headRepo.id !== expected.headRepositoryId ||
    pull.data.base.repo.id !== expected.baseRepositoryId ||
    expected.headRepositoryId !== expected.baseRepositoryId
  ) {
    throw new Error("Pull request identity changed during the run; refusing the trusted write");
  }
}

export async function createPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  head: string,
  base: string,
  title: string,
  body: string,
  reconciliationMarker: string,
): Promise<{ number: number; url: string }> {
  validateRefName(head);
  validateRefName(base);
  if (!body.includes(reconciliationMarker)) {
    throw new Error("Pull request body is missing its operation reconciliation marker");
  }
  const existing = await findPullRequestByOperation(
    client,
    owner,
    repo,
    head,
    base,
    reconciliationMarker,
  );
  if (existing !== null) return existing;

  try {
    const response = await client.rest.pulls.create({ owner, repo, head, base, title, body });
    return { number: response.data.number, url: response.data.html_url };
  } catch (error) {
    // The server may have accepted a request whose response was lost. Query the
    // exact operation marker before deciding that creation failed.
    try {
      const reconciled = await findPullRequestByOperation(
        client,
        owner,
        repo,
        head,
        base,
        reconciliationMarker,
      );
      if (reconciled !== null) return reconciled;
    } catch {
      // Preserve the primary create failure when reconciliation itself fails.
    }
    throw error;
  }
}

export interface ReconciledPullRequest {
  readonly number: number;
  readonly url: string;
  readonly headSha: string;
  readonly snapshotFingerprint: string;
}

export async function findPullRequestByOperation(
  client: GitHubClient,
  owner: string,
  repo: string,
  head: string,
  base: string,
  reconciliationMarker: string,
): Promise<ReconciledPullRequest | null> {
  validateRefName(head);
  validateRefName(base);
  if (
    !/^<!-- dsh-action:implement:v1 operation=[a-f0-9]{24} snapshot=[a-f0-9]{24} -->$/u.test(
      reconciliationMarker,
    )
  ) {
    throw new Error("Invalid implementation reconciliation marker");
  }
  const response = await client.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    base,
    state: "all",
    per_page: 100,
  });
  const fullName = `${owner}/${repo}`.toLowerCase();
  const pull = response.data.find(
    (candidate) =>
      candidate.head.ref === head &&
      candidate.base.ref === base &&
      candidate.head.repo.full_name.toLowerCase() === fullName &&
      candidate.body?.includes(reconciliationMarker) === true,
  );
  const snapshotFingerprint = / snapshot=([a-f0-9]{24}) -->$/u.exec(reconciliationMarker)?.[1];
  if (pull === undefined || snapshotFingerprint === undefined) return null;
  return {
    number: pull.number,
    url: pull.html_url,
    headSha: validateCommitSha(pull.head.sha),
    snapshotFingerprint,
  };
}

/** Find a completed prior attempt even if its issue/base snapshot has since advanced. */
export async function findPullRequestByOperationKey(
  client: GitHubClient,
  owner: string,
  repo: string,
  head: string,
  operationKey: string,
): Promise<ReconciledPullRequest | null> {
  validateRefName(head);
  if (!/^[a-f0-9]{24}$/u.test(operationKey)) throw new Error("Invalid operation key");
  const response = await client.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    state: "all",
    per_page: 100,
  });
  const fullName = `${owner}/${repo}`.toLowerCase();
  const marker = new RegExp(
    `<!-- dsh-action:implement:v1 operation=${operationKey} snapshot=([a-f0-9]{24}) -->`,
    "u",
  );
  for (const candidate of response.data) {
    if (candidate.head.ref !== head || candidate.head.repo.full_name.toLowerCase() !== fullName) {
      continue;
    }
    const snapshotFingerprint = marker.exec(candidate.body ?? "")?.[1];
    if (snapshotFingerprint !== undefined) {
      return {
        number: candidate.number,
        url: candidate.html_url,
        headSha: validateCommitSha(candidate.head.sha),
        snapshotFingerprint,
      };
    }
  }
  return null;
}
