import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { describeActionFailure } from "../src/result.js";
import {
  createPullRequest,
  findPullRequestByOperation,
  revalidatePullRequestHead,
  revalidatePullRequestIdentity,
} from "../src/write/pr.js";
import { revalidateIssueIdentity } from "../src/write/issue.js";
import { assertRemoteBranchHead } from "../src/write/github.js";
import { issueContentFingerprint } from "../src/github/issue-identity.js";

describe("Controller pull-request publication", () => {
  it("reports head drift as a stable domain failure requiring a fresh task", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the GitHub routes exercised by the public write Interface.
    const client = {
      rest: {
        pulls: { get: vi.fn().mockResolvedValue({ data: { head: { sha: "b".repeat(40) } } }) },
      },
    } as unknown as GitHubClient;
    let failure: unknown;
    try {
      await revalidatePullRequestHead(client, "o", "r", 7, "a".repeat(40));
    } catch (error: unknown) {
      failure = error;
    }
    expect(describeActionFailure(failure, "publication")).toMatchObject({
      code: "ENTITY_BINDING_CHANGED",
      category: "domain",
      retryable: false,
      phase: "publication",
    });
  });
  it("classifies a closed or detached pull-request binding without a runtime crash", async () => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the GitHub routes exercised by the public write Interface.
    const client = {
      rest: {
        pulls: {
          get: vi.fn().mockResolvedValue({
            data: {
              state: "closed",
              head: { sha: "a".repeat(40), ref: "feature", repo: null },
              base: { repo: { id: 1 } },
            },
          }),
        },
      },
    } as unknown as GitHubClient;
    await expect(
      revalidatePullRequestIdentity(client, "o", "r", 7, {
        headSha: "a".repeat(40),
        headRef: "feature",
        headRepositoryId: 1,
        baseRepositoryId: 1,
      }),
    ).rejects.toMatchObject({ code: "ENTITY_BINDING_CHANGED", category: "domain" });
  });
  it("classifies Issue or base-ref drift before a new pull request can be written", async () => {
    const issue = { number: 7, title: "Issue", body: "Body", user: { id: 1 }, state: "closed" };
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the GitHub routes exercised by the public write Interface.
    const client = {
      rest: {
        issues: { get: vi.fn().mockResolvedValue({ data: issue }) },
        git: { getRef: vi.fn().mockResolvedValue({ data: { object: { sha: "b".repeat(40) } } }) },
      },
    } as unknown as GitHubClient;
    await expect(
      revalidateIssueIdentity(client, "o", "r", 7, {
        state: "open",
        updatedAt: "2026-10-10T00:00:00Z",
        contentFingerprint: issueContentFingerprint({ ...issue, authorId: issue.user.id }),
      }),
    ).rejects.toMatchObject({ code: "ENTITY_BINDING_CHANGED" });
    await expect(
      assertRemoteBranchHead(client, "o", "r", "main", "a".repeat(40)),
    ).rejects.toMatchObject({ code: "ENTITY_BINDING_CHANGED" });
  });
  it("ignores a reconciliation candidate whose head repository is unavailable", async () => {
    const marker = `<!-- dsh-action:task:v1 operation=${"a".repeat(24)} snapshot=${"b".repeat(24)} -->`;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the GitHub routes exercised by the public write Interface.
    const client = {
      rest: {
        pulls: {
          list: vi.fn().mockResolvedValue({
            data: [
              {
                head: { ref: "dsh/task", repo: null },
                base: { ref: "main", repo: { full_name: "o/r" } },
                body: marker,
              },
            ],
          }),
        },
      },
    } as unknown as GitHubClient;
    await expect(
      findPullRequestByOperation(client, "o", "r", "dsh/task", "main", marker),
    ).resolves.toBeNull();
  });
  it("reconciles a lost PR-create response without sending a second mutation", async () => {
    const marker = `<!-- dsh-action:task:v1 operation=${"a".repeat(24)} snapshot=${"b".repeat(24)} -->`;
    const pull = {
      number: 9,
      html_url: "https://github.com/o/r/pull/9",
      head: { ref: "dsh/task", sha: "c".repeat(40), repo: { full_name: "o/r" } },
      base: { ref: "main", repo: { full_name: "o/r" } },
      body: marker,
    };
    const create = vi.fn().mockRejectedValue(new Error("Response lost"));
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [pull] });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the GitHub routes exercised by the public write Interface.
    const client = { rest: { pulls: { create, list } } } as unknown as GitHubClient;
    await expect(
      createPullRequest(client, "o", "r", "dsh/task", "main", "Task", marker, marker),
    ).resolves.toMatchObject({ number: 9, url: pull.html_url });
    expect(create).toHaveBeenCalledOnce();
  });
  it("preserves the first PR-create failure when the reconciliation read also fails", async () => {
    const marker = `<!-- dsh-action:task:v1 operation=${"a".repeat(24)} snapshot=${"b".repeat(24)} -->`;
    const original = new Error("Create transport failed");
    const create = vi.fn().mockRejectedValue(original);
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: [] })
      .mockRejectedValueOnce(new Error("Read transport failed"));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the GitHub routes exercised by the public write Interface.
    const client = { rest: { pulls: { create, list } } } as unknown as GitHubClient;
    await expect(
      createPullRequest(client, "o", "r", "dsh/task", "main", "Task", marker, marker),
    ).rejects.toBe(original);
    expect(create).toHaveBeenCalledOnce();
  });
});
