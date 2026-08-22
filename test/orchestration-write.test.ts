import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RoutedCommand } from "../src/commands/router.js";
import type { DshRunResult } from "../src/dsh/runner.js";
import type { GitHubClient } from "../src/github/client.js";
import type { GitHubContext } from "../src/github/context.js";
import type { IssueSnapshot, PullRequestSnapshot } from "../src/github/fetch.js";
import type { ActionInputs } from "../src/inputs.js";
import { issueTaskIdentity } from "../src/orchestration/context.js";
import type { SecurityPolicy } from "../src/security/policy.js";
import type { WorkspaceSnapshot } from "../src/write/workspace.js";
import { inputs, pullRequestContext } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  finishAutomationTask: vi.fn(),
  finishFix: vi.fn(),
  finishImplementation: vi.fn(),
}));

vi.mock("../src/commands/implement.js", () => ({
  finishImplementation: mocks.finishImplementation,
}));
vi.mock("../src/commands/task.js", () => ({
  finishAutomationTask: mocks.finishAutomationTask,
}));
vi.mock("../src/commands/fix.js", () => ({ finishFix: mocks.finishFix }));

import { executeWrite } from "../src/orchestration/write.js";

const client = {} as GitHubClient;
const workspace: WorkspaceSnapshot = {
  sourceRoot: "source",
  workerRoot: "worker",
  baseline: new Map(),
};
const policy: SecurityPolicy = {
  trust: "trusted-write",
  allowed: true,
  reason: "test",
  capabilities: {
    readRepository: true,
    readCi: true,
    publishComments: true,
    executeRepositoryCode: true,
    loadExtensions: true,
    accessNetwork: true,
    modifyWorkspace: true,
    commit: true,
    push: true,
    createPullRequest: true,
  },
};
const result: DshRunResult = {
  output: {
    protocolVersion: 1,
    operation: "task",
    state: "final",
    summary: "Applied the requested change",
    findings: [],
  },
  durationMs: 1,
  isolationReport: {
    backend: "docker",
    credentialMediated: true,
    repoToolsEnabled: true,
    processIsolated: true,
    networkIsolated: false,
    workspaceAccess: "read-write",
    extensionProfile: "github-action",
    limitations: [],
  },
};
const issue: IssueSnapshot = {
  kind: "issue",
  number: 7,
  title: "Implement the request",
  body: "Body",
  author: "alice",
  state: "open",
  updatedAt: "2026-08-22T00:00:00Z",
  contentFingerprint: "f".repeat(64),
  comments: [],
};
const pullRequest: PullRequestSnapshot = {
  kind: "pull_request",
  number: 8,
  title: "Fix the regression",
  body: "Body",
  author: "alice",
  baseSha: "b".repeat(40),
  baseRef: "main",
  baseRepository: "octo/repo",
  baseRepositoryId: 1,
  headSha: "a".repeat(40),
  headRef: "feature",
  headRepository: "octo/repo",
  headRepositoryId: 1,
  draft: false,
  isFork: false,
  changedFiles: [],
  diffTruncated: false,
  comments: [],
};
const entityContext = pullRequestContext({
  isPullRequest: false,
  repository: {
    id: 1,
    owner: "octo",
    repo: "repo",
    fullName: "octo/repo",
    defaultBranch: "trunk",
  },
});
const automationContext = {
  kind: "automation",
  rawEventName: "workflow_dispatch",
  eventName: "workflow_dispatch",
  runId: "10",
  actor: "alice",
  repository: {
    id: 1,
    owner: "octo",
    repo: "repo",
    fullName: "octo/repo",
    defaultBranch: "trunk",
  },
  payload: {},
  isPullRequestTarget: false,
} satisfies GitHubContext;

function command(operation: RoutedCommand["operation"]): RoutedCommand {
  return {
    operation,
    source: "explicit-input",
    instructions: "change the code",
    requestedAccess: "write",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.finishImplementation.mockResolvedValue({
    branch: "dsh/implement",
    pullNumber: 11,
    url: "https://github.com/octo/repo/pull/11",
  });
  mocks.finishAutomationTask.mockResolvedValue({
    branch: "dsh/task",
    pullNumber: 12,
    url: "https://github.com/octo/repo/pull/12",
  });
  mocks.finishFix.mockResolvedValue({
    status: "partial-success",
    commitSha: "c".repeat(40),
    paths: ["src/fix.ts"],
  });
});

