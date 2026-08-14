import { describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import type { PullRequestSnapshot } from "../src/github/fetch.js";
import { publishPullRequestReview } from "../src/review/publisher.js";
import type { ReviewFinding, ReviewResult } from "../src/review/schema.js";
import { createTrackingMarker } from "../src/review/tracking.js";

const BOT_ID = 41_898_282;
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "Authorization is checked after the write",
    body: "A caller can mutate the record before its identity is verified.",
    severity: "high",
    category: "security",
    confidence: 0.96,
    path: "src/handler.ts",
    line: 2,
    side: "RIGHT",
    evidence: "updateRecord executes before requireUser.",
    suggestion: "Move requireUser before updateRecord.",
    ...overrides,
  };
}

function review(findings: readonly ReviewFinding[], summary = "One issue found."): ReviewResult {
  return { summary, findings: [...findings] };
}

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    kind: "pull_request",
    number: 7,
    title: "Harden record updates",
    body: "PR body",
    author: "alice",
    baseSha: BASE_SHA,
    baseRef: "main",
    baseRepository: "octo/repo",
    baseRepositoryId: 1,
    headSha: HEAD_SHA,
    headRef: "feature",
    headRepository: "octo/repo",
    headRepositoryId: 1,
    draft: false,
    isFork: false,
    changedFiles: [
      {
        path: "src/handler.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: "@@ -1,2 +1,2 @@\n const ready = true;\n-updateRecord();\n+updateRecordSafely();",
        patchMissing: false,
        patchTruncated: false,
        sourceTruncated: false,
      },
    ],
    diffTruncated: false,
    comments: [],
    ...overrides,
  };
}

function pullResponse(headSha = HEAD_SHA) {
  return {
    data: {
      number: 7,
      state: "open",
      head: { sha: headSha, ref: "feature", repo: { id: 1, full_name: "octo/repo" } },
      base: { sha: BASE_SHA, ref: "main", repo: { id: 1, full_name: "octo/repo" } },
    },
  };
}

interface StoredComment {
  id: number;
  body: string;
  user: { id: number };
  commit_id?: string;
  path?: string;
  line?: number;
  side?: string;
}

function fakeClient(
  options: {
    inlineComments?: StoredComment[];
    issueComments?: StoredComment[];
    pulls?: readonly ReturnType<typeof pullResponse>[];
  } = {},
) {
  const inlineComments = options.inlineComments ?? [];
  const issueComments = options.issueComments ?? [];
  const listReviewComments = vi.fn();
  const listIssueComments = vi.fn();
  const getPull = vi.fn();
  for (const response of options.pulls ?? [pullResponse()]) {
    getPull.mockResolvedValueOnce(response);
  }
  getPull.mockResolvedValue(pullResponse());

  const createReviewComment = vi.fn(
    (input: { body: string; commit_id: string; path: string; line: number; side: string }) => {
      const comment = {
        id: 100 + inlineComments.length,
        body: input.body,
        user: { id: BOT_ID },
        commit_id: input.commit_id,
        path: input.path,
        line: input.line,
        side: input.side,
      };
      inlineComments.push(comment);
      return Promise.resolve({ data: comment });
    },
  );
  const updateReviewComment = vi.fn((input: { comment_id: number; body: string }) => {
    const comment = inlineComments.find(({ id }) => id === input.comment_id);
    if (comment !== undefined) comment.body = input.body;
    return Promise.resolve({ data: comment });
  });
  const createComment = vi.fn((input: { body: string }) => {
    const comment = {
      id: 200 + issueComments.length,
      body: input.body,
      user: { id: BOT_ID },
    };
    issueComments.push(comment);
    return Promise.resolve({ data: comment });
  });
  const updateComment = vi.fn((input: { comment_id: number; body: string }) => {
    const comment = issueComments.find(({ id }) => id === input.comment_id);
    if (comment !== undefined) comment.body = input.body;
    return Promise.resolve({ data: comment });
  });

  const value = {
    paginate: vi.fn((endpoint: unknown) => {
      if (endpoint === listReviewComments) return Promise.resolve([...inlineComments]);
      if (endpoint === listIssueComments) return Promise.resolve([...issueComments]);
      throw new Error("unexpected pagination endpoint");
    }),
    rest: {
      pulls: {
        get: getPull,
        listReviewComments,
        createReviewComment,
        updateReviewComment,
      },
      issues: { listComments: listIssueComments, createComment, updateComment },
    },
  };

  return {
    value: value as unknown as GitHubClient,
    inlineComments,
    issueComments,
    getPull,
    createReviewComment,
    updateReviewComment,
    createComment,
    updateComment,
  };
}

