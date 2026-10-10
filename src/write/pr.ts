import type { GitHubClient } from "../github/client.js";
import { validateCommitSha, validateRefName } from "../security/refs.js";
import { EntityBindingChangedError } from "./errors.js";
import type { BranchWriteOperationKind } from "./operation-commit.js";

function repositoryId(repository: unknown): number | undefined {
  return typeof repository === "object" &&
    repository !== null &&
    "id" in repository &&
    typeof repository.id === "number"
    ? repository.id
    : undefined;
}

function repositoryName(repository: unknown): string | undefined {
  return typeof repository === "object" &&
    repository !== null &&
    "full_name" in repository &&
    typeof repository.full_name === "string"
    ? repository.full_name.toLowerCase()
    : undefined;
}

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
    throw new EntityBindingChangedError(
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
    repositoryId(headRepo) !== expected.headRepositoryId ||
    repositoryId(pull.data.base.repo) !== expected.baseRepositoryId ||
    expected.headRepositoryId !== expected.baseRepositoryId
  ) {
    throw new EntityBindingChangedError(
      "Pull request identity changed during the run; refusing the trusted write",
    );
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

/** Only same-repository head/base refs and an authenticated marker may be reconciled. */
async function findBoundOperationPullRequest(
  client: GitHubClient,
  owner: string,
  repo: string,
  head: string,
  base: string,
  snapshotForBody: (body: string) => string | undefined,
): Promise<ReconciledPullRequest | null> {
  validateRefName(head);
  validateRefName(base);
  const response = await client.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${head}`,
    base,
    state: "all",
    per_page: 100,
  });
  const fullName = `${owner}/${repo}`.toLowerCase();
  for (const candidate of response.data) {
    if (
      candidate.head.ref !== head ||
      candidate.base.ref !== base ||
      repositoryName(candidate.head.repo) !== fullName ||
      repositoryName(candidate.base.repo) !== fullName
    )
      continue;
    const snapshotFingerprint = snapshotForBody(candidate.body ?? "");
    if (snapshotFingerprint === undefined) continue;
    return {
      number: candidate.number,
      url: candidate.html_url,
      headSha: validateCommitSha(candidate.head.sha),
      snapshotFingerprint,
    };
  }
  return null;
}

export async function findPullRequestByOperation(
  client: GitHubClient,
  owner: string,
  repo: string,
  head: string,
  base: string,
  reconciliationMarker: string,
): Promise<ReconciledPullRequest | null> {
  if (
    !/^<!-- dsh-action:(?:implement|task):v1 operation=[a-f0-9]{24} snapshot=[a-f0-9]{24} -->$/u.test(
      reconciliationMarker,
    )
  ) {
    throw new Error("Invalid pull request reconciliation marker");
  }
  const snapshot = / snapshot=([a-f0-9]{24}) -->$/u.exec(reconciliationMarker)?.[1];
  return await findBoundOperationPullRequest(client, owner, repo, head, base, (body) =>
    body.includes(reconciliationMarker) ? snapshot : undefined,
  );
}

/** A completed operation may legitimately have advanced its original Issue/base snapshot. */
export async function findPullRequestByOperationKey(
  kind: BranchWriteOperationKind,
  client: GitHubClient,
  owner: string,
  repo: string,
  head: string,
  base: string,
  operationKey: string,
): Promise<ReconciledPullRequest | null> {
  if (!/^[a-f0-9]{24}$/u.test(operationKey)) throw new Error("Invalid operation key");
  const marker = new RegExp(
    `<!-- dsh-action:${kind}:v1 operation=${operationKey} snapshot=([a-f0-9]{24}) -->`,
    "u",
  );
  return await findBoundOperationPullRequest(
    client,
    owner,
    repo,
    head,
    base,
    (body) => marker.exec(body)?.[1],
  );
}
