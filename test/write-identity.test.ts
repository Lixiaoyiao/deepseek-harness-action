import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { buildDshBranch } from "../src/write/branch.js";
import {
  buildImplementationOperation,
  findReconciledImplementationCommit,
} from "../src/write/implementation.js";
import { revalidateIssueIdentity } from "../src/write/issue.js";
import {
  createPullRequest,
  findPullRequestByOperation,
  revalidatePullRequestIdentity,
} from "../src/write/pr.js";
import {
  assertEquivalentTaskCommit,
  assertTaskCommitOwned,
  buildAutomationTaskOperation,
  findReconciledTaskCommit,
} from "../src/write/task.js";

function implementation() {
  return buildImplementationOperation({
    owner: "octo",
    repo: "repo",
    issueNumber: 7,
    issueState: "open",
    issueUpdatedAt: "2026-08-14T00:00:00Z",
    baseSha: "a".repeat(40),
    runIdentity: "12345",
  });
}

describe("write identity and reconciliation", () => {
  it("builds stable operation identities and safe branch slugs", () => {
    const first = implementation();
    const second = implementation();
    expect(second).toEqual(first);
    expect(first.branch).toMatch(/^dsh\/7-implement-/u);
    expect(first.commitMessage).toContain("DSH-Operation-Key:");
    expect(first.pullRequestMarker).toContain("dsh-action:implement:v1");
    expect(buildDshBranch(1, "🔐", "run 1")).toBe("dsh/1-task-run-1");
    expect(() => buildDshBranch(0, "bad")).toThrow("positive integer");
    expect(() =>
      buildImplementationOperation({
        owner: "o",
        repo: "r",
        issueNumber: 1,
        issueState: "open",
        issueUpdatedAt: "2026-08-14T00:00:00Z",
        baseSha: "a".repeat(40),
        runIdentity: "",
      }),
    ).toThrow("run identity");
  });

  it("revalidates an unchanged open issue and rejects mutable identity drift", async () => {
    const get = vi.fn().mockResolvedValue({
      data: { number: 7, state: "open", updated_at: "2026-08-14T00:00:00Z" },
    });
    const client = { rest: { issues: { get } } } as unknown as GitHubClient;
    const identity = { state: "open", updatedAt: "2026-08-14T00:00:00Z" };
    await expect(revalidateIssueIdentity(client, "o", "r", 7, identity)).resolves.toBeUndefined();

    get.mockResolvedValueOnce({
      data: { number: 7, state: "closed", updated_at: identity.updatedAt },
    });
    await expect(revalidateIssueIdentity(client, "o", "r", 7, identity)).rejects.toThrow(
      "Issue changed",
    );
    await expect(revalidateIssueIdentity(client, "o", "r", 0, identity)).rejects.toThrow(
      "positive integer",
    );
    await expect(
      revalidateIssueIdentity(client, "o", "r", 7, {
        state: "closed",
        updatedAt: identity.updatedAt,
      }),
    ).rejects.toThrow("not open");
    await expect(
      revalidateIssueIdentity(client, "o", "r", 7, { state: "open", updatedAt: "invalid" }),
    ).rejects.toThrow("timestamp");
  });

  it("recognizes only controller-owned orphan commits", async () => {
    const operation = implementation();
    const head = "b".repeat(40);
    const getRef = vi.fn().mockResolvedValue({ data: { object: { sha: head } } });
    const getCommit = vi.fn().mockResolvedValue({
      data: {
        sha: head,
        message: operation.commitMessage,
        parents: [{ sha: "a".repeat(40) }],
      },
    });
    const client = { rest: { git: { getRef, getCommit } } } as unknown as GitHubClient;
    await expect(
      findReconciledImplementationCommit(client, "o", "r", operation, "a".repeat(40)),
    ).resolves.toBe(head);

    getCommit.mockResolvedValueOnce({
      data: { sha: head, message: "attacker commit", parents: [{ sha: "a".repeat(40) }] },
    });
    await expect(
      findReconciledImplementationCommit(client, "o", "r", operation, "a".repeat(40)),
    ).rejects.toThrow("does not belong");
  });

  it("builds stable generic task identities without binding them to an issue", () => {
    const input = {
      owner: "Octo",
      repo: "Repo",
      baseSha: "a".repeat(40),
      runIdentity: "run-123-attempt-2",
      taskIdentity: "normalized-task-and-config",
    };
    const first = buildAutomationTaskOperation(input);
    expect(buildAutomationTaskOperation(input)).toEqual(first);
    expect(first.branch).toMatch(/^dsh\/task-[a-f0-9]{24}$/u);
    expect(first.commitMessage).toContain(`DSH-Task-Key: ${first.key}`);
    expect(first.pullRequestMarker).toContain("dsh-action:task:v1");
    expect(() => buildAutomationTaskOperation({ ...input, runIdentity: "" })).toThrow(
      "run identity",
    );
    expect(() => buildAutomationTaskOperation({ ...input, runIdentity: "bad\0run" })).toThrow(
      "run identity",
    );
  });

  it("reconciles only a task branch with the exact base and operation commit", async () => {
    const operation = buildAutomationTaskOperation({
      owner: "o",
      repo: "r",
      baseSha: "a".repeat(40),
      runIdentity: "run-1",
      taskIdentity: "task-1",
    });
    const head = "b".repeat(40);
    const getRef = vi.fn().mockResolvedValue({ data: { object: { sha: head } } });
    const getCommit = vi.fn().mockResolvedValue({
      data: {
        sha: head,
        message: operation.commitMessage,
        parents: [{ sha: "a".repeat(40) }],
      },
    });
    const client = { rest: { git: { getRef, getCommit } } } as unknown as GitHubClient;
    await expect(
      findReconciledTaskCommit(client, "o", "r", operation, "a".repeat(40)),
    ).resolves.toBe(head);

    getCommit.mockResolvedValueOnce({
      data: { sha: head, message: operation.commitMessage, parents: [{ sha: "c".repeat(40) }] },
    });
    await expect(
      findReconciledTaskCommit(client, "o", "r", operation, "a".repeat(40)),
    ).rejects.toThrow("does not belong");

    getRef.mockRejectedValueOnce({ status: 404 });
    await expect(
      findReconciledTaskCommit(client, "o", "r", operation, "a".repeat(40)),
    ).resolves.toBeNull();
  });

  it("validates task ownership trailers and equivalent orphan trees", async () => {
    const operation = buildAutomationTaskOperation({
      owner: "o",
      repo: "r",
      baseSha: "a".repeat(40),
      runIdentity: "run-1",
      taskIdentity: "task-1",
    });
    const existing = "b".repeat(40);
    const candidate = "c".repeat(40);
    const commit = (sha: string, tree = "tree-1") => ({
      data: {
        sha,
        message: operation.commitMessage,
        parents: [{ sha: "a".repeat(40) }],
        tree: { sha: tree },
      },
    });
    const getCommit = vi
      .fn()
      .mockResolvedValueOnce(commit(existing))
      .mockResolvedValueOnce(commit(existing))
      .mockResolvedValueOnce(commit(candidate));
    const client = { rest: { git: { getCommit } } } as unknown as GitHubClient;
    await expect(
      assertTaskCommitOwned(
        client,
        "o",
        "r",
        existing,
        operation.key,
        operation.snapshotFingerprint,
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertEquivalentTaskCommit(client, "o", "r", existing, candidate, operation, "a".repeat(40)),
    ).resolves.toBeUndefined();

    await expect(
      assertTaskCommitOwned(client, "o", "r", existing, "not-a-key", operation.snapshotFingerprint),
    ).rejects.toThrow("Invalid task operation identity");

    getCommit
      .mockResolvedValueOnce(commit(existing, "tree-1"))
      .mockResolvedValueOnce(commit(candidate, "tree-2"));
    await expect(
      assertEquivalentTaskCommit(client, "o", "r", existing, candidate, operation, "a".repeat(40)),
    ).rejects.toThrow("differs");
  });

  it("finds and reconciles operation-marked pull requests", async () => {
    const operation = implementation();
    const candidate = {
      number: 9,
      html_url: "https://github.com/octo/repo/pull/9",
      head: { ref: operation.branch, repo: { full_name: "octo/repo" } },
      base: { ref: "main" },
      body: operation.pullRequestMarker,
    };
    Object.assign(candidate.head, { sha: "b".repeat(40) });
    const list = vi.fn().mockResolvedValue({ data: [candidate] });
    const create = vi.fn();
    const client = { rest: { pulls: { list, create } } } as unknown as GitHubClient;

    await expect(
      findPullRequestByOperation(
        client,
        "octo",
        "repo",
        operation.branch,
        "main",
        operation.pullRequestMarker,
      ),
    ).resolves.toEqual({
      number: 9,
      url: candidate.html_url,
      headSha: "b".repeat(40),
      snapshotFingerprint: operation.snapshotFingerprint,
    });
    await expect(
      createPullRequest(
        client,
        "octo",
        "repo",
        operation.branch,
        "main",
        "title",
        operation.pullRequestMarker,
        operation.pullRequestMarker,
      ),
    ).resolves.toEqual({
      number: 9,
      url: candidate.html_url,
      headSha: "b".repeat(40),
      snapshotFingerprint: operation.snapshotFingerprint,
    });
    expect(create).not.toHaveBeenCalled();

    await expect(
      createPullRequest(
        client,
        "octo",
        "repo",
        operation.branch,
        "main",
        "title",
        "body",
        operation.pullRequestMarker,
      ),
    ).rejects.toThrow("missing");
  });

  it("revalidates the full same-repository PR identity", async () => {
    const identity = {
      headSha: "a".repeat(40),
      headRef: "feature",
      headRepositoryId: 1,
      baseRepositoryId: 1,
    };
    const get = vi.fn().mockResolvedValue({
      data: {
        state: "open",
        head: { sha: identity.headSha, ref: identity.headRef, repo: { id: 1 } },
        base: { repo: { id: 1 } },
      },
    });
    const client = { rest: { pulls: { get } } } as unknown as GitHubClient;
    await expect(
      revalidatePullRequestIdentity(client, "o", "r", 7, identity),
    ).resolves.toBeUndefined();
    get.mockResolvedValueOnce({
      data: {
        state: "closed",
        head: { sha: identity.headSha, ref: identity.headRef, repo: { id: 1 } },
        base: { repo: { id: 1 } },
      },
    });
    await expect(revalidatePullRequestIdentity(client, "o", "r", 7, identity)).rejects.toThrow(
      "identity changed",
    );
  });
});
