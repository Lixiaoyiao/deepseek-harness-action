import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SecurityPolicy } from "../src/security/policy.js";
import type { GitHubClient } from "../src/github/client.js";
import {
  createGitHubToolApi,
  GitHubToolFlushError,
  GitHubToolProvider,
  resolveGitHubTools,
  type GitHubToolApi,
  type GitHubToolBinding,
} from "../src/tools/github.js";
import { ToolRouter } from "../src/tools/router.js";
import {
  githubToolSchema,
  parseAllowedTools,
  parseToolConfiguration,
} from "../src/tools/schema.js";
import { resolveEffectiveTools } from "../src/tools/registry.js";

const HEAD = "a".repeat(40);
const issueBinding: GitHubToolBinding = {
  repositoryId: 42,
  owner: "trusted-owner",
  repo: "trusted-repo",
  target: "issue",
  entityNumber: 7,
  state: "open",
  updatedAt: "2026-08-23T00:00:00Z",
  contentFingerprint: "f".repeat(64),
};
const pullBinding: GitHubToolBinding = {
  ...issueBinding,
  target: "pull_request",
  headSha: HEAD,
  headRef: "feature",
  headRepositoryId: 42,
  baseSha: "b".repeat(40),
  baseRef: "main",
  baseRepositoryId: 42,
};

function policy(
  trust: SecurityPolicy["trust"] = "trusted-write",
  overrides: Partial<SecurityPolicy["capabilities"]> = {},
): SecurityPolicy {
  return {
    trust,
    allowed: trust !== "untrusted",
    reason: "test",
    capabilities: {
      readRepository: trust !== "untrusted",
      readCi: true,
      publishComments: true,
      executeRepositoryCode: trust === "trusted-write",
      loadExtensions: false,
      accessNetwork: false,
      modifyWorkspace: trust === "trusted-write",
      commit: trust === "trusted-write",
      push: trust === "trusted-write",
      createPullRequest: false,
      manageIssueLabels: true,
      manageIssueAssignees: true,
      updateIssueState: true,
      updatePullRequestMetadata: true,
      ...overrides,
    },
  };
}

function fakeApi(overrides: Partial<GitHubToolApi> = {}): GitHubToolApi {
  return {
    revalidateEntity: () => Promise.resolve(),
    getIssue: () =>
      Promise.resolve({ labels: [], assignees: [], state: "open", stateReason: null }),
    setLabels: () => Promise.resolve(),
    setAssignees: () => Promise.resolve(),
    updateIssueState: () => Promise.resolve(),
    listRecentComments: () => Promise.resolve([]),
    createComment: () => Promise.resolve(),
    getPull: () =>
      Promise.resolve({
        title: "title",
        body: "body",
        state: "open",
        base: "main",
        maintainerCanModify: false,
      }),
    updatePull: () => Promise.resolve(),
    readChecks: () =>
      Promise.resolve({
        totalCount: 0,
        statusCount: 0,
        checkRuns: [],
        combinedState: "success",
        statuses: [],
      }),
    ...overrides,
  };
}

function provider(options: {
  readonly ids: readonly (typeof githubToolSchema.options)[number][];
  readonly binding?: GitHubToolBinding;
  readonly securityPolicy?: SecurityPolicy;
  readonly allowWrite?: boolean;
  readonly api?: GitHubToolApi;
  readonly expectedAuthorId?: number;
}): GitHubToolProvider {
  return new GitHubToolProvider({
    ids: options.ids,
    binding: options.binding ?? issueBinding,
    policy: options.securityPolicy ?? policy(),
    allowWrite: options.allowWrite ?? true,
    expectedAuthorId: options.expectedAuthorId ?? 41898282,
    api: options.api ?? fakeApi(),
  });
}

const invocation = { workspacePath: "C:/immutable", timeoutMs: 10_000 } as const;

