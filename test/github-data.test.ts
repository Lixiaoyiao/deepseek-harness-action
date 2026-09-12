import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { DshAbortedError } from "../src/dsh/errors.js";
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

function issueResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    data: {
      id: 101,
      number: 7,
      title: "Issue",
      body: "body",
      user: { id: 1, login: "alice" },
      state: "open",
      updated_at: "2026-08-14T01:00:00Z",
      ...overrides,
    },
  };
}

function issueClient(responses: readonly ReturnType<typeof issueResponse>[]) {
  const get = vi.fn();
  for (const response of responses) get.mockResolvedValueOnce(response);
  const listComments = vi.fn().mockResolvedValue({ data: [], headers: {} });
  return {
    client: { rest: { issues: { get, listComments } } } as unknown as GitHubClient,
    get,
    listComments,
  };
}

function issueContext() {
  return pullRequestContext({
    rawEventName: "issue_comment",
    eventName: "issue_comment",
    isPullRequest: false,
    pullRequest: undefined,
    payload: {
      issue: issueResponse().data,
      comment: {
        id: 9,
        body: "@dsh task original trigger",
        user: { login: "operator" },
        created_at: "2026-08-14T01:00:00Z",
        updated_at: "2026-08-14T01:00:00Z",
      },
    },
  });
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
          id: 101,
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
          id: 101,
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
      id: 101,
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

describe("bounded Issue snapshot resampling", () => {
  it("uses one complete interval when the first Issue snapshot is stable", async () => {
    const { client, get, listComments } = issueClient([issueResponse(), issueResponse()]);
    await expect(fetchIssueSnapshot(client, issueContext(), 7)).resolves.toMatchObject({
      number: 7,
      updatedAt: "2026-08-14T01:00:00Z",
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(listComments).toHaveBeenCalledOnce();
  });

  it("discards a timestamp-drifted interval and recollects all bounded, trigger-filtered comments", async () => {
    const later = issueResponse({ updated_at: "2026-08-14T01:00:01Z" });
    const { client, get, listComments } = issueClient([issueResponse(), later, later, later]);
    const apiComment = (
      id: number,
      body: string,
      author = "alice",
      time = "2026-08-14T00:59:00Z",
    ) => ({
      id,
      body,
      user: { login: author },
      created_at: time,
      updated_at: time,
    });
    listComments
      .mockResolvedValueOnce({ data: [apiComment(1, "discarded first interval")], headers: {} })
      .mockResolvedValueOnce({
        data: [
          apiComment(2, "stable second interval"),
          apiComment(3, "excluded bot", "renovate[bot]"),
          apiComment(4, "post-trigger content", "alice", "2026-08-14T01:00:01Z"),
          apiComment(9, "mutated trigger", "operator", "2026-08-14T01:00:00Z"),
        ],
        headers: {},
      });
    const snapshot = await fetchIssueSnapshot(client, issueContext(), 7, {
      include: ["alice"],
      exclude: ["renovate[bot]", "operator"],
    });
    expect(snapshot).toMatchObject({
      number: 7,
      state: "open",
      title: "Issue",
      body: "body",
      author: "alice",
      updatedAt: "2026-08-14T01:00:01Z",
      contentFingerprint: issueContentFingerprint({
        number: 7,
        title: "Issue",
        body: "body",
        authorId: 1,
      }),
    });
    expect(snapshot.comments.map(({ id, body }) => ({ id, body }))).toEqual([
      { id: 2, body: "stable second interval" },
      { id: 9, body: "@dsh task original trigger" },
    ]);
    expect(get).toHaveBeenCalledTimes(4);
    expect(listComments).toHaveBeenCalledTimes(2);
    for (const [request] of listComments.mock.calls) {
      expect(request).toEqual({
        owner: "octo",
        repo: "repo",
        issue_number: 7,
        per_page: 100,
        page: 1,
      });
    }
  });

  it("rejects persistent timestamp drift after exactly two complete read intervals", async () => {
    const later = issueResponse({ updated_at: "2026-08-14T01:00:01Z" });
    const last = issueResponse({ updated_at: "2026-08-14T01:00:02Z" });
    const { client, get, listComments } = issueClient([issueResponse(), later, later, last]);
    await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toThrow(
      "Issue changed while its snapshot was being collected (attempt 2/2; fields: updated_at)",
    );
    expect(get).toHaveBeenCalledTimes(4);
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  const unsafeChanges = [
    { field: "number", change: { number: 8 } },
    { field: "id", change: { id: 102 } },
    { field: "state", change: { state: "closed" } },
    { field: "title", change: { title: "private altered title" } },
    { field: "body", change: { body: "private altered body" } },
    { field: "author identity", change: { user: { id: 2, login: "alice" } } },
    { field: "entity kind", change: { pull_request: { url: "private-pull-request-url" } } },
  ];
  it.each(unsafeChanges)(
    "does not retry a changed $field during the first interval",
    async ({ change }) => {
      const { client, get, listComments } = issueClient([issueResponse(), issueResponse(change)]);
      await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toThrow(
        /Issue changed.*attempt 1\/2/u,
      );
      expect(get).toHaveBeenCalledTimes(2);
      expect(listComments).toHaveBeenCalledOnce();
    },
  );

  it.each(unsafeChanges)(
    "never rebases a changed $field after timestamp drift, even without trigger text",
    async ({ change }) => {
      const later = issueResponse({ updated_at: "2026-08-14T01:00:01Z" });
      const modified = issueResponse({ ...change, updated_at: later.data.updated_at });
      const { client, get, listComments } = issueClient([
        issueResponse(),
        later,
        modified,
        modified,
      ]);
      await expect(
        fetchIssueSnapshot(client, { ...issueContext(), payload: {} }, 7),
      ).rejects.toThrow(/Issue changed.*attempt 2\/2/u);
      expect(get).toHaveBeenCalledTimes(3);
      expect(listComments).toHaveBeenCalledOnce();
    },
  );

  it.each(unsafeChanges)(
    "rejects a changed $field at the final verification after resampling",
    async ({ change }) => {
      const later = issueResponse({ updated_at: "2026-08-14T01:00:01Z" });
      const { client, get, listComments } = issueClient([
        issueResponse(),
        later,
        later,
        issueResponse({ ...change, updated_at: later.data.updated_at }),
      ]);
      await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toThrow(
        /Issue changed.*attempt 2\/2/u,
      );
      expect(get).toHaveBeenCalledTimes(4);
      expect(listComments).toHaveBeenCalledTimes(2);
    },
  );

  it("rechecks original trigger authorship on both sides of the second interval", async () => {
    const later = issueResponse({ updated_at: "2026-08-14T01:00:01Z" });
    const renamedAuthor = issueResponse({
      ...later.data,
      user: { id: 1, login: "private-new-login" },
    });
    const { client, get, listComments } = issueClient([
      issueResponse(),
      later,
      later,
      renamedAuthor,
    ]);
    await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toThrow(
      "Issue content changed after the triggering event (attempt 2/2; fields: author)",
    );
    expect(get).toHaveBeenCalledTimes(4);
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  it.each([{ id: 102 }, { id: undefined }, { id: 0 }, { number: 8 }])(
    "rejects an initially mismatched or invalid API identity: %j",
    async (change) => {
      const { client, get, listComments } = issueClient([issueResponse(change)]);
      await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toThrow(
        /fields: identity/u,
      );
      expect(get).toHaveBeenCalledOnce();
      expect(listComments).not.toHaveBeenCalled();
    },
  );

  it.each([{ id: null }, { id: "101" }, { number: 8 }])(
    "rejects malformed trigger identity before making any request: %j",
    async (change) => {
      const { client, get, listComments } = issueClient([]);
      const context = issueContext();
      await expect(
        fetchIssueSnapshot(
          client,
          {
            ...context,
            payload: { ...context.payload, issue: { ...issueResponse().data, ...change } },
          },
          7,
        ),
      ).rejects.toThrow(/fields: identity/u);
      expect(get).not.toHaveBeenCalled();
      expect(listComments).not.toHaveBeenCalled();
    },
  );

  it("rejects an issue number different from the bound context before requesting it", async () => {
    const { client, get } = issueClient([]);
    await expect(fetchIssueSnapshot(client, issueContext(), 8)).rejects.toThrow(
      /fields: identity/u,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it.each(["initial", "comments", "verification", "resample"] as const)(
    "propagates request/cancellation errors at %s without retrying them",
    async (phase) => {
      const failure = phase === "comments" ? new DshAbortedError() : new Error("failed read");
      const later = issueResponse({ updated_at: "2026-08-14T01:00:01Z" });
      const { client, get, listComments } = issueClient(
        phase === "initial"
          ? []
          : phase === "resample"
            ? [issueResponse(), later]
            : [issueResponse()],
      );
      if (phase === "comments") listComments.mockRejectedValueOnce(failure);
      else get.mockRejectedValueOnce(failure);
      await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toBe(failure);
      expect(get).toHaveBeenCalledTimes(
        phase === "initial" || phase === "comments" ? 1 : phase === "verification" ? 2 : 3,
      );
      expect(listComments).toHaveBeenCalledTimes(phase === "initial" ? 0 : 1);
    },
  );

  it("reports only changed field categories, without returning Issue values or timestamps", async () => {
    const { client } = issueClient([
      issueResponse(),
      issueResponse({
        title: "private title",
        body: "private body",
        state: "private state",
        updated_at: "private timestamp",
      }),
    ]);
    await expect(fetchIssueSnapshot(client, issueContext(), 7)).rejects.toThrow(
      "Issue changed while its snapshot was being collected (attempt 1/2; fields: state, content)",
    );
  });
});
