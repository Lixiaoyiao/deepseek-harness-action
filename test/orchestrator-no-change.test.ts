import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ActionsCoreModule from "@actions/core";
import type * as AgentLoopModule from "../src/agent/loop.js";
import type * as FixModule from "../src/commands/fix.js";
import type * as ImplementModule from "../src/commands/implement.js";
import type * as TaskModule from "../src/commands/task.js";
import type { DshRunResult } from "../src/dsh/runner.js";
import { parseTaskOutputSchema } from "../src/dsh/task-output.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as GitHubFetchModule from "../src/github/fetch.js";
import type { IssueSnapshot } from "../src/github/fetch.js";
import type * as GitHubPayloadModule from "../src/github/payload.js";
import type * as GitHubPermissionsModule from "../src/github/permissions.js";
import type * as RepositoryModule from "../src/github/repository.js";
import type * as InputsModule from "../src/inputs.js";
import type * as ValidationIntegrityModule from "../src/write/validation-integrity.js";
import type * as ValidationModule from "../src/write/validate.js";
import type * as WorkspaceModule from "../src/write/workspace.js";
import type { WorkspaceSnapshot } from "../src/write/workspace.js";
import type * as WriteGitHubModule from "../src/write/github.js";
import type * as WritePrModule from "../src/write/pr.js";
import { deferProgressUntilWriteValidation, runAction } from "../src/orchestrator.js";
import { issueContentFingerprint } from "../src/github/issue-identity.js";
import { inputs } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  setSecret: vi.fn(),
  loadInputs: vi.fn(),
  readEventPayload: vi.fn(),
  createGitHubClient: vi.fn(),
  checkActorPermissions: vi.fn(),
  fetchEntitySnapshot: vi.fn(),
  fetchPullRequestSnapshot: vi.fn(),
  materializeRepositoryAtSha: vi.fn(),
  createWorkspaceSnapshot: vi.fn(),
  inspectWorkspaceChanges: vi.fn(),
  fingerprintWorkspace: vi.fn(),
  inspectValidationIntegrity: vi.fn(),
  enforceValidationIntegrity: vi.fn(),
  runValidationCommandsInDocker: vi.fn(),
  runAgentLoop: vi.fn(),
  publishTaskAnswer: vi.fn(),
  finishAutomationTask: vi.fn(),
  finishImplementation: vi.fn(),
  finishFix: vi.fn(),
  getBranchHead: vi.fn(),
  createGitHubCommitFromWorkspace: vi.fn(),
  createRemoteBranch: vi.fn(),
  updateRemoteBranch: vi.fn(),
  assertRemoteBranchHead: vi.fn(),
  revalidatePullRequestHead: vi.fn(),
  createPullRequest: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof ActionsCoreModule>()),
  setSecret: mocks.setSecret,
}));

vi.mock("../src/inputs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof InputsModule>()),
  loadInputs: mocks.loadInputs,
}));

vi.mock("../src/github/payload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubPayloadModule>()),
  readEventPayload: mocks.readEventPayload,
}));

vi.mock("../src/github/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClientModule>()),
  createGitHubClient: mocks.createGitHubClient,
}));

vi.mock("../src/github/permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubPermissionsModule>()),
  checkActorPermissions: mocks.checkActorPermissions,
}));

vi.mock("../src/github/fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubFetchModule>()),
  fetchEntitySnapshot: mocks.fetchEntitySnapshot,
  fetchPullRequestSnapshot: mocks.fetchPullRequestSnapshot,
}));

vi.mock("../src/github/repository.js", async (importOriginal) => ({
  ...(await importOriginal<typeof RepositoryModule>()),
  materializeRepositoryAtSha: mocks.materializeRepositoryAtSha,
}));

