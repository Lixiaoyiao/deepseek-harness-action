import { issueContentFingerprint } from "../github/issue-identity.js";
import type { GitHubBackendRequestControl, GitHubToolBackend } from "./github-backend.js";
import type { GitHubToolBinding } from "./github-catalog.js";

export type GitHubEntityBinding = Extract<GitHubToolBinding, { target: "issue" | "pull_request" }>;

export class GitHubEntityRevalidationError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Trusted GitHub entity binding failed immediate revalidation", options);
    this.name = "GitHubEntityRevalidationError";
  }
}

/** Re-read identity-bearing fields immediately before a bound entity mutation. */
export async function revalidateGitHubEntity(
  backend: GitHubToolBackend,
  binding: GitHubEntityBinding,
  allowClosed: boolean,
  control: GitHubBackendRequestControl,
): Promise<void> {
  if (binding.target === "issue") {
    const target = {
      owner: binding.owner,
      repo: binding.repo,
      issueNumber: binding.entityNumber,
    } as const;
    const [repository, issue] = await Promise.all([
      backend.getRepository(target, control),
      backend.getIssue(target, control),
    ]);
    const fingerprint = issueContentFingerprint({
      number: issue.number,
      title: issue.title,
      body: issue.body,
      authorId: issue.authorId,
    });
    if (
      repository.id !== binding.repositoryId ||
      issue.number !== binding.entityNumber ||
      issue.kind !== "issue" ||
      fingerprint !== binding.contentFingerprint ||
      (issue.state === "closed" && !allowClosed)
    ) {
      throw new Error("Bound issue identity or state changed before GitHub tool mutation");
    }
    return;
  }

  const pull = await backend.getPull(
    { owner: binding.owner, repo: binding.repo, pullNumber: binding.entityNumber },
    control,
  );
  if (
    pull.number !== binding.entityNumber ||
    pull.headSha !== binding.headSha ||
    pull.headRef !== binding.headRef ||
    pull.headRepositoryId !== binding.headRepositoryId ||
    pull.baseSha !== binding.baseSha ||
    pull.baseRef !== binding.baseRef ||
    pull.baseRepositoryId !== binding.baseRepositoryId ||
    binding.headRepositoryId !== binding.baseRepositoryId ||
    (pull.state === "closed" && !allowClosed)
  ) {
    throw new Error("Bound pull request identity or state changed before GitHub tool mutation");
  }
}
