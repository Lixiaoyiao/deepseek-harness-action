import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { StickyProgressReporter, renderProgressComment } from "../src/github/progress.js";
import type { ActionFailure } from "../src/result.js";
import type { SecurityPolicy } from "../src/security/policy.js";

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }));

vi.mock("../src/github/comments.js", () => ({ upsertTrackingComment: mocks.upsert }));

const policy: SecurityPolicy = {
  trust: "trusted-read",
  allowed: true,
  reason: "Read-only operation",
  capabilities: {
    readRepository: true,
    readCi: false,
    publishComments: true,
    executeRepositoryCode: false,
    accessNetwork: false,
    modifyWorkspace: false,
    commit: false,
    push: false,
    createPullRequest: false,
  },
};

const failure: ActionFailure = {
  code: "DSH_TIMEOUT",
  phase: "agent",
  title: "DeepSeek Harness timed out",
  message: "The worker exceeded 60 seconds",
  guidance: "Reduce the task scope and rerun.",
  retryable: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsert.mockResolvedValue(42);
});

describe("controller-owned sticky progress", () => {
  it.each([
    ["review", "summary"],
    ["diagnose", "diagnosis"],
    ["task", "task"],
    ["fix", "write"],
    ["implement", "write"],
  ] as const)("reuses the existing %s result marker (%s)", (operation, kind) => {
    const body = renderProgressComment({
      operation,
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
      stage: "context",
      message: "Preparing context",
    });
    expect(body).toContain(`<!-- dsh-action:v1 kind=${kind} -->`);
    expect(body.match(/<!-- dsh-action:v1/gu)).toHaveLength(1);
  });

  it("updates one sticky comment only when the lifecycle body changes", async () => {
    const reporter = new StickyProgressReporter({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 41898282,
      operation: "review",
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
    });

    await reporter.update("context", "Preparing context");
    await reporter.update("context", "Preparing context");
    await reporter.update("agent", "Running the worker");
    await reporter.complete("Published the review");

    expect(mocks.upsert).toHaveBeenCalledTimes(3);
    expect(mocks.upsert).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ issueNumber: 7 }),
      41898282,
      "summary",
      expect.stringContaining("⏳ In progress"),
    );
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      41898282,
      "summary",
      expect.stringContaining("✅ Completed"),
    );
    expect(reporter.commentId).toBe(42);
  });

  it("renders a safe, actionable terminal failure", () => {
    const body = renderProgressComment({
      operation: "fix",
      policy: {
        ...policy,
        trust: "trusted-write",
        reason: "allowed | still untrusted @team\nnext line",
      },
      runUrl: "https://github.com/octo/repo/actions/runs/10",
      stage: "agent",
      message: "unsafe @team ![pixel](https://tracker.invalid) <!-- dsh-action:v1 kind=summary -->",
      failure,
    });

    expect(body).toContain("❌ DeepSeek Harness timed out");
    expect(body).toContain("**Failure code:** `DSH_TIMEOUT` · **Phase:** `agent`");
    expect(body).toContain("**Next step:** Reduce the task scope and rerun.");
    expect(body).toContain("@​team [image removed]");
    expect(body).toContain("allowed \\| still untrusted @​team next line");
    expect(body).not.toContain("kind=summary");
    expect(body).toContain("<!-- dsh-action:v1 kind=write -->");
  });

  it("publishes a classified terminal failure through the same reporter", async () => {
    const reporter = new StickyProgressReporter({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 41898282,
      operation: "review",
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
    });

    await reporter.update("agent", "Running");
    await reporter.fail(failure);

    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      41898282,
      "summary",
      expect.stringContaining("**Failure code:** `DSH_TIMEOUT`"),
    );
    expect(reporter.commentId).toBe(42);
  });

  it("renders blocked as neutral rather than a successful completion", async () => {
    const reporter = new StickyProgressReporter({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 41898282,
      operation: "task",
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
    });
    await reporter.update("agent", "Running");
    await reporter.blocked("A required dependency is unavailable");
    const body = String(mocks.upsert.mock.calls.at(-1)?.[4]);
    expect(body).toContain("⚠️ Blocked");
    expect(body).not.toContain("✅ Completed");
    expect(body).toContain("kind=task");
  });

  it("treats comment API failures as secondary and retries a later stage", async () => {
    const warning = vi.fn();
    const reporter = new StickyProgressReporter({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 41898282,
      operation: "diagnose",
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
      warning,
    });
    mocks.upsert.mockRejectedValueOnce(new Error(`GitHub unavailable ghp_${"a".repeat(36)}`));

    await expect(reporter.update("context", "Preparing context")).resolves.toBeUndefined();
    await expect(reporter.update("agent", "Running")).resolves.toBeUndefined();

    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("[REDACTED_GITHUB_TOKEN]"));
    expect(reporter.commentId).toBe(42);
  });
});
