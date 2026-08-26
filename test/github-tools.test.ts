import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { SecurityPolicy } from "../src/security/policy.js";
import type { GitHubClient } from "../src/github/client.js";
import { issueContentFingerprint } from "../src/github/issue-identity.js";
import { createOctokitGitHubToolBackend } from "../src/github/octokit-tool-backend.js";
import {
  GitHubAuthorityGateway,
  GitHubToolFlushError,
  GitHubToolProvider,
  githubFlushHasExternalEffect,
  githubToolManifest,
  mergeGitHubFlushReceipts,
  resolveGitHubTools,
  type GitHubMutationValidationGate,
  type GitHubToolBinding,
} from "../src/tools/github.js";
import type {
  GitHubIssueSnapshot,
  GitHubPullSnapshot,
  GitHubToolBackend,
} from "../src/tools/github-backend.js";
import { ToolRouter } from "../src/tools/router.js";
import {
  githubToolSchema,
  parseAllowedTools,
  parseToolConfiguration,
} from "../src/tools/schema.js";
import { resolveEffectiveTools } from "../src/tools/registry.js";

const HEAD = "a".repeat(40);
const ISSUE_TITLE = "bound issue title";
const ISSUE_BODY = "bound issue body";
const ISSUE_AUTHOR_ID = 101;
const ISSUE_FINGERPRINT = issueContentFingerprint({
  number: 7,
  title: ISSUE_TITLE,
  body: ISSUE_BODY,
  authorId: ISSUE_AUTHOR_ID,
});
const issueBinding: GitHubToolBinding = {
  repositoryId: 42,
  owner: "trusted-owner",
  repo: "trusted-repo",
  target: "issue",
  entityNumber: 7,
  state: "open",
  updatedAt: "2026-08-23T00:00:00Z",
  contentFingerprint: ISSUE_FINGERPRINT,
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

function issueSnapshot(overrides: Partial<GitHubIssueSnapshot> = {}): GitHubIssueSnapshot {
  return {
    kind: "issue",
    number: 7,
    title: ISSUE_TITLE,
    body: ISSUE_BODY,
    authorId: ISSUE_AUTHOR_ID,
    labels: [],
    assignees: [],
    state: "open",
    stateReason: null,
    ...overrides,
  };
}

function pullSnapshot(overrides: Partial<GitHubPullSnapshot> = {}): GitHubPullSnapshot {
  return {
    number: 7,
    title: "title",
    body: "body",
    state: "open",
    maintainerCanModify: false,
    headSha: HEAD,
    headRef: "feature",
    headRepositoryId: 42,
    baseSha: "b".repeat(40),
    baseRef: "main",
    baseRepositoryId: 42,
    ...overrides,
  };
}

const issueIdentityDrifts: readonly (readonly [string, Partial<GitHubIssueSnapshot>])[] = [
  ["entity number", { number: 8 }],
  ["entity kind", { kind: "pull_request" }],
  ["content fingerprint", { title: "changed title" }],
];

const pullIdentityDrifts: readonly (readonly [string, Partial<GitHubPullSnapshot>])[] = [
  ["entity number", { number: 8 }],
  ["head SHA", { headSha: "c".repeat(40) }],
  ["head ref", { headRef: "other-feature" }],
  ["head repository", { headRepositoryId: 43 }],
  ["missing head repository", { headRepositoryId: null }],
  ["base SHA", { baseSha: "d".repeat(40) }],
  ["base ref", { baseRef: "release" }],
  ["base repository", { baseRepositoryId: 43 }],
];

function fakeBackend(overrides: Partial<GitHubToolBackend> = {}): GitHubToolBackend {
  return {
    getRepository: () => Promise.resolve({ id: 42 }),
    getIssue: () => Promise.resolve(issueSnapshot()),
    setLabels: () => Promise.resolve(),
    setAssignees: () => Promise.resolve(),
    updateIssueState: () => Promise.resolve(),
    listRecentComments: () => Promise.resolve([]),
    createComment: () => Promise.resolve(),
    getPull: () => Promise.resolve(pullSnapshot()),
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
  readonly backend?: GitHubToolBackend;
  readonly expectedAuthorId?: number;
  readonly validationGate?: GitHubMutationValidationGate;
}): GitHubToolProvider {
  return new GitHubToolProvider({
    ids: options.ids,
    binding: options.binding ?? issueBinding,
    policy: options.securityPolicy ?? policy(),
    allowWrite: options.allowWrite ?? true,
    expectedAuthorId: options.expectedAuthorId ?? 41898282,
    backend: options.backend ?? fakeBackend(),
    validationGate: options.validationGate ?? (() => Promise.resolve()),
  });
}

const invocation = { workspacePath: "C:/immutable", timeoutMs: 10_000 } as const;

describe("Controller-owned typed GitHub tools", () => {
  it("keeps the legacy provider import as an alias of GitHubAuthorityGateway", () => {
    expect(GitHubToolProvider).toBe(GitHubAuthorityGateway);
    expect(provider({ ids: [] })).toBeInstanceOf(GitHubAuthorityGateway);
  });

  it("requires a Controller validation gate whenever mutation authority is enabled", () => {
    expect(
      () =>
        new GitHubAuthorityGateway({
          ids: ["github.issue.labels.set"],
          binding: issueBinding,
          policy: policy(),
          allowWrite: true,
          expectedAuthorId: 41898282,
          backend: fakeBackend(),
        }),
    ).toThrow(/requires a Controller validation gate/u);
  });

  it("projects final Gateway effects into the original Controller receipt", () => {
    const flushes = [
      {
        result: {
          callId: "call-receipt",
          id: "github.issue.labels.set",
          ok: true,
          output: {
            effect: "updated",
            target: "repository:42/issue:7",
            attempts: 1,
            reconciled: true,
          },
        },
        durationMs: 7,
      },
    ] as const;

    expect(
      mergeGitHubFlushReceipts(
        [
          {
            callId: "call-receipt",
            id: "github.issue.labels.set",
            ok: true,
            durationMs: 3,
            effect: "scheduled",
          },
        ],
        flushes,
      ),
    ).toEqual([
      {
        callId: "call-receipt",
        id: "github.issue.labels.set",
        ok: true,
        durationMs: 10,
        effect: "updated",
        target: "repository:42/issue:7",
        attempts: 1,
        reconciled: true,
      },
    ]);
    expect(githubFlushHasExternalEffect(flushes)).toBe(true);
  });

  it("accepts only the six exact allowed-tools IDs", () => {
    expect(parseAllowedTools(JSON.stringify(githubToolSchema.options))).toEqual(
      githubToolSchema.options,
    );
    expect(() => parseAllowedTools('["github.request"]')).toThrow(/allowed-tools/u);
    expect(() => parseAllowedTools('["github.issue.labels.set.extra"]')).toThrow(/allowed-tools/u);
  });

  it("keeps all six public GitHub capability manifests exact", () => {
    expect(githubToolSchema.options.map((id) => githubToolManifest(id))).toEqual([
      {
        id: "github.issue.labels.set",
        description: "Replace labels on the current issue or pull request.",
        provider: "github",
        permissions: ["github-write"],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["labels"],
          properties: {
            labels: {
              type: "array",
              maxItems: 20,
              uniqueItems: true,
              items: { type: "string" },
            },
          },
        },
      },
      {
        id: "github.issue.assignees.set",
        description: "Replace assignees on the current issue or pull request.",
        provider: "github",
        permissions: ["github-write"],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["assignees"],
          properties: {
            assignees: {
              type: "array",
              maxItems: 10,
              uniqueItems: true,
              items: { type: "string" },
            },
          },
        },
      },
      {
        id: "github.issue.state.update",
        description: "Update the state of the current issue.",
        provider: "github",
        permissions: ["github-write"],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["state"],
          properties: {
            state: { type: "string", enum: ["open", "closed"] },
            stateReason: {
              type: "string",
              enum: ["completed", "not_planned", "reopened"],
            },
          },
        },
      },
      {
        id: "github.comment.create",
        description: "Create one idempotent comment on the current issue or pull request.",
        provider: "github",
        permissions: ["github-write"],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["body"],
          properties: { body: { type: "string", minLength: 1, maxLength: 32_665 } },
        },
      },
      {
        id: "github.pull.metadata.update",
        description: "Update bounded metadata on the current pull request.",
        provider: "github",
        permissions: ["github-write"],
        inputSchema: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 256 },
            body: { type: "string", maxLength: 65_536 },
            state: { type: "string", enum: ["open", "closed"] },
            maintainerCanModify: { type: "boolean" },
          },
        },
      },
      {
        id: "github.checks.read",
        description: "Read bounded checks and commit statuses for the immutable bound head SHA.",
        provider: "github",
        permissions: ["github-read"],
        inputSchema: { type: "object", additionalProperties: false },
      },
    ]);
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

  it("classifies GitHub denial boundaries with deterministic precedence", () => {
    const requested = new Set(["github.comment.create"] as const);
    const optOut = resolveGitHubTools(requested, new Set(), policy(), issueBinding, false);
    expect(optOut.denials).toEqual([
      {
        id: "github.comment.create",
        reasonCode: "CAPABILITY_NOT_GRANTED",
        reason: "GitHub mutation tools require trusted-write policy and allow-write=true",
      },
    ]);

    const trustWins = resolveGitHubTools(
      requested,
      new Set(),
      policy("untrusted", { publishComments: false }),
      undefined,
      false,
    );
    expect(trustWins.denials[0]?.reasonCode).toBe("TRUST_REQUIRED");

    const wrongEntity = resolveGitHubTools(
      new Set(["github.pull.metadata.update"]),
      new Set(),
      policy(),
      issueBinding,
      true,
    );
    expect(wrongEntity.denials[0]?.reasonCode).toBe("BINDING_UNAVAILABLE");
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
    const getRepository = vi.fn(() => Promise.resolve({ id: 42 }));
    const getIssue = vi.fn(() => Promise.resolve(issueSnapshot()));
    const setLabels = vi.fn(() => Promise.resolve());
    const tools = provider({
      ids: ["github.issue.labels.set"],
      backend: fakeBackend({ getRepository, getIssue, setLabels }),
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
    expect(getRepository).not.toHaveBeenCalled();
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

  it("runs the typed validation gate before any backend effect and keeps the queue on denial", async () => {
    const validationFailure = new Error("workspace validation denied GitHub mutation");
    const validationGate = vi.fn<GitHubMutationValidationGate>(() =>
      Promise.reject(validationFailure),
    );
    const getRepository = vi.fn<GitHubToolBackend["getRepository"]>(() =>
      Promise.resolve({ id: 42 }),
    );
    const getIssue = vi.fn<GitHubToolBackend["getIssue"]>(() => Promise.resolve(issueSnapshot()));
    const setLabels = vi.fn<GitHubToolBackend["setLabels"]>(() => Promise.resolve());
    const gateway = provider({
      ids: ["github.issue.labels.set"],
      validationGate,
      backend: fakeBackend({ getRepository, getIssue, setLabels }),
    });
    await gateway.invoke(
      {
        callId: "call-validation-denied",
        id: "github.issue.labels.set",
        input: { labels: ["safe"] },
      },
      invocation,
    );

    await expect(gateway.flush(invocation)).rejects.toBe(validationFailure);

    expect(validationGate).toHaveBeenCalledOnce();
    const validationRequest = validationGate.mock.calls[0]?.[0];
    expect(validationRequest).toMatchObject({
      workspacePath: invocation.workspacePath,
      mutations: [{ callId: "call-validation-denied", id: "github.issue.labels.set" }],
    });
    expect(validationRequest?.timeoutMs).toBeGreaterThan(0);
    expect(getRepository).not.toHaveBeenCalled();
    expect(getIssue).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
    expect(gateway.hasPendingMutations()).toBe(true);
  });

  it("flushes a deferred mutation with a postcondition and bounded receipt", async () => {
    let labels: readonly string[] = [];
    const getRepository = vi.fn<GitHubToolBackend["getRepository"]>(() =>
      Promise.resolve({ id: 42 }),
    );
    const getIssue = vi.fn<GitHubToolBackend["getIssue"]>(() =>
      Promise.resolve(issueSnapshot({ labels })),
    );
    const setLabels = vi.fn<GitHubToolBackend["setLabels"]>((_target, desired) => {
      labels = desired;
      return Promise.resolve();
    });
    const backend = fakeBackend({
      getRepository,
      getIssue,
      setLabels,
    });
    const tools = provider({ ids: ["github.issue.labels.set"], backend });
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
    expect(getRepository.mock.calls[0]?.[0]).toMatchObject({
      owner: "trusted-owner",
      repo: "trusted-repo",
    });
    expect(getIssue.mock.calls.every(([target]) => target.owner === "trusted-owner")).toBe(true);
    expect(getIssue.mock.calls.every(([target]) => target.repo === "trusted-repo")).toBe(true);
    expect(getIssue.mock.calls.every(([target]) => target.issueNumber === 7)).toBe(true);
    expect(setLabels.mock.calls[0]?.[0]).toEqual({
      owner: "trusted-owner",
      repo: "trusted-repo",
      issueNumber: 7,
    });
    expect(setLabels.mock.calls[0]?.[1]).toEqual(["bug"]);
    expect(setLabels.mock.calls[0]?.[2].signal).toBeInstanceOf(AbortSignal);
    expect(setLabels.mock.calls[0]?.[0]).not.toHaveProperty("repositoryId");
    expect(setLabels.mock.calls[0]?.[0]).not.toHaveProperty("contentFingerprint");
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
      backend: fakeBackend({
        getIssue: () => Promise.resolve(issueSnapshot({ labels })),
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
    const getRepository = vi.fn<GitHubToolBackend["getRepository"]>(() =>
      Promise.resolve({ id: 42 }),
    );
    const setLabels = vi.fn<GitHubToolBackend["setLabels"]>((_target, desired) => {
      if (setLabels.mock.calls.length === 1) {
        return Promise.reject(Object.assign(new Error("gateway"), { status: 503 }));
      }
      labels = desired;
      return Promise.resolve();
    });
    const tools = provider({
      ids: ["github.issue.labels.set"],
      backend: fakeBackend({
        getRepository,
        getIssue: () => Promise.resolve(issueSnapshot({ labels })),
        setLabels,
      }),
    });
    await tools.invoke(
      { callId: "call-retry", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );
    const [receipt] = await tools.flush(invocation);
    expect(setLabels).toHaveBeenCalledTimes(2);
    expect(getRepository).toHaveBeenCalledTimes(3);
    expect(getRepository.mock.invocationCallOrder[1]).toBeLessThan(
      setLabels.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(getRepository.mock.invocationCallOrder[2]).toBeLessThan(
      setLabels.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
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
      backend: fakeBackend({
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
      backend: fakeBackend({ listRecentComments: () => Promise.resolve(comments), createComment }),
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
      .fn<GitHubToolBackend["listRecentComments"]>()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("reconciliation unavailable"));
    const tools = provider({
      ids: ["github.comment.create"],
      backend: fakeBackend({ listRecentComments, createComment }),
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
        backend: fakeBackend({
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
      backend: fakeBackend({
        getIssue: () => Promise.resolve(issueSnapshot()),
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
      backend: fakeBackend({
        getIssue: () => Promise.resolve(issueSnapshot({ labels })),
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

    let current = pullSnapshot({ title: "old", body: "old" });
    const updatePull = vi.fn<GitHubToolBackend["updatePull"]>((_target, input) => {
      current = pullSnapshot({ ...current, ...input });
      return Promise.resolve();
    });
    const pull = provider({
      ids: ["github.pull.metadata.update"],
      binding: pullBinding,
      backend: fakeBackend({ getPull: () => Promise.resolve(current), updatePull }),
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

  it.each(issueIdentityDrifts)(
    "keeps issue %s trust decisions in the Gateway",
    async (_name, drift) => {
      const setLabels = vi.fn<GitHubToolBackend["setLabels"]>(() => Promise.resolve());
      const tools = provider({
        ids: ["github.issue.labels.set"],
        backend: fakeBackend({
          getIssue: () => Promise.resolve(issueSnapshot(drift)),
          setLabels,
        }),
      });
      await tools.invoke(
        {
          callId: `call-issue-drift-${_name}`,
          id: "github.issue.labels.set",
          input: { labels: ["bug"] },
        },
        invocation,
      );

      const failure = await tools.flush(invocation).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubToolFlushError);
      expect(setLabels).not.toHaveBeenCalled();
      expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(false);
    },
  );

  it("revalidates again immediately before an actual mutation attempt", async () => {
    const events: string[] = [];
    const getRepository = vi
      .fn<GitHubToolBackend["getRepository"]>()
      .mockImplementationOnce(() => {
        events.push("repository:flush");
        return Promise.resolve({ id: 42 });
      })
      .mockImplementationOnce(() => {
        events.push("repository:attempt");
        return Promise.resolve({ id: 99 });
      });
    const getIssue = vi.fn<GitHubToolBackend["getIssue"]>(() => {
      events.push(`issue:${String(getIssue.mock.calls.length)}`);
      return Promise.resolve(issueSnapshot());
    });
    const setLabels = vi.fn<GitHubToolBackend["setLabels"]>(() => {
      events.push("write");
      return Promise.resolve();
    });
    const tools = provider({
      ids: ["github.issue.labels.set"],
      backend: fakeBackend({ getRepository, getIssue, setLabels }),
    });
    await tools.invoke(
      { callId: "call-attempt-drift", id: "github.issue.labels.set", input: { labels: ["bug"] } },
      invocation,
    );

    const failure = await tools.flush(invocation).catch((error: unknown) => error);

    expect(events).toEqual([
      "repository:flush",
      "issue:1",
      "issue:2",
      "repository:attempt",
      "issue:3",
    ]);
    expect(setLabels).not.toHaveBeenCalled();
    expect((failure as GitHubToolFlushError).receipts[0]?.result).toMatchObject({
      callId: "call-attempt-drift",
      ok: false,
      output: { effect: "scheduled", attempts: 1, reconciled: false },
    });
    expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(false);
  });

  it("the Octokit backend returns drifted PR state without making the trust decision", async () => {
    const getPull = vi.fn(() =>
      Promise.resolve({
        data: {
          number: 7,
          title: "title",
          body: "body",
          state: "open",
          maintainer_can_modify: false,
          head: { sha: "c".repeat(40), ref: "feature", repo: { id: 42 } },
          base: { sha: "b".repeat(40), ref: "main", repo: { id: 42 } },
        },
      }),
    );
    const client = { rest: { pulls: { get: getPull } } } as unknown as GitHubClient;
    const control = { timeoutMs: 1_000, signal: new AbortController().signal };

    await expect(
      createOctokitGitHubToolBackend(client).getPull(
        { owner: "trusted-owner", repo: "trusted-repo", pullNumber: 7 },
        control,
      ),
    ).resolves.toEqual(pullSnapshot({ headSha: "c".repeat(40) }));
    expect(getPull).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "trusted-owner",
        repo: "trusted-repo",
        pull_number: 7,
        request: { timeout: 1_000, signal: control.signal },
      }),
    );
  });

  it.each(pullIdentityDrifts)(
    "keeps PR %s trust decisions in the Gateway",
    async (_name, drift) => {
      const updatePull = vi.fn<GitHubToolBackend["updatePull"]>(() => Promise.resolve());
      const tools = provider({
        ids: ["github.pull.metadata.update"],
        binding: pullBinding,
        backend: fakeBackend({
          getPull: () => Promise.resolve(pullSnapshot(drift)),
          updatePull,
        }),
      });
      await tools.invoke(
        {
          callId: `call-pull-drift-${_name}`,
          id: "github.pull.metadata.update",
          input: { title: "new title" },
        },
        invocation,
      );

      const failure = await tools.flush(invocation).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(GitHubToolFlushError);
      expect(updatePull).not.toHaveBeenCalled();
      expect((failure as GitHubToolFlushError).hasExternalEffect).toBe(false);
    },
  );

  it("the Octokit backend returns repository and issue state without deciding slug reuse", async () => {
    const getRepository = vi.fn(() => Promise.resolve({ data: { id: 99 } }));
    const getIssue = vi.fn(() =>
      Promise.resolve({
        data: {
          number: 7,
          title: ISSUE_TITLE,
          body: ISSUE_BODY,
          state: "open",
          state_reason: null,
          user: { id: ISSUE_AUTHOR_ID },
          labels: [],
          assignees: [],
        },
      }),
    );
    const client = {
      rest: { repos: { get: getRepository }, issues: { get: getIssue } },
    } as unknown as GitHubClient;
    const backend = createOctokitGitHubToolBackend(client);
    const control = { timeoutMs: 1_000, signal: new AbortController().signal };

    await expect(
      backend.getRepository({ owner: "trusted-owner", repo: "trusted-repo" }, control),
    ).resolves.toEqual({ id: 99 });
    await expect(
      backend.getIssue({ owner: "trusted-owner", repo: "trusted-repo", issueNumber: 7 }, control),
    ).resolves.toEqual(issueSnapshot());
    expect(getRepository).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "trusted-owner", repo: "trusted-repo" }),
    );
    expect(getIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "trusted-owner",
        repo: "trusted-repo",
        issue_number: 7,
      }),
    );
  });

  it("advances only the trusted same-PR head after a validated Controller write", async () => {
    const nextHead = "c".repeat(40);
    let labels: readonly string[] = [];
    const getPull = vi.fn<GitHubToolBackend["getPull"]>(() =>
      Promise.resolve(pullSnapshot({ headSha: nextHead })),
    );
    const setLabels = vi.fn<GitHubToolBackend["setLabels"]>((_target, desired) => {
      labels = desired;
      return Promise.resolve();
    });
    const tools = provider({
      ids: ["github.issue.labels.set"],
      binding: pullBinding,
      backend: fakeBackend({
        getPull,
        getIssue: () => Promise.resolve(issueSnapshot({ labels })),
        setLabels,
      }),
    });
    await tools.invoke(
      { callId: "call-after-fix", id: "github.issue.labels.set", input: { labels: ["fixed"] } },
      invocation,
    );
    expect(() => tools.advancePullHead(nextHead, "other-ref")).toThrow(/head ref/u);
    tools.advancePullHead(nextHead, "feature");
    await tools.flush(invocation);
    expect(getPull).toHaveBeenCalledTimes(2);
    expect(setLabels).toHaveBeenCalledOnce();
  });

  it("allows only explicit state-transition tools to reconcile a closed entity", async () => {
    const closedBinding: GitHubToolBinding = { ...issueBinding, state: "closed" };
    let state: "open" | "closed" = "closed";
    let stateReason: "completed" | "not_planned" | "reopened" | null = null;
    const stateTools = provider({
      ids: ["github.issue.state.update"],
      binding: closedBinding,
      backend: fakeBackend({
        getIssue: () => Promise.resolve(issueSnapshot({ state, stateReason })),
        updateIssueState: (_target, input) => {
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
    expect(receipt?.result.output).toMatchObject({ state: "open", attempts: 1 });

    const setLabels = vi.fn<GitHubToolBackend["setLabels"]>(() => Promise.resolve());
    const labelsTools = provider({
      ids: ["github.issue.labels.set"],
      binding: closedBinding,
      backend: fakeBackend({
        getIssue: () => Promise.resolve(issueSnapshot({ state: "closed" })),
        setLabels,
      }),
    });
    await labelsTools.invoke(
      { callId: "call-closed-label", id: "github.issue.labels.set", input: { labels: ["x"] } },
      invocation,
    );
    await expect(labelsTools.flush(invocation)).rejects.toBeInstanceOf(GitHubToolFlushError);
    expect(setLabels).not.toHaveBeenCalled();
  });

  it("allows a closed PR only when metadata explicitly requests a state transition", async () => {
    let current = pullSnapshot({ state: "closed" });
    const updatePull = vi.fn<GitHubToolBackend["updatePull"]>((_target, input) => {
      current = pullSnapshot({ ...current, ...input });
      return Promise.resolve();
    });
    const backend = fakeBackend({ getPull: () => Promise.resolve(current), updatePull });
    const blocked = provider({
      ids: ["github.pull.metadata.update"],
      binding: pullBinding,
      backend,
    });
    await blocked.invoke(
      {
        callId: "call-closed-pull-title",
        id: "github.pull.metadata.update",
        input: { title: "new title" },
      },
      invocation,
    );

    await expect(blocked.flush(invocation)).rejects.toBeInstanceOf(GitHubToolFlushError);
    expect(updatePull).not.toHaveBeenCalled();

    const transition = provider({
      ids: ["github.pull.metadata.update"],
      binding: pullBinding,
      backend,
    });
    await transition.invoke(
      {
        callId: "call-reopen-pull",
        id: "github.pull.metadata.update",
        input: { state: "open" },
      },
      invocation,
    );
    const [receipt] = await transition.flush(invocation);

    expect(updatePull).toHaveBeenCalledOnce();
    expect(receipt?.result.output).toMatchObject({ state: "open", attempts: 1 });
  });

  it("binds checks to the immutable trusted head and bounds returned data", async () => {
    const readChecks = vi.fn<GitHubToolBackend["readChecks"]>(() =>
      Promise.resolve({
        totalCount: 50,
        statusCount: 75,
        checkRuns: Array.from({ length: 50 }, (_, index) => ({
          name: index === 0 ? `${"x".repeat(255)}😀tail` : `${String(index)}-${"x".repeat(400)}`,
          status: index === 0 ? "😀".repeat(20) : "completed",
          conclusion: "success",
        })),
        combinedState: "😀".repeat(20),
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
      backend: fakeBackend({ readChecks }),
    });
    const result = await tools.invoke(
      { callId: "call-checks", id: "github.checks.read", input: {} },
      invocation,
    );
    expect(readChecks.mock.calls[0]?.[0]).toEqual({
      owner: "trusted-owner",
      repo: "trusted-repo",
      headSha: HEAD,
    });
    expect(result.output).toMatchObject({
      effect: "read",
      headSha: HEAD,
      truncated: true,
    });
    const output = result.output as {
      readonly combinedState: string;
      readonly checkRuns: readonly { readonly name: string; readonly status: string }[];
    };
    expect(output.combinedState).toBe("😀".repeat(8));
    expect(output.checkRuns[0]).toEqual({
      name: "x".repeat(255),
      status: "😀".repeat(8),
      conclusion: "success",
    });
    expect(JSON.stringify(output)).not.toContain("�");
    await expect(
      tools.invoke(
        { callId: "call-checks-evil", id: "github.checks.read", input: { ref: "attacker" } },
        invocation,
      ),
    ).rejects.toThrow(/Invalid input/u);
    expect(readChecks).toHaveBeenCalledOnce();
  });

  it("hard-bounds a GitHub API call even when a client ignores its abort signal", async () => {
    const tools = provider({
      ids: ["github.checks.read"],
      binding: pullBinding,
      securityPolicy: policy("trusted-read"),
      allowWrite: false,
      backend: fakeBackend({ readChecks: () => new Promise(() => undefined) }),
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
      backend: fakeBackend({ setLabels }),
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