describe("executeWrite", () => {
  it("routes an Issue implementation with immutable identity and validation deadline", async () => {
    const onPhase = vi.fn();
    const write = await executeWrite(
      client,
      entityContext,
      command("implement"),
      inputs({
        allowWrite: true,
        baseBranch: "release/next",
        branchPrefix: "automation/",
        branchNameTemplate: "{{prefix}}{{operation}}-{{key}}",
      }),
      policy,
      issue,
      workspace,
      "d".repeat(40),
      result,
      123_456,
      "task-key",
      onPhase,
    );

    expect(write).toEqual({
      writeStatus: "success",
      branchName: "dsh/implement",
      pullRequestNumber: 11,
      pullRequestUrl: "https://github.com/octo/repo/pull/11",
    });
    expect(mocks.finishImplementation).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 7,
        issueTitle: issue.title,
        baseBranch: "release/next",
        boundHeadSha: "d".repeat(40),
        validationDeadlineMs: 123_456,
        issueIdentity: {
          state: issue.state,
          updatedAt: issue.updatedAt,
          contentFingerprint: issue.contentFingerprint,
        },
        onPhase,
      }),
    );
    const finishCall = mocks.finishImplementation.mock.calls[0]?.[0] as unknown as {
      readonly inputs: ActionInputs;
    };
    expect(finishCall.inputs).toMatchObject({
      branchPrefix: "automation/",
      branchNameTemplate: "{{prefix}}{{operation}}-{{key}}",
    });
  });

  it("routes an Issue task and binds its related Issue identity", async () => {
    const write = await executeWrite(
      client,
      entityContext,
      command("task"),
      inputs({ allowWrite: true }),
      policy,
      issue,
      workspace,
      "d".repeat(40),
      result,
      123_456,
      "task-key",
      vi.fn(),
    );

    expect(write).toMatchObject({ writeStatus: "success", pullRequestNumber: 12 });
    expect(mocks.finishAutomationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        taskIdentity: issueTaskIdentity("task-key", issue),
        relatedIssue: {
          number: 7,
          identity: {
            state: issue.state,
            updatedAt: issue.updatedAt,
            contentFingerprint: issue.contentFingerprint,
          },
        },
      }),
    );
  });

  it("routes a same-repository pull request fix to the controller finalizer", async () => {
    const write = await executeWrite(
      client,
      pullRequestContext(),
      command("fix"),
      inputs({ allowWrite: true, baseBranch: "release/next" }),
      policy,
      pullRequest,
      workspace,
      "d".repeat(40),
      result,
      123_456,
      "task-key",
      vi.fn(),
    );

    expect(write).toEqual({
      writeStatus: "partial-success",
      commitSha: "c".repeat(40),
      changedPaths: ["src/fix.ts"],
    });
    expect(mocks.finishFix).toHaveBeenCalledWith(
      expect.objectContaining({
        boundHeadSha: pullRequest.headSha,
        headBranch: pullRequest.headRef,
        validationDeadlineMs: 123_456,
      }),
    );
  });

  it("routes an entity-less automation task with the bound default branch", async () => {
    const write = await executeWrite(
      client,
      automationContext,
      command("task"),
      inputs({
        allowWrite: true,
        baseBranch: "release/next",
        branchPrefix: "automation/",
        branchNameTemplate: "{{prefix}}{{operation}}-{{key}}",
      }),
      policy,
      undefined,
      workspace,
      "d".repeat(40),
      result,
      123_456,
      "automation-key",
      vi.fn(),
    );

    expect(write).toMatchObject({ writeStatus: "success", branchName: "dsh/task" });
    expect(mocks.finishAutomationTask).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: "release/next",
        taskIdentity: "automation-key",
        boundHeadSha: "d".repeat(40),
        branchPrefix: "automation/",
        branchNameTemplate: "{{prefix}}{{operation}}-{{key}}",
      }),
    );
  });

  it("fails closed for unsupported targets and before routing a cancelled write", async () => {
    await expect(
      executeWrite(
        client,
        entityContext,
        command("review"),
        inputs(),
        policy,
        issue,
        workspace,
        "d".repeat(40),
        result,
        123_456,
        "task-key",
        vi.fn(),
      ),
    ).rejects.toThrow("does not support this write operation");

    const controller = new AbortController();
    controller.abort();
    await expect(
      executeWrite(
        client,
        entityContext,
        command("implement"),
        inputs(),
        policy,
        issue,
        workspace,
        "d".repeat(40),
        result,
        123_456,
        "task-key",
        vi.fn(),
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.finishImplementation).not.toHaveBeenCalled();
  });
});