vi.mock("../src/write/workspace.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkspaceModule>()),
  createWorkspaceSnapshot: mocks.createWorkspaceSnapshot,
  inspectWorkspaceChanges: mocks.inspectWorkspaceChanges,
  fingerprintWorkspace: mocks.fingerprintWorkspace,
}));

vi.mock("../src/write/validation-integrity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ValidationIntegrityModule>()),
  inspectValidationIntegrity: mocks.inspectValidationIntegrity,
  enforceValidationIntegrity: mocks.enforceValidationIntegrity,
}));

vi.mock("../src/write/validate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ValidationModule>()),
  runValidationCommandsInDocker: mocks.runValidationCommandsInDocker,
}));

vi.mock("../src/agent/loop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentLoopModule>()),
  runAgentLoop: mocks.runAgentLoop,
}));

vi.mock("../src/commands/task.js", async (importOriginal) => ({
  ...(await importOriginal<typeof TaskModule>()),
  publishTaskAnswer: mocks.publishTaskAnswer,
  finishAutomationTask: mocks.finishAutomationTask,
}));

vi.mock("../src/commands/implement.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ImplementModule>()),
  finishImplementation: mocks.finishImplementation,
}));

vi.mock("../src/commands/fix.js", async (importOriginal) => ({
  ...(await importOriginal<typeof FixModule>()),
  finishFix: mocks.finishFix,
}));

vi.mock("../src/write/github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WriteGitHubModule>()),
  getBranchHead: mocks.getBranchHead,
  createGitHubCommitFromWorkspace: mocks.createGitHubCommitFromWorkspace,
  createRemoteBranch: mocks.createRemoteBranch,
  updateRemoteBranch: mocks.updateRemoteBranch,
  assertRemoteBranchHead: mocks.assertRemoteBranchHead,
}));

vi.mock("../src/write/pr.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WritePrModule>()),
  revalidatePullRequestHead: mocks.revalidatePullRequestHead,
  createPullRequest: mocks.createPullRequest,
}));

const client = {};
const headSha = "a".repeat(40);
const issue: IssueSnapshot = {
  kind: "issue",
  number: 7,
  title: "Check whether a change is needed",
  body: "Inspect the current implementation and answer.",
  author: "alice",
  state: "open",
  updatedAt: "2026-08-22T00:00:00Z",
  contentFingerprint: "f".repeat(64),
  comments: [],
};
const workspaceSnapshot: WorkspaceSnapshot = {
  sourceRoot: "controller-source",
  workerRoot: "agent-workspace",
  baseline: new Map(),
};
const taskOutputSchema = parseTaskOutputSchema(
  JSON.stringify({
    type: "object",
    properties: { status: { type: "string", enum: ["already-complete"] } },
    required: ["status"],
    additionalProperties: false,
  }),
);
const agentResult: DshRunResult = {
  output: {
    protocolVersion: 1,
    operation: "task",
    state: "final",
    summary: "The repository already satisfies the request; no files need changing.",
    findings: [],
    taskOutput: { status: "already-complete" },
  },
  durationMs: 25,
  isolationReport: {
    backend: "docker",
    credentialMediated: true,
    repoToolsEnabled: true,
    processIsolated: true,
    networkIsolated: true,
    workspaceAccess: "read-write",
    extensionProfile: "github-action",
    limitations: [],
  },
};

interface AnswerFinalization {
  readonly kind: "answer";
  readonly noChanges?: boolean;
  readonly commentId?: number;
}