const target = {
  owner: "octo",
  repo: "repo",
  pullNumber: 7,
  expectedAuthorId: BOT_ID,
  runUrl: "https://github.com/octo/repo/actions/runs/123",
} as const;

describe("publishPullRequestReview", () => {
  it("publishes an exact inline comment and a controller-owned sticky summary", async () => {
    const fake = fakeClient();
    const result = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([finding()]),
      20,
    );

    expect(result).toEqual({
      selected: 1,
      inlinePublished: 1,
      inlineUpdated: 0,
      duplicatesSkipped: 0,
      summaryOnly: 0,
      failures: [],
    });
    expect(fake.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        pull_number: 7,
        commit_id: HEAD_SHA,
        path: "src/handler.ts",
        line: 2,
        side: "RIGHT",
      }),
    );
    expect(fake.inlineComments[0]?.body).toMatch(
      /<!-- dsh-action:v1 kind=finding fingerprint=[a-f0-9]{64} -->/u,
    );
    expect(fake.issueComments).toHaveLength(1);
    expect(fake.issueComments[0]?.body).toContain(createTrackingMarker({ kind: "summary" }));
    expect(fake.issueComments[0]?.body).toContain("**Inline:** 1");
  });

  it("skips an identical rerun and updates changed prose at the same fingerprint/location", async () => {
    const fake = fakeClient();
    const first = finding();
    await publishPullRequestReview(fake.value, target, snapshot(), review([first]), 20);

    const duplicate = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([first], "Second run"),
      20,
    );
    expect(duplicate).toMatchObject({ duplicatesSkipped: 1, inlinePublished: 0 });

    const rewritten = finding({
      category: "correctness",
      title: "Mutation can precede caller verification",
      body: "The write happens before authorization, allowing an unauthorized mutation.",
      evidence: "The mutation call is reached before the user guard.",
      suggestion: "Authorize the caller first, then perform the write.",
    });
    const updated = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([rewritten], "Third run"),
      20,
    );
    expect(updated).toMatchObject({ inlineUpdated: 1, inlinePublished: 0 });
    expect(fake.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.updateReviewComment).toHaveBeenCalledOnce();
    expect(fake.inlineComments).toHaveLength(1);
    expect(fake.inlineComments[0]?.body).toContain("Authorize the caller first");
    expect(fake.createComment).toHaveBeenCalledOnce();
    expect(fake.updateComment).toHaveBeenCalledTimes(2);
  });

  it("does not create another inline when synchronize moves the same source anchor", async () => {
    const fake = fakeClient();
    await publishPullRequestReview(fake.value, target, snapshot(), review([finding()]), 20);

    const nextHead = "c".repeat(40);
    fake.getPull.mockReset();
    fake.getPull.mockResolvedValue(pullResponse(nextHead));
    const movedSnapshot = snapshot({
      headSha: nextHead,
      changedFiles: [
        {
          path: "src/handler.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2,
          patch:
            "@@ -10,2 +10,2 @@\n const ready = true;\n-updateRecord();\n+updateRecordSafely();",
          patchMissing: false,
          patchTruncated: false,
          sourceTruncated: false,
        },
      ],
    });
    const movedFinding = finding({
      title: "Caller authorization occurs too late",
      body: "The record may be changed before the caller is authorized.",
      evidence: "The user guard still occurs after the update.",
      line: 11,
    });

    const synchronized = await publishPullRequestReview(
      fake.value,
      target,
      movedSnapshot,
      review([movedFinding], "Finding remains after synchronize."),
      20,
    );

    expect(synchronized).toMatchObject({
      inlinePublished: 0,
      inlineUpdated: 0,
      duplicatesSkipped: 1,
      summaryOnly: 1,
      failures: [],
    });
    expect(fake.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.updateReviewComment).not.toHaveBeenCalled();
    expect(fake.inlineComments).toHaveLength(1);
    expect(fake.issueComments[0]?.body).toContain("Findings carried in the summary");
    expect(fake.issueComments[0]?.body).toContain("`src/handler.ts:11`");
    expect(fake.issueComments[0]?.body).toContain("Caller authorization occurs too late");
  });

  it("keeps an invalid diff anchor summary-only without guessing a line", async () => {
    const fake = fakeClient();
    const offDiff = finding({ line: 99, title: "Off-diff regression" });
    const result = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([offDiff]),
      20,
    );

    expect(result).toMatchObject({ inlinePublished: 0, summaryOnly: 1, failures: [] });
    expect(fake.createReviewComment).not.toHaveBeenCalled();
    expect(fake.issueComments[0]?.body).toContain("Findings carried in the summary");
    expect(fake.issueComments[0]?.body).toContain("`src/handler.ts:99`");
  });

  it("falls back to the summary when the inline API rejects a valid anchor", async () => {
    const fake = fakeClient();
    fake.createReviewComment.mockRejectedValueOnce(new Error("422 line is no longer valid"));
    const result = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([finding()]),
      20,
    );

    expect(result).toMatchObject({ inlinePublished: 0, summaryOnly: 1 });
    expect(result.failures).toEqual([expect.stringContaining("422 line is no longer valid")]);
    expect(fake.issueComments[0]?.body).toContain("Publication warnings");
    expect(fake.issueComments[0]?.body).toContain("Findings carried in the summary");
    expect(fake.issueComments[0]?.body).toContain("Authorization is checked after the write");
  });

  it("recovers on rerun when inline succeeded but sticky summary publication failed", async () => {
    const fake = fakeClient();
    fake.createComment.mockRejectedValueOnce(new Error("summary endpoint unavailable"));

    await expect(
      publishPullRequestReview(fake.value, target, snapshot(), review([finding()]), 20),
    ).rejects.toThrow("summary endpoint unavailable");
    expect(fake.inlineComments).toHaveLength(1);
    expect(fake.issueComments).toHaveLength(0);

    const recovered = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([finding()]),
      20,
    );
    expect(recovered).toMatchObject({
      inlinePublished: 0,
      duplicatesSkipped: 1,
      failures: [],
    });
    expect(fake.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.issueComments).toHaveLength(1);
  });

  it("aborts before publication when the PR head already drifted", async () => {
    const fake = fakeClient({ pulls: [pullResponse("d".repeat(40))] });
    await expect(
      publishPullRequestReview(fake.value, target, snapshot(), review([finding()]), 20),
    ).rejects.toThrow("Pull request changed");
    expect(fake.createReviewComment).not.toHaveBeenCalled();
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("does not publish a stale summary if the head force-pushes after an inline partial success", async () => {
    const fake = fakeClient({ pulls: [pullResponse(), pullResponse("d".repeat(40))] });
    await expect(
      publishPullRequestReview(fake.value, target, snapshot(), review([finding()]), 20),
    ).rejects.toThrow("Pull request changed");
    expect(fake.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("ignores a forged finding marker unless its author id matches the controller", async () => {
    const item = finding();
    const genuine = fakeClient();
    await publishPullRequestReview(genuine.value, target, snapshot(), review([item]), 20);
    const genuineBody = genuine.inlineComments[0]?.body;
    expect(genuineBody).toBeDefined();
    const forged = {
      id: 9,
      user: { id: 666 },
      body: genuineBody ?? "",
      commit_id: HEAD_SHA,
      path: item.path,
      line: item.line,
      side: "RIGHT",
    };
    const fake = fakeClient({ inlineComments: [forged] });
    const result = await publishPullRequestReview(
      fake.value,
      target,
      snapshot(),
      review([item]),
      20,
    );

    expect(result).toMatchObject({ inlinePublished: 1, duplicatesSkipped: 0 });
    expect(fake.createReviewComment).toHaveBeenCalledOnce();
    expect(fake.inlineComments).toHaveLength(2);
  });
});