describe("Controller-owned typed GitHub tools", () => {
  it("accepts only the six exact allowed-tools IDs", () => {
    expect(parseAllowedTools(JSON.stringify(githubToolSchema.options))).toEqual(
      githubToolSchema.options,
    );
    expect(() => parseAllowedTools('["github.request"]')).toThrow(/allowed-tools/u);
    expect(() => parseAllowedTools('["github.issue.labels.set.extra"]')).toThrow(/allowed-tools/u);
  });

  it("intersects exact IDs with trusted target, write, and readCi authority", () => {
    const requested = new Set(githubToolSchema.options);
    const issue = resolveGitHubTools(requested, new Set(), policy(), issueBinding, true);
    expect(issue.ids).toEqual([
      "github.issue.labels.set",
      "github.issue.assignees.set",
      "github.issue.state.update",
      "github.comment.create",
    ]);
    const read = resolveGitHubTools(
      requested,
      new Set(),
      policy("trusted-read", {
        manageIssueLabels: false,
        manageIssueAssignees: false,
        updateIssueState: false,
        updatePullRequestMetadata: false,
      }),
      pullBinding,
      false,
    );
    expect(read.ids).toEqual(["github.checks.read"]);
    const untrusted = resolveGitHubTools(
      requested,
      new Set(),
      policy("untrusted"),
      pullBinding,
      true,
    );
    expect(untrusted.ids).toEqual([]);
    expect(untrusted.denials).toHaveLength(6);
  });

  it("publishes GitHub manifests only through the Controller router", () => {
    const effective = resolveEffectiveTools(
      parseAllowedTools('["github.issue.labels.set","github.checks.read"]'),
      parseToolConfiguration('{"schemaVersion":1,"commands":[]}'),
      policy(),
      { githubBinding: pullBinding, allowWrite: true },
    );
    expect(effective.github).toEqual(["github.issue.labels.set", "github.checks.read"]);
    expect(effective.manifests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "github.issue.labels.set", provider: "github" }),
        expect.objectContaining({ id: "github.checks.read", provider: "github" }),
      ]),
    );
    expect(() => new ToolRouter([provider({ ids: ["github.issue.labels.set"] })])).not.toThrow();
  });

  it("strictly rejects model-supplied repository identity and defers all mutation API calls", async () => {
    const getIssue = vi.fn(() =>
      Promise.resolve({ labels: [], assignees: [], state: "open" as const, stateReason: null }),
    );
    const setLabels = vi.fn(() => Promise.resolve());
    const tools = provider({
      ids: ["github.issue.labels.set"],
      api: fakeApi({ getIssue, setLabels }),
    });
    await expect(
      tools.invoke(
        {
          callId: "call-invalid",
          id: "github.issue.labels.set",
          input: { labels: ["safe"], owner: "attacker", repo: "other", issue_number: 999 },
        },
        invocation,
      ),
    ).rejects.toThrow(/unrecognized key|Invalid input/u);
    const scheduled = await tools.invoke(
      { callId: "call-valid", id: "github.issue.labels.set", input: { labels: ["safe"] } },
      invocation,
    );
    expect(scheduled.output).toMatchObject({
      effect: "scheduled",
      target: "repository:42/issue:7",
      attempts: 0,
      reconciled: false,
    });
    expect(getIssue).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
    expect(tools.hasPendingMutations()).toBe(true);

    const pull = provider({ ids: ["github.pull.metadata.update"], binding: pullBinding });
    await expect(
      pull.invoke(
        {
          callId: "call-retarget",
          id: "github.pull.metadata.update",
          input: { title: "safe", base: "attacker-controlled" },
        },
        invocation,
      ),
    ).rejects.toThrow(/Invalid input/u);
  });

  it("flushes a deferred mutation with a postcondition and bounded receipt", async () => {
    let labels: readonly string[] = [];
    const api = fakeApi({
      getIssue: () => Promise.resolve({ labels, assignees: [], state: "open", stateReason: null }),
      setLabels: (_binding, desired) => {
        labels = desired;
        return Promise.resolve();
      },
    });
    const tools = provider({ ids: ["github.issue.labels.set"], api });
    await tools.invoke(
      { callId: "call-labels", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    const flushed = await tools.flush(invocation);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.result.output).toMatchObject({
      effect: "updated",
      target: "repository:42/issue:7",
      attempts: 1,
      reconciled: true,
      labels: ["bug"],
    });
    expect(tools.hasPendingMutations()).toBe(false);
  });

  it("uses postcondition reconciliation after ambiguous success without repeating a mutation", async () => {
    let labels: readonly string[] = [];
    const setLabels = vi.fn((_binding, desired: readonly string[]) => {
      labels = desired;
      return Promise.reject(Object.assign(new Error("connection reset"), { status: 503 }));
    });
    const tools = provider({
      ids: ["github.issue.labels.set"],
      api: fakeApi({
        getIssue: () =>
          Promise.resolve({ labels, assignees: [], state: "open", stateReason: null }),
        setLabels,
      }),
    });
    await tools.invoke(
      { callId: "call-reconcile", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    const [receipt] = await tools.flush(invocation);
    expect(setLabels).toHaveBeenCalledTimes(1);
    expect(receipt?.result.output).toMatchObject({ attempts: 1, reconciled: true });
  });

  it("performs at most one safe retry when reconciliation confirms no effect", async () => {
    let labels: readonly string[] = [];
    const setLabels = vi.fn((_binding, desired: readonly string[]) => {
      if (setLabels.mock.calls.length === 1) {
        return Promise.reject(Object.assign(new Error("gateway"), { status: 503 }));
      }
      labels = desired;
      return Promise.resolve();
    });
    const tools = provider({
      ids: ["github.issue.labels.set"],
      api: fakeApi({
        getIssue: () =>
          Promise.resolve({ labels, assignees: [], state: "open", stateReason: null }),
        setLabels,
      }),
    });
    await tools.invoke(
      { callId: "call-retry", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    const [receipt] = await tools.flush(invocation);
    expect(setLabels).toHaveBeenCalledTimes(2);
    expect(receipt?.result.output).toMatchObject({ attempts: 2, labels: ["bug"] });
  });

  it("reconciles comment ambiguous success by marker and trusted bot identity", async () => {
    const comments: { id: number; body: string; authorId: number }[] = [];
    const createComment = vi.fn((_binding, body: string) => {
      comments.push({ id: 91, body, authorId: 41898282 });
      return Promise.reject(Object.assign(new Error("lost response"), { status: 503 }));
    });
    const tools = provider({
      ids: ["github.comment.create"],
      api: fakeApi({
        listRecentComments: () => Promise.resolve(comments),
        createComment,
      }),
    });
    await tools.invoke(
      {
        callId: "call-comment",
        id: "github.comment.create",
        input: { body: "Done @alice <!-- ordinary comment -->" },
      },
      invocation,
    );
    const [receipt] = await tools.flush(invocation);
    expect(createComment).toHaveBeenCalledTimes(1);
    expect(comments[0]?.body).toMatch(/dsh-action:github-tool-call=[a-f0-9]{64}/u);
    expect(comments[0]?.body).toContain("@\u200balice");
    expect(comments[0]?.body).not.toContain("ordinary comment");
    expect(receipt?.result.output).toMatchObject({
      effect: "created",
      attempts: 1,
      reconciled: true,
      commentId: 91,
    });
  });

  it("does not duplicate an acknowledged comment when bot identity reconciliation fails", async () => {
    const comments: { id: number; body: string; authorId: number }[] = [];
    const createComment = vi.fn((_binding, body: string) => {
      comments.push({ id: 92, body, authorId: 999 });
      return Promise.resolve();
    });
    const tools = provider({
      ids: ["github.comment.create"],
      api: fakeApi({ listRecentComments: () => Promise.resolve(comments), createComment }),
    });
    await tools.invoke(
      { callId: "call-wrong-bot", id: "github.comment.create", input: { body: "Done" } },
      invocation,
    );
    const failure = await tools.flush(invocation).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubToolFlushError);
    expect((failure as GitHubToolFlushError).receipts[0]).toMatchObject({
      result: {
        callId: "call-wrong-bot",
        ok: false,
        output: {
          effect: "scheduled",
          attempts: 1,
          reconciled: true,
          externalEffect: "confirmed",
        },
      },
    });
    expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(true);
    expect(createComment).toHaveBeenCalledTimes(1);
  });

  it("never blindly retries a comment whose ambiguous result cannot be reconciled", async () => {
    const createComment = vi.fn(() =>
      Promise.reject(Object.assign(new Error("lost response"), { status: 503 })),
    );
    const listRecentComments = vi
      .fn<GitHubToolApi["listRecentComments"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    const tools = provider({
      ids: ["github.comment.create"],
      api: fakeApi({ listRecentComments, createComment }),
    });
    await tools.invoke(
      { callId: "call-comment-unknown", id: "github.comment.create", input: { body: "Done" } },
      invocation,
    );

    const failure = await tools.flush(invocation).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubToolFlushError);
    expect(createComment).toHaveBeenCalledOnce();
    expect((failure as GitHubToolFlushError).receipts[0]?.result.output).toMatchObject({
      attempts: 1,
      reconciled: false,
      externalEffect: "possible",
    });
    expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(true);
  });

  it("bounds the complete marked comment to 32 KiB for ASCII and multibyte bodies", async () => {
    const flushBoundedComment = async (callId: string, body: string): Promise<string> => {
      let published: { id: number; body: string; authorId: number } | undefined;
      const tools = provider({
        ids: ["github.comment.create"],
        api: fakeApi({
          listRecentComments: () => Promise.resolve(published === undefined ? [] : [published]),
          createComment: (_binding, value) => {
            published = { id: 99, body: value, authorId: 41898282 };
            return Promise.resolve();
          },
        }),
      });
      await tools.invoke({ callId, id: "github.comment.create", input: { body } }, invocation);
      await tools.flush(invocation);
      expect(published).toBeDefined();
      return published?.body ?? "";
    };
    const callId = "call-comment-bound";
    const marker = `<!-- dsh-action:github-tool-call=${createHash("sha256").update(callId).digest("hex")} -->`;
    const available = 32 * 1024 - Buffer.byteLength(`\n\n${marker}`, "utf8");

    const ascii = await flushBoundedComment(callId, "x".repeat(available));
    expect(Buffer.byteLength(ascii, "utf8")).toBe(32 * 1024);

    const emoji = "🙂";
    const emojiBytes = Buffer.byteLength(emoji, "utf8");
    const multibyteBody =
      emoji.repeat(Math.floor(available / emojiBytes)) + "x".repeat(available % emojiBytes);
    const multibyte = await flushBoundedComment("call-comment-multibyte", multibyteBody);
    expect(Buffer.byteLength(multibyte, "utf8")).toBe(32 * 1024);

    const oversized = provider({ ids: ["github.comment.create"] });
    await expect(
      oversized.invoke(
        {
          callId: "call-comment-too-large",
          id: "github.comment.create",
          input: { body: "x".repeat(available + 1) },
        },
        invocation,
      ),
    ).rejects.toThrow(/Invalid input/u);
  });

  it("reports an acknowledged mutation with a failed postcondition without retrying", async () => {
    const setLabels = vi.fn(() => Promise.resolve());
    const tools = provider({
      ids: ["github.issue.labels.set"],
      api: fakeApi({
        getIssue: () =>
          Promise.resolve({ labels: [], assignees: [], state: "open", stateReason: null }),
        setLabels,
      }),
    });
    await tools.invoke(
      { callId: "call-postcondition", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );

    const failure = await tools.flush(invocation).catch((error: unknown) => error);

    expect(setLabels).toHaveBeenCalledOnce();
    expect((failure as GitHubToolFlushError).receipts[0]?.result.output).toMatchObject({
      attempts: 1,
      externalEffect: "confirmed",
    });
    expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(true);
  });

  it("retains successful receipts when a later queued mutation fails without an effect", async () => {
    let labels: readonly string[] = [];
    const setLabels = vi.fn((_binding, desired: readonly string[]) => {
      labels = desired;
      return Promise.resolve();
    });
    const setAssignees = vi.fn(() =>
      Promise.reject(Object.assign(new Error("invalid assignee"), { status: 422 })),
    );
    const tools = provider({
      ids: ["github.issue.labels.set", "github.issue.assignees.set"],
      api: fakeApi({
        getIssue: () =>
          Promise.resolve({ labels, assignees: [], state: "open", stateReason: null }),
        setLabels,
        setAssignees,
      }),
    });
    await tools.invoke(
      { callId: "call-first", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    await tools.invoke(
      {
        callId: "call-second",
        id: "github.issue.assignees.set",
        input: { assignees: ["alice"] },
      },
      invocation,
    );

    const failure = await tools.flush(invocation).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GitHubToolFlushError);
    expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(true);
    expect((failure as GitHubToolFlushError).receipts).toHaveLength(2);
    expect((failure as GitHubToolFlushError).receipts[0]?.result.output).toMatchObject({
      effect: "updated",
    });
    expect((failure as GitHubToolFlushError).receipts[1]?.result.output).toMatchObject({
      effect: "scheduled",
    });
    expect((failure as GitHubToolFlushError).receipts[1]?.result.output).not.toHaveProperty(
      "externalEffect",
    );
    expect(setLabels).toHaveBeenCalledOnce();
    expect(setAssignees).toHaveBeenCalledOnce();
  });

  it("rejects every reserved marker and sanitizes PR public text before mutation", async () => {
    const tools = provider({ ids: ["github.comment.create"] });
    await expect(
      tools.invoke(
        {
          callId: "call-marker",
          id: "github.comment.create",
          input: { body: "spoof <!-- DSH-ACTION:v1 kind=task -->" },
        },
        invocation,
      ),
    ).rejects.toThrow(/reserved Controller marker/u);

    let current = {
      title: "old",
      body: "old",
      state: "open" as const,
      base: "main",
      maintainerCanModify: false,
    };
    const updatePull = vi.fn((_binding, input: { title?: string; body?: string }) => {
      current = { ...current, ...input };
      return Promise.resolve();
    });
    const pull = provider({
      ids: ["github.pull.metadata.update"],
      binding: pullBinding,
      api: fakeApi({ getPull: () => Promise.resolve(current), updatePull }),
    });
    await pull.invoke(
      {
        callId: "call-pr-text",
        id: "github.pull.metadata.update",
        input: { title: "Hello @alice", body: "Body @team <!-- remove -->" },
      },
      invocation,
    );
    await pull.flush(invocation);
    expect(updatePull.mock.calls[0]?.[1]).toMatchObject({
      title: "Hello @\u200balice",
      body: "Body @\u200bteam ",
    });
  });

  it("revalidates the full bound entity before a queued mutation and fails with a negative receipt", async () => {
    const revalidateEntity = vi.fn<GitHubToolApi["revalidateEntity"]>(() =>
      Promise.reject(new Error("head changed")),
    );
    const setLabels = vi.fn(() => Promise.resolve());
    const tools = provider({
      ids: ["github.issue.labels.set"],
      api: fakeApi({ revalidateEntity, setLabels }),
    });
    await tools.invoke(
      { callId: "call-stale", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    const failure = await tools.flush(invocation).catch((error: unknown) => error);
    expect(revalidateEntity).toHaveBeenCalledOnce();
    expect(revalidateEntity.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: 42,
      entityNumber: 7,
      contentFingerprint: "f".repeat(64),
    });
    expect(revalidateEntity.mock.calls[0]?.[1]).toBe(false);
    expect(revalidateEntity.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal);
    expect(setLabels).not.toHaveBeenCalled();
    expect((failure as GitHubToolFlushError).receipts[0]?.result).toMatchObject({
      callId: "call-stale",
      ok: false,
    });
    expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(false);
  });

  it("the Octokit adapter rejects PR head, base, or origin drift", async () => {
    const client = {
      rest: {
        pulls: {
          get: vi.fn(() =>
            Promise.resolve({
              data: {
                number: 7,
                state: "open",
                head: { sha: "c".repeat(40), ref: "feature", repo: { id: 42 } },
                base: { sha: "b".repeat(40), ref: "main", repo: { id: 42 } },
              },
            }),
          ),
        },
      },
    } as unknown as GitHubClient;
    await expect(
      createGitHubToolApi(client).revalidateEntity(pullBinding, false, {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/identity or state changed/u);
  });

  it("the Octokit adapter rejects issue repository slug reuse by numeric id", async () => {
    const getRepository = vi.fn(() => Promise.resolve({ data: { id: 99 } }));
    const getIssue = vi.fn(() =>
      Promise.resolve({
        data: {
          number: 7,
          title: "title",
          body: "body",
          state: "open",
          user: { id: 101 },
        },
      }),
    );
    const client = {
      rest: { repos: { get: getRepository }, issues: { get: getIssue } },
    } as unknown as GitHubClient;

    await expect(
      createGitHubToolApi(client).revalidateEntity(issueBinding, false, {
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/identity or state changed/u);
    expect(getRepository).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "trusted-owner", repo: "trusted-repo" }),
    );
    expect(getIssue).toHaveBeenCalledOnce();
  });

  it("advances only the trusted same-PR head after a validated Controller write", async () => {
    const nextHead = "c".repeat(40);
    let labels: readonly string[] = [];
    const revalidateEntity = vi.fn<GitHubToolApi["revalidateEntity"]>(() => Promise.resolve());
    const tools = provider({
      ids: ["github.issue.labels.set"],
      binding: pullBinding,
      api: fakeApi({
        revalidateEntity,
        getIssue: () =>
          Promise.resolve({ labels, assignees: [], state: "open", stateReason: null }),
        setLabels: (_binding, desired) => {
          labels = desired;
          return Promise.resolve();
        },
      }),
    });
    await tools.invoke(
      { callId: "call-after-fix", id: "github.issue.labels.set", input: { labels: ["fixed"] } },
      invocation,
    );
    expect(() => tools.advancePullHead(nextHead, "other-ref")).toThrow(/head ref/u);
    tools.advancePullHead(nextHead, "feature");
    await tools.flush(invocation);
    expect(revalidateEntity.mock.calls.at(-1)?.[0]).toMatchObject({
      headSha: nextHead,
      headRef: "feature",
      baseSha: "b".repeat(40),
      headRepositoryId: 42,
      baseRepositoryId: 42,
    });
  });

  it("allows only explicit state-transition tools to reconcile a closed entity", async () => {
    const closedBinding: GitHubToolBinding = { ...issueBinding, state: "closed" };
    let state: "open" | "closed" = "closed";
    let stateReason: "completed" | "not_planned" | "reopened" | null = null;
    const revalidateEntity = vi.fn<GitHubToolApi["revalidateEntity"]>((_binding, allowClosed) =>
      allowClosed ? Promise.resolve() : Promise.reject(new Error("entity is closed")),
    );
    const stateTools = provider({
      ids: ["github.issue.state.update"],
      binding: closedBinding,
      api: fakeApi({
        revalidateEntity,
        getIssue: () => Promise.resolve({ labels: [], assignees: [], state, stateReason }),
        updateIssueState: (_binding, input) => {
          state = input.state;
          stateReason = input.stateReason ?? null;
          return Promise.resolve();
        },
      }),
    });
    await stateTools.invoke(
      {
        callId: "call-reopen",
        id: "github.issue.state.update",
        input: { state: "open", stateReason: "reopened" },
      },
      invocation,
    );
    const [receipt] = await stateTools.flush(invocation);
    expect(revalidateEntity.mock.calls.every((call) => call[1])).toBe(true);
    expect(receipt?.result.output).toMatchObject({ state: "open", attempts: 1 });

    const setLabels = vi.fn(() => Promise.resolve());
    const labelsTools = provider({
      ids: ["github.issue.labels.set"],
      binding: closedBinding,
      api: fakeApi({ revalidateEntity, setLabels }),
    });
    await labelsTools.invoke(
      { callId: "call-closed-label", id: "github.issue.labels.set", input: { labels: ["x"] } },
      invocation,
    );
    await expect(labelsTools.flush(invocation)).rejects.toBeInstanceOf(GitHubToolFlushError);
    expect(setLabels).not.toHaveBeenCalled();
  });

  it("binds checks to the immutable trusted head and bounds returned data", async () => {
    const readChecks = vi.fn<GitHubToolApi["readChecks"]>(() =>
      Promise.resolve({
        totalCount: 50,
        statusCount: 75,
        checkRuns: Array.from({ length: 50 }, (_, index) => ({
          name: `${String(index)}-${"x".repeat(400)}`,
          status: "completed",
          conclusion: "success",
        })),
        combinedState: "success",
        statuses: Array.from({ length: 50 }, (_, index) => ({
          context: `status-${String(index)}`,
          state: "success",
          description: "ok",
        })),
      }),
    );
    const tools = provider({
      ids: ["github.checks.read"],
      binding: pullBinding,
      securityPolicy: policy("trusted-read"),
      allowWrite: false,
      api: fakeApi({ readChecks }),
    });
    const result = await tools.invoke(
      { callId: "call-checks", id: "github.checks.read", input: {} },
      invocation,
    );
    expect(readChecks.mock.calls[0]?.[0]).toMatchObject({
      repositoryId: 42,
      owner: "trusted-owner",
      repo: "trusted-repo",
      headSha: HEAD,
    });
    expect(result.output).toMatchObject({
      effect: "read",
      headSha: HEAD,
      truncated: true,
    });
    await expect(
      tools.invoke(
        { callId: "call-checks-evil", id: "github.checks.read", input: { ref: "attacker" } },
        invocation,
      ),
    ).rejects.toThrow(/Invalid input/u);
  });

  it("hard-bounds a GitHub API call even when a client ignores its abort signal", async () => {
    const tools = provider({
      ids: ["github.checks.read"],
      binding: pullBinding,
      securityPolicy: policy("trusted-read"),
      allowWrite: false,
      api: fakeApi({ readChecks: () => new Promise(() => undefined) }),
    });
    await expect(
      tools.invoke(
        { callId: "call-timeout", id: "github.checks.read", input: {} },
        { workspacePath: "C:/immutable", timeoutMs: 20 },
      ),
    ).rejects.toThrow(/timed out|aborted/u);
  });

  it("fails closed for incompatible entity types and exhausted per-tool calls", async () => {
    const pullState = provider({ ids: ["github.issue.state.update"], binding: pullBinding });
    await expect(
      pullState.invoke(
        { callId: "call-state", id: "github.issue.state.update", input: { state: "closed" } },
        invocation,
      ),
    ).rejects.toThrow(/capability denied/u);

    const state = provider({ ids: ["github.issue.state.update"] });
    await state.invoke(
      { callId: "call-1", id: "github.issue.state.update", input: { state: "closed" } },
      invocation,
    );
    await state.invoke(
      { callId: "call-2", id: "github.issue.state.update", input: { state: "closed" } },
      invocation,
    );
    await expect(
      state.invoke(
        { callId: "call-3", id: "github.issue.state.update", input: { state: "closed" } },
        invocation,
      ),
    ).rejects.toThrow(/maxCalls/u);
  });

  it("discards queued mutations on provider disposal", async () => {
    const setLabels = vi.fn(() => Promise.resolve());
    const tools = provider({
      ids: ["github.issue.labels.set"],
      api: fakeApi({ setLabels }),
    });
    await tools.invoke(
      { callId: "call-discard", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    await tools.dispose();
    expect(tools.hasPendingMutations()).toBe(false);
    expect(setLabels).not.toHaveBeenCalled();
  });
});
