import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { issueContentFingerprint } from "../src/github/issue-identity.js";
import {
  fetchIssueSnapshot,
  fetchPullRequestSnapshot,
  filterCommentsToTriggerTime,
  filterHistoricalCommentsByActor,
} from "../src/github/fetch.js";
import { pullRequestContext } from "./helpers.js";

function comment(
  id: number,
  createdAt: string,
  updatedAt = createdAt,
  body = `comment ${String(id)}`,
) {
  return { id, author: "alice", body, createdAt, updatedAt };
}

function pullResponse(headSha = "a".repeat(40), state = "open") {
  return {
    data: {
      number: 7,
      title: "PR",
      body: "body",
      user: { login: "alice" },
      head: {
        sha: headSha,
        ref: "feature",
        repo: { id: 1, full_name: "octo/repo" },
      },
      base: {
        sha: "b".repeat(40),
        ref: "main",
        repo: { id: 1, full_name: "octo/repo" },
      },
      draft: false,
      state,
    },
  };
}

function pullClient(pulls: readonly ReturnType<typeof pullResponse>[]): GitHubClient {
  const getPull = vi.fn();
  for (const pull of pulls) getPull.mockResolvedValueOnce(pull);
  return {
    rest: {
      pulls: {
        get: getPull,
        listFiles: vi.fn().mockResolvedValue({
          data: [
            {
              filename: "src/value.ts",
              status: "modified",
              additions: 1,
              deletions: 1,
              changes: 2,
              sha: "c".repeat(40),
              patch: "@@ -1 +1 @@\n-old\n+new",
            },
          ],
        }),
      },
      issues: {
        listComments: vi.fn().mockResolvedValue({
          data: [],
          headers: {},
        }),
      },
      git: {
        getBlob: vi.fn().mockResolvedValue({
          data: { encoding: "base64", content: Buffer.from("new").toString("base64") },
        }),
      },
    },
  } as unknown as GitHubClient;
}

