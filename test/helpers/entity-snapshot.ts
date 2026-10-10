import type { IssueSnapshot, PullRequestSnapshot } from "../../src/github/fetch.js";

export function pullRequestSnapshot(
  overrides: Partial<PullRequestSnapshot> = {},
): PullRequestSnapshot {
  return {
    kind: "pull_request",
    number: 7,
    title: "Review fixture",
    body: "",
    author: "alice",
    baseSha: "b".repeat(40),
    baseRef: "main",
    baseRepository: "octo/repo",
    baseRepositoryId: 1,
    headSha: "a".repeat(40),
    headRef: "feature",
    headRepository: "octo/repo",
    headRepositoryId: 1,
    draft: false,
    isFork: false,
    changedFiles: [],
    diffTruncated: false,
    comments: [],
    ...overrides,
  };
}

export function issueSnapshot(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    kind: "issue",
    number: 7,
    title: "Issue fixture",
    body: "",
    author: "alice",
    state: "open",
    updatedAt: "2026-10-10T00:00:00Z",
    contentFingerprint: "c".repeat(64),
    comments: [],
    ...overrides,
  };
}
