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
    loadExtensions: true,
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

const abortedFailure: ActionFailure = {
  code: "DSH_ABORTED",
  phase: "agent",
  title: "DeepSeek Harness was cancelled",
  message: "The controller received SIGTERM",
  guidance: "Rerun if needed.",
  retryable: true,
};

const integrityFailure: ActionFailure = {
  code: "VALIDATION_INTEGRITY",
  phase: "validation",
  title: "Validation integrity failed",
  message: "A protected validation dependency changed",
  guidance: "Restore the validation boundary.",
  retryable: false,
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
      expect.anything(),
    );
    expect(mocks.upsert).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      41898282,
      "summary",
      expect.stringContaining("✅ Completed"),
      expect.anything(),
    );
    expect((mocks.upsert.mock.calls[0]?.[5] as { signal?: unknown }).signal).toBeInstanceOf(
      AbortSignal,
    );
    expect((mocks.upsert.mock.calls.at(-1)?.[5] as { signal?: unknown }).signal).toBeInstanceOf(
      AbortSignal,
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
      expect.anything(),
    );
    expect((mocks.upsert.mock.calls.at(-1)?.[5] as { signal?: unknown }).signal).toBeInstanceOf(
      AbortSignal,
    );
    expect(reporter.commentId).toBe(42);
  });

  it.each(["context", "agent"] as const)(
    "aborts a permanently pending %s publication and starts the terminal update independently",
    async (stage) => {
      let nonTerminalSignal: AbortSignal | undefined;
      let terminalSignal: AbortSignal | undefined;
      mocks.upsert
        .mockImplementationOnce((...args: unknown[]) => {
          nonTerminalSignal = (args[5] as { signal: AbortSignal }).signal;
          return new Promise<number>(() => undefined);
        })
        .mockImplementationOnce((...args: unknown[]) => {
          terminalSignal = (args[5] as { signal: AbortSignal }).signal;
          return Promise.resolve(42);
        });
      const reporter = new StickyProgressReporter({
        client: {} as GitHubClient,
        target: { owner: "octo", repo: "repo", issueNumber: 7 },
        expectedAuthorId: 41898282,
        operation: "task",
        policy,
        runUrl: "https://github.com/octo/repo/actions/runs/10",
      });

      void reporter.update(stage, "Running");
      await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalledOnce());
      const queued = reporter.update("finalizing", "Queued before cancellation");
      const failing = reporter.fail(failure);
      await Promise.all([queued, failing]);
      await reporter.update("agent", "Late worker update");

      expect(nonTerminalSignal?.aborted).toBe(true);
      expect(terminalSignal?.aborted).toBe(false);
      expect(terminalSignal).not.toBe(nonTerminalSignal);
      expect(mocks.upsert).toHaveBeenCalledTimes(2);
      expect(String(mocks.upsert.mock.calls[1]?.[4])).toContain("**Failure code:** `DSH_TIMEOUT`");
      expect(String(mocks.upsert.mock.calls[1]?.[4])).not.toContain("⏳ In progress");
    },
  );

  it("replaces an in-flight provisional cancellation with the authoritative primary failure", async () => {
    let provisionalSignal: AbortSignal | undefined;
    let correctionSignal: AbortSignal | undefined;
    mocks.upsert
      .mockImplementationOnce((...args: unknown[]) => {
        provisionalSignal = (args[5] as { signal: AbortSignal }).signal;
        return new Promise<number>(() => undefined);
      })
      .mockImplementationOnce((...args: unknown[]) => {
        correctionSignal = (args[5] as { signal: AbortSignal }).signal;
        return Promise.resolve(42);
      });
    const reporter = new StickyProgressReporter({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 41898282,
      operation: "task",
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
    });

    void reporter.fail(abortedFailure);
    await vi.waitFor(() => expect(mocks.upsert).toHaveBeenCalledOnce());
    await reporter.fail(integrityFailure);

    expect(provisionalSignal?.aborted).toBe(true);
    expect(correctionSignal?.aborted).toBe(false);
    expect(correctionSignal).not.toBe(provisionalSignal);
    expect(mocks.upsert).toHaveBeenCalledTimes(2);
    const finalBody = String(mocks.upsert.mock.calls.at(-1)?.[4]);
    expect(finalBody).toContain("**Failure code:** `VALIDATION_INTEGRITY`");
    expect(finalBody).not.toContain("**Failure code:** `DSH_ABORTED`");
  });

  it("never downgrades an authoritative failure to a later cancellation", async () => {
    const reporter = new StickyProgressReporter({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 41898282,
      operation: "task",
      policy,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
    });

    await reporter.fail(integrityFailure);
    await reporter.fail(abortedFailure);

    expect(mocks.upsert).toHaveBeenCalledOnce();
    const finalBody = String(mocks.upsert.mock.calls[0]?.[4]);
    expect(finalBody).toContain("**Failure code:** `VALIDATION_INTEGRITY`");
    expect(finalBody).not.toContain("**Failure code:** `DSH_ABORTED`");
  });

  it.each(["complete", "blocked"] as const)(
    "does not replace a %s terminal state with a later failure",
    async (terminal) => {
      const reporter = new StickyProgressReporter({
        client: {} as GitHubClient,
        target: { owner: "octo", repo: "repo", issueNumber: 7 },
        expectedAuthorId: 41898282,
        operation: "task",
        policy,
        runUrl: "https://github.com/octo/repo/actions/runs/10",
      });

      if (terminal === "complete") await reporter.complete("Finished");
      else await reporter.blocked("Dependency unavailable");
      await reporter.fail(integrityFailure);

      expect(mocks.upsert).toHaveBeenCalledOnce();
      const finalBody = String(mocks.upsert.mock.calls[0]?.[4]);
      expect(finalBody).not.toContain("**Failure code:**");
      expect(finalBody).toContain(terminal === "complete" ? "✅ Completed" : "⚠️ Blocked");
    },
  );

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