beforeEach(() => {
  vi.stubEnv("GITHUB_EVENT_NAME", "issues");
  vi.stubEnv("GITHUB_ACTOR", "alice");
  vi.stubEnv("GITHUB_RUN_ID", "99");
  vi.stubEnv("GITHUB_REPOSITORY", "octo/repo");
  vi.stubEnv("GITHUB_EVENT_PATH", "event.json");
  vi.stubEnv("GITHUB_WORKSPACE", process.cwd());
  vi.stubEnv("GITHUB_SERVER_URL", "https://github.com");

  mocks.loadInputs.mockReturnValue(
    inputs({
      command: "task",
      prompt: "Check the repository and make changes only if needed",
      taskAccess: "write",
      allowWrite: true,
      isolation: "docker",
      progressComment: true,
      taskOutputSchema,
    }),
  );
  mocks.readEventPayload.mockResolvedValue({
    action: "opened",
    repository: {
      id: 1,
      name: "repo",
      full_name: "octo/repo",
      default_branch: "main",
      owner: { login: "octo" },
    },
    issue: { number: 7 },
    sender: { login: "alice" },
  });
  mocks.createGitHubClient.mockReturnValue(client);
  mocks.checkActorPermissions.mockResolvedValue({
    actors: [
      {
        actor: "alice",
        accountType: "User",
        permission: "write",
        hasWrite: true,
        allowedBot: false,
      },
    ],
    allActorsHaveWrite: true,
    allActorsAllowedForWrite: true,
  });
  mocks.fetchEntitySnapshot.mockResolvedValue(issue);
  mocks.getBranchHead.mockResolvedValue(headSha);
  mocks.materializeRepositoryAtSha.mockResolvedValue(undefined);
  mocks.createWorkspaceSnapshot.mockResolvedValue(workspaceSnapshot);
  mocks.inspectWorkspaceChanges.mockResolvedValue({
    added: [],
    modified: [],
    deleted: [],
    all: [],
  });
  mocks.inspectValidationIntegrity.mockResolvedValue({
    schemaVersion: 1,
    mode: "warn",
    status: "clean",
    changeCount: 0,
    dangerousChangeCount: 0,
    controlPlaneChangeCount: 0,
    testChangeCount: 0,
    changes: [],
    truncated: false,
  });
  mocks.enforceValidationIntegrity.mockImplementation(async (input: { audit: unknown }) =>
    Promise.resolve(input.audit),
  );
  mocks.fingerprintWorkspace.mockResolvedValue("workspace-fingerprint");
  mocks.runValidationCommandsInDocker.mockResolvedValue([
    {
      argv: ["npm", "test"],
      result: {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        outputTruncated: false,
      },
    },
  ]);
  mocks.publishTaskAnswer.mockResolvedValue(4242);
  mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
    const hooks = args[2] as AgentLoopModule.AgentLoopHooks<AnswerFinalization>;
    const stats: AgentLoopModule.AgentLoopStats = {
      turns: 1,
      toolCalls: 0,
      validationRetries: 0,
      toolReceipts: [],
    };
    await hooks.onTurn?.(1, 3);
    await hooks.onState?.(agentResult, stats);
    const finalization = await hooks.finalize(agentResult, 60_000);
    return { agent: agentResult, stats, finalization };
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("orchestrator task no-change publication", () => {
  it("copies the immutable GitHub tree through the explicit materialized-tree source contract", async () => {
    await runAction();

    expect(mocks.getBranchHead).toHaveBeenCalledWith(client, "octo", "repo", "main");
    expect(mocks.materializeRepositoryAtSha).toHaveBeenCalledOnce();
    const materializationCalls = mocks.materializeRepositoryAtSha.mock
      .calls as unknown as readonly (readonly unknown[])[];
    const immutableSource = materializationCalls[0]?.[4];
    expect(immutableSource).toEqual(expect.any(String));
    expect(mocks.createWorkspaceSnapshot).toHaveBeenCalledWith(
      { kind: "materialized-tree", root: immutableSource },
      expect.any(String),
    );
  });

  it("resolves a configured base branch to one immutable Controller-bound head", async () => {
    mocks.loadInputs.mockReturnValue(
      inputs({
        command: "task",
        prompt: "Check the configured release branch",
        taskAccess: "write",
        allowWrite: true,
        isolation: "docker",
        baseBranch: "release/next",
      }),
    );

    await runAction();

    expect(mocks.getBranchHead).toHaveBeenCalledWith(client, "octo", "repo", "release/next");
    expect(mocks.materializeRepositoryAtSha).toHaveBeenCalledWith(
      client,
      "octo",
      "repo",
      headSha,
      expect.any(String),
    );
  });

  it("publishes the final answer for a deferred task --write without mutating the repository", async () => {
    expect(deferProgressUntilWriteValidation({ requestedAccess: "write" })).toBe(true);

    const outcome = await runAction();

    expect(mocks.inspectWorkspaceChanges).toHaveBeenCalledOnce();
    expect(mocks.publishTaskAnswer).toHaveBeenCalledWith(
      client,
      { owner: "octo", repo: "repo", issueNumber: 7 },
      41898282,
      agentResult,
      "https://github.com/octo/repo/actions/runs/99",
    );
    expect(outcome).toMatchObject({
      conclusion: "success",
      operation: "task",
      summary: agentResult.output.summary,
      findingsCount: 0,
      writeStatus: "no-changes",
      changedPaths: [],
      commentId: 4242,
      validation: { status: "not-applicable", commandCount: 0 },
      taskOutput: { status: "already-complete" },
      toolPolicy: {
        schemaVersion: 1,
        policyOwner: "controller",
        requestedTools: ["workspace.edit", "workspace.read", "workspace.search"],
        effectiveTools: ["workspace.edit", "workspace.read", "workspace.search"],
        deniedTools: [],
      },
    });

    expect(mocks.finishAutomationTask).not.toHaveBeenCalled();
    expect(mocks.finishFix).not.toHaveBeenCalled();
    expect(mocks.finishImplementation).not.toHaveBeenCalled();
    expect(mocks.enforceValidationIntegrity).not.toHaveBeenCalled();
    for (const mutation of [
      mocks.createGitHubCommitFromWorkspace,
      mocks.createRemoteBranch,
      mocks.updateRemoteBranch,
      mocks.assertRemoteBranchHead,
      mocks.revalidatePullRequestHead,
      mocks.createPullRequest,
    ]) {
      expect(mutation).not.toHaveBeenCalled();
    }
  });

  it("does not publish a no-change answer after the Controller deadline is exhausted", async () => {
    mocks.runAgentLoop.mockImplementationOnce(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<AnswerFinalization>;
      const stats: AgentLoopModule.AgentLoopStats = {
        turns: 1,
        toolCalls: 0,
        validationRetries: 0,
        toolReceipts: [],
      };
      const finalization = await hooks.finalize(agentResult, 0);
      return { agent: agentResult, stats, finalization };
    });

    const outcome = await runAction();

    expect(outcome).toMatchObject({
      conclusion: "failure",
      error: { code: "AGENT_TIMEOUT", category: "runtime", phase: "validation" },
    });
    expect(mocks.publishTaskAnswer).not.toHaveBeenCalled();
  });

  it("validates before the Agent, defers typed GitHub mutation, then flushes after finalization", async () => {
    const title = "Check whether a change is needed";
    const body = "Inspect the current implementation and answer.";
    const fingerprint = issueContentFingerprint({ number: 7, title, body, authorId: 101 });
    mocks.fetchEntitySnapshot.mockResolvedValueOnce({
      ...issue,
      title,
      body,
      contentFingerprint: fingerprint,
    });
    mocks.loadInputs.mockReturnValueOnce(
      inputs({
        command: "task",
        prompt: "Update issue metadata only",
        taskAccess: "write",
        allowWrite: true,
        isolation: "docker",
        permissionProfile: "custom",
        allowedTools: ["workspace.read", "workspace.edit", "github.issue.labels.set"],
        testCommands: [["npm", "test"]],
      }),
    );
    let labels: readonly string[] = [];
    const getIssue = vi.fn(() =>
      Promise.resolve({
        data: {
          number: 7,
          title,
          body,
          state: "open",
          state_reason: null,
          labels: labels.map((name) => ({ name })),
          assignees: [],
          user: { id: 101, login: "alice" },
          updated_at: "2026-08-22T00:00:00Z",
        },
      }),
    );
    const setLabels = vi.fn((request: { labels: readonly string[] }) => {
      labels = request.labels;
      return Promise.resolve({ data: [] });
    });
    mocks.createGitHubClient.mockReturnValueOnce({
      rest: {
        repos: { get: vi.fn(() => Promise.resolve({ data: { id: 1 } })) },
        issues: { get: getIssue, setLabels },
      },
    });
    mocks.runAgentLoop.mockImplementationOnce(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<AnswerFinalization>;
      expect(mocks.runValidationCommandsInDocker).toHaveBeenCalledOnce();
      expect(setLabels).not.toHaveBeenCalled();
      const scheduled = await hooks.toolProvider?.invoke(
        {
          callId: `call-${"a".repeat(40)}`,
          id: "github.issue.labels.set",
          input: { labels: ["triaged"] },
        },
        { workspacePath: "agent-workspace", timeoutMs: 60_000 },
      );
      expect(scheduled?.output).toMatchObject({ effect: "scheduled", attempts: 0 });
      expect(setLabels).not.toHaveBeenCalled();
      const stats: AgentLoopModule.AgentLoopStats = {
        turns: 2,
        toolCalls: 1,
        validationRetries: 0,
        toolReceipts: [
          {
            callId: `call-${"a".repeat(40)}`,
            id: "github.issue.labels.set",
            ok: true,
            durationMs: 1,
            effect: "scheduled",
            target: "repository:1/issue:7",
            attempts: 0,
            reconciled: false,
          },
        ],
      };
      await hooks.onState?.(agentResult, stats);
      const finalization = await hooks.finalize(agentResult, 60_000);
      return { agent: agentResult, stats, finalization };
    });

    const outcome = await runAction();

    expect(setLabels).toHaveBeenCalledOnce();
    expect(labels).toEqual(["triaged"]);
    expect(mocks.runValidationCommandsInDocker).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      conclusion: "success",
      validation: { status: "passed", commandCount: 1 },
      agent: {
        toolReceipts: [
          {
            id: "github.issue.labels.set",
            ok: true,
            effect: "updated",
            attempts: 1,
            reconciled: true,
          },
        ],
      },
    });
  });

  it("surfaces partial-success and final receipts when a later GitHub mutation fails", async () => {
    const title = "Check whether a change is needed";
    const body = "Inspect the current implementation and answer.";
    const fingerprint = issueContentFingerprint({ number: 7, title, body, authorId: 101 });
    mocks.fetchEntitySnapshot.mockResolvedValueOnce({
      ...issue,
      title,
      body,
      contentFingerprint: fingerprint,
    });
    mocks.loadInputs.mockReturnValueOnce(
      inputs({
        command: "task",
        prompt: "Update issue metadata only",
        taskAccess: "write",
        allowWrite: true,
        isolation: "docker",
        permissionProfile: "custom",
        allowedTools: [
          "workspace.read",
          "workspace.edit",
          "github.issue.labels.set",
          "github.issue.assignees.set",
        ],
        testCommands: [["npm", "test"]],
      }),
    );
    let labels: readonly string[] = [];
    const getIssue = vi.fn(() =>
      Promise.resolve({
        data: {
          number: 7,
          title,
          body,
          state: "open",
          state_reason: null,
          labels: labels.map((name) => ({ name })),
          assignees: [],
          user: { id: 101, login: "alice" },
          updated_at: "2026-08-22T00:00:00Z",
        },
      }),
    );
    const setLabels = vi.fn((request: { labels: readonly string[] }) => {
      labels = request.labels;
      return Promise.resolve({ data: [] });
    });
    // GitHub acknowledges the request, but the authoritative follow-up read
    // does not show the requested postcondition. This must not be retried.
    const updateIssue = vi.fn(() => Promise.resolve({ data: {} }));
    mocks.createGitHubClient.mockReturnValueOnce({
      rest: {
        repos: { get: vi.fn(() => Promise.resolve({ data: { id: 1 } })) },
        issues: { get: getIssue, setLabels, update: updateIssue },
      },
    });
    const firstCallId = `call-${"a".repeat(40)}`;
    const secondCallId = `call-${"b".repeat(40)}`;
    mocks.runAgentLoop.mockImplementationOnce(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<AnswerFinalization>;
      await hooks.toolProvider?.invoke(
        {
          callId: firstCallId,
          id: "github.issue.labels.set",
          input: { labels: ["triaged"] },
        },
        { workspacePath: "agent-workspace", timeoutMs: 60_000 },
      );
      await hooks.toolProvider?.invoke(
        {
          callId: secondCallId,
          id: "github.issue.assignees.set",
          input: { assignees: ["alice"] },
        },
        { workspacePath: "agent-workspace", timeoutMs: 60_000 },
      );
      const stats: AgentLoopModule.AgentLoopStats = {
        turns: 3,
        toolCalls: 2,
        validationRetries: 0,
        toolReceipts: [
          {
            callId: firstCallId,
            id: "github.issue.labels.set",
            ok: true,
            durationMs: 1,
            effect: "scheduled",
            target: "repository:1/issue:7",
            attempts: 0,
            reconciled: false,
          },
          {
            callId: secondCallId,
            id: "github.issue.assignees.set",
            ok: true,
            durationMs: 1,
            effect: "scheduled",
            target: "repository:1/issue:7",
            attempts: 0,
            reconciled: false,
          },
        ],
      };
      await hooks.onState?.(agentResult, stats);
      const finalization = await hooks.finalize(agentResult, 60_000);
      return { agent: agentResult, stats, finalization };
    });

    const outcome = await runAction();

    expect(setLabels).toHaveBeenCalledOnce();
    expect(updateIssue).toHaveBeenCalledOnce();
    expect(outcome).toMatchObject({
      conclusion: "failure",
      writeStatus: "partial-success",
      error: { phase: "write" },
      agent: {
        toolReceipts: [
          { callId: firstCallId, ok: true, effect: "updated", attempts: 1 },
          {
            callId: secondCallId,
            ok: false,
            effect: "scheduled",
            attempts: 1,
            externalEffect: "confirmed",
            error: true,
          },
        ],
      },
    });
    expect(mocks.publishTaskAnswer).not.toHaveBeenCalled();
  });

  it("never starts the Agent or a GitHub mutation when the pre-Agent validation gate fails", async () => {
    mocks.loadInputs.mockReturnValueOnce(
      inputs({
        command: "task",
        prompt: "Update issue metadata only",
        taskAccess: "write",
        allowWrite: true,
        isolation: "docker",
        permissionProfile: "custom",
        allowedTools: ["workspace.read", "workspace.edit", "github.issue.labels.set"],
        testCommands: [["npm", "test"]],
      }),
    );
    const setLabels = vi.fn();
    mocks.createGitHubClient.mockReturnValueOnce({
      rest: { issues: { setLabels } },
    });
    mocks.runValidationCommandsInDocker.mockResolvedValueOnce([
      {
        argv: ["npm", "test"],
        result: {
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          timedOut: false,
          outputTruncated: false,
        },
      },
    ]);

    const outcome = await runAction();

    expect(outcome).toMatchObject({
      conclusion: "failure",
      validation: { status: "failed", commandCount: 1 },
      error: { code: "VALIDATION_FAILED", phase: "validation" },
    });
    expect(mocks.runAgentLoop).not.toHaveBeenCalled();
    expect(setLabels).not.toHaveBeenCalled();
    expect(mocks.publishTaskAnswer).not.toHaveBeenCalled();
  });
});