describe("GitHub data snapshotting", () => {
  it("filters comments created at or after the triggering comment", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        comment: { id: 9, body: "@dsh review", created_at: "2026-08-14T01:00:00Z" },
      },
    });
    const comments = filterCommentsToTriggerTime(
      [
        comment(1, "2026-08-14T00:59:59Z"),
        comment(2, "2026-08-14T01:00:00Z"),
        comment(9, "2026-08-14T01:00:00Z", "2026-08-14T01:00:00Z", "stale body"),
        comment(3, "2026-08-14T01:00:01Z"),
      ],
      context,
    );
    expect(comments.map(({ id }) => id)).toEqual([1, 9]);
  });

  it("fails closed on malformed or absent trigger timestamps", () => {
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: { comment: { id: 9, body: "@dsh review", created_at: "not-a-date" } },
    });
    expect(filterCommentsToTriggerTime([comment(1, "2026-08-14T00:59:59Z")], context)).toEqual([]);
    expect(
      filterCommentsToTriggerTime([comment(1, "2026-08-14T00:59:59Z")], pullRequestContext()),
    ).toEqual([]);
  });

  it("rejects comments edited at or after the cutoff", () => {
    const context = pullRequestContext({
      payload: { pull_request: { updated_at: "2026-08-14T01:00:00Z" } },
    });
    expect(
      filterCommentsToTriggerTime(
        [
          comment(1, "2026-08-14T00:00:00Z", "2026-08-14T00:59:59Z"),
          comment(2, "2026-08-14T00:00:00Z", "2026-08-14T01:00:00Z"),
          comment(3, "2026-08-14T00:00:00Z", "2026-08-14T01:00:01Z"),
        ],
        context,
      ).map(({ id }) => id),
    ).toEqual([1]);
  });

  it("filters only historical comment context with exclusion precedence", () => {
    const comments = [
      { ...comment(1, "2026-08-14T00:00:00Z"), author: "alice" },
      { ...comment(2, "2026-08-14T00:00:00Z"), author: "renovate[bot]" },
      { ...comment(3, "2026-08-14T00:00:00Z"), author: "bob" },
      { ...comment(9, "2026-08-14T00:00:00Z"), author: "blocked" },
    ];
    expect(
      filterHistoricalCommentsByActor(comments, 9, {
        include: ["alice", "*[bot]"],
        exclude: ["renovate[bot]", "alice"],
      }).map(({ id }) => id),
    ).toEqual([9]);
    expect(filterHistoricalCommentsByActor(comments, undefined).map(({ id }) => id)).toEqual([
      1, 2, 3, 9,
    ]);
  });

  it("aborts when a PR head changes during snapshot collection", async () => {
    const client = pullClient([pullResponse(), pullResponse("d".repeat(40))]);
    await expect(fetchPullRequestSnapshot(client, pullRequestContext(), 7)).rejects.toThrow(
      "Pull request changed",
    );
  });

  it("rejects a PR that is closed before or during snapshot collection", async () => {
    await expect(
      fetchPullRequestSnapshot(
        pullClient([pullResponse("a".repeat(40), "closed")]),
        pullRequestContext(),
        7,
      ),
    ).rejects.toThrow("no longer open");
    await expect(
      fetchPullRequestSnapshot(
        pullClient([pullResponse(), pullResponse("a".repeat(40), "closed")]),
        pullRequestContext(),
        7,
      ),
    ).rejects.toThrow("no longer open");
  });

  it("binds the initial API PR to the webhook snapshot", async () => {
    const client = pullClient([pullResponse("d".repeat(40))]);
    await expect(fetchPullRequestSnapshot(client, pullRequestContext(), 7)).rejects.toThrow(
      "Pull request changed",
    );
  });

  it("uses the webhook copy of the triggering comment", async () => {
    const client = pullClient([pullResponse(), pullResponse()]);
    const listComments = client.rest.issues.listComments as unknown as ReturnType<typeof vi.fn>;
    listComments.mockResolvedValue({
      data: [
        {
          id: 9,
          body: "mutated API body",
          created_at: "2026-08-14T01:00:00Z",
          updated_at: "2026-08-14T01:00:00Z",
          user: { login: "alice" },
        },
      ],
      headers: {},
    });
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        issue: { title: "PR", body: "body", user: { login: "alice" } },
        comment: {
          id: 9,
          body: "@dsh review from webhook",
          created_at: "2026-08-14T01:00:00Z",
          updated_at: "2026-08-14T01:00:00Z",
          user: { login: "alice" },
        },
      },
    });
    const snapshot = await fetchPullRequestSnapshot(client, context, 7);
    expect(snapshot.comments).toMatchObject([{ id: 9, body: "@dsh review from webhook" }]);
  });

  it("applies actor filters while collecting bounded historical comments", async () => {
    const client = pullClient([pullResponse(), pullResponse()]);
    const listComments = client.rest.issues.listComments as unknown as ReturnType<typeof vi.fn>;
    listComments.mockResolvedValue({
      data: [
        {
          id: 1,
          body: "maintainer context",
          created_at: "2026-08-14T00:58:00Z",
          updated_at: "2026-08-14T00:58:00Z",
          user: { login: "alice" },
        },
        {
          id: 2,
          body: "bot context",
          created_at: "2026-08-14T00:59:00Z",
          updated_at: "2026-08-14T00:59:00Z",
          user: { login: "renovate[bot]" },
        },
      ],
      headers: {},
    });
    const context = pullRequestContext({
      rawEventName: "issue_comment",
      eventName: "issue_comment",
      payload: {
        issue: { title: "PR", body: "body", user: { login: "alice" } },
        comment: {
          id: 9,
          body: "@dsh review",
          created_at: "2026-08-14T01:00:00Z",
          updated_at: "2026-08-14T01:00:00Z",
          user: { login: "blocked" },
        },
      },
    });
    const snapshot = await fetchPullRequestSnapshot(client, context, 7, {
      include: ["alice", "*[bot]"],
      exclude: ["renovate[bot]"],
    });
    expect(snapshot.comments.map(({ id }) => id)).toEqual([1, 9]);
  });

  it("aborts when an issue changes during comment collection", async () => {
    const getIssue = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          number: 7,
          title: "Issue",
          body: "body",
          user: { id: 1, login: "alice" },
          state: "open",
          updated_at: "2026-08-14T01:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        data: {
          number: 7,
          title: "Issue",
          body: "changed",
          user: { id: 1, login: "alice" },
          state: "open",
          updated_at: "2026-08-14T01:00:00Z",
        },
      });
    const client = {
      rest: {
        issues: {
          get: getIssue,
          listComments: vi.fn().mockResolvedValue({ data: [], headers: {} }),
        },
      },
    } as unknown as GitHubClient;
    const context = pullRequestContext({
      isPullRequest: false,
      pullRequest: undefined,
      payload: {
        issue: {
          title: "Issue",
          body: "body",
          user: { login: "alice" },
          updated_at: "2026-08-14T01:00:00Z",
        },
      },
    });
    await expect(fetchIssueSnapshot(client, context, 7)).rejects.toThrow("Issue changed");
  });

  it("binds issue content to the trigger while excluding comment-only timestamp drift", async () => {
    const issue = {
      number: 7,
      title: "Issue",
      body: "body",
      user: { id: 1, login: "alice" },
      state: "open",
      updated_at: "2026-08-14T01:00:01Z",
    };
    const client = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: issue }),
          listComments: vi.fn().mockResolvedValue({ data: [], headers: {} }),
        },
      },
    } as unknown as GitHubClient;
    const context = pullRequestContext({
      isPullRequest: false,
      pullRequest: undefined,
      payload: {
        issue: {
          title: "Issue",
          body: "body",
          user: { login: "alice" },
          updated_at: "2026-08-14T01:00:00Z",
        },
      },
    });
    await expect(fetchIssueSnapshot(client, context, 7)).resolves.toMatchObject({
      contentFingerprint: issueContentFingerprint({
        number: 7,
        title: "Issue",
        body: "body",
        authorId: 1,
      }),
    });

    const changedBeforeStart = {
      ...issue,
      title: "Issue edited after trigger",
    };
    const changedClient = {
      rest: {
        issues: {
          get: vi.fn().mockResolvedValue({ data: changedBeforeStart }),
          listComments: vi.fn(),
        },
      },
    } as unknown as GitHubClient;
    await expect(fetchIssueSnapshot(changedClient, context, 7)).rejects.toThrow(
      "changed after the triggering event",
    );
  });
});
