import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DshRunResult } from "../src/dsh/runner.js";
import type { GitHubClient } from "../src/github/client.js";
import type { WorkspaceSnapshot } from "../src/write/workspace.js";
import { inputs } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  assertRemoteBranchHead: vi.fn(),
  assertValidation: vi.fn(),
  assertEquivalent: vi.fn(),
  assertOwned: vi.fn(),
  buildOperation: vi.fn(),
  createCommit: vi.fn(),
  createRemoteBranch: vi.fn(),
  createPullRequest: vi.fn(),
  findCommit: vi.fn(),
  findPullRequest: vi.fn(),
  revalidateIssue: vi.fn(),
  runValidation: vi.fn(),
}));

vi.mock("../src/write/github.js", () => ({
  assertRemoteBranchHead: mocks.assertRemoteBranchHead,
  createGitHubCommitFromWorkspace: mocks.createCommit,
  createRemoteBranch: mocks.createRemoteBranch,
}));
vi.mock("../src/write/implementation.js", () => ({
  assertEquivalentImplementationCommit: mocks.assertEquivalent,
  assertImplementationCommitOwned: mocks.assertOwned,
  buildImplementationOperation: mocks.buildOperation,
  findReconciledImplementationCommit: mocks.findCommit,
}));
vi.mock("../src/write/issue.js", () => ({ revalidateIssueIdentity: mocks.revalidateIssue }));
vi.mock("../src/write/pr.js", () => ({
  createPullRequest: mocks.createPullRequest,
  findPullRequestByOperationKey: mocks.findPullRequest,
}));
vi.mock("../src/write/validate.js", () => ({
  assertValidationSucceeded: mocks.assertValidation,
  assertWriteValidationConfigured: (runTests: boolean, commands: readonly unknown[]) => {
    if (!runTests) throw new Error("run-tests=false cannot authorize a repository write");
    if (commands.length === 0) throw new Error("test-commands must contain at least one command");
  },
  runValidationCommandsInDocker: mocks.runValidation,
}));

import { finishImplementation } from "../src/commands/implement.js";

const result: DshRunResult = {
  output: {
    protocolVersion: 1,
    operation: "implement",
    state: "final",
    summary: "Implemented the issue",
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
const snapshot: WorkspaceSnapshot = {
  sourceRoot: "source",
  workerRoot: "worker",
  baseline: new Map(),
};
const issueIdentity = {
  state: "open",
  updatedAt: "2026-08-14T00:00:00Z",
  contentFingerprint: "f".repeat(64),
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildOperation.mockReturnValue({
    key: "operation",
    snapshotFingerprint: "snapshot",
    branch: "dsh/issue-7-operation",
    commitMessage: "feat: implement #7\n\nDSH-Operation: operation",
    pullRequestMarker: "<!-- dsh-action:implement:v1 operation=operation snapshot=snapshot -->",
  });
  mocks.findCommit.mockResolvedValue(null);
  mocks.findPullRequest.mockResolvedValue(null);
  mocks.revalidateIssue.mockResolvedValue(undefined);
  mocks.assertRemoteBranchHead.mockResolvedValue(undefined);
  mocks.createCommit.mockResolvedValue({ sha: "c".repeat(40), paths: ["src/new.ts"] });
  mocks.createPullRequest.mockResolvedValue({ number: 8, url: "https://github.com/o/r/pull/8" });
  mocks.runValidation.mockResolvedValue([
    {
      argv: ["npm", "test"],
      result: { exitCode: 0, stdout: "", stderr: "", timedOut: false, outputTruncated: false },
    },
  ]);
});

describe("finishImplementation validation gate", () => {
  it("fails closed before commit, branch, or PR creation for the default empty command list", async () => {
    await expect(
      finishImplementation({
        client: {} as GitHubClient,
        owner: "octo",
        repo: "repo",
        issueNumber: 7,
        issueTitle: "Add a safe parser",
        issueIdentity,
        baseBranch: "main",
        snapshot,
        boundHeadSha: "a".repeat(40),
        operationKey: "10",
        result,
        inputs: inputs(),
      }),
    ).rejects.toThrow("test-commands must contain at least one command");

    expect(mocks.runValidation).not.toHaveBeenCalled();
    expect(mocks.revalidateIssue).toHaveBeenCalledOnce();
    expect(mocks.createCommit).not.toHaveBeenCalled();
    expect(mocks.createRemoteBranch).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
  });

  it("validates, rechecks issue/base identity, creates a branch, and opens a marked PR", async () => {
    const onPhase = vi.fn();
    const outcome = await finishImplementation({
      client: {} as GitHubClient,
      owner: "octo",
      repo: "repo",
      issueNumber: 7,
      issueTitle: "Add a safe parser",
      issueIdentity,
      baseBranch: "main",
      snapshot,
      boundHeadSha: "a".repeat(40),
      operationKey: "10",
      result,
      inputs: inputs({ testCommands: [["npm", "test"]] }),
      onPhase,
    });

    expect(outcome).toEqual({
      branch: "dsh/issue-7-operation",
      pullNumber: 8,
      url: "https://github.com/o/r/pull/8",
    });
    expect(mocks.runValidation).toHaveBeenCalledOnce();
    expect(mocks.revalidateIssue).toHaveBeenCalledTimes(5);
    expect(mocks.createRemoteBranch).toHaveBeenCalledWith(
      expect.anything(),
      "octo",
      "repo",
      "dsh/issue-7-operation",
      "c".repeat(40),
    );
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      expect.anything(),
      "octo",
      "repo",
      "dsh/issue-7-operation",
      "main",
      expect.any(String),
      expect.stringContaining("configured commands passed"),
      expect.stringContaining("dsh-action:implement"),
    );
    expect(onPhase.mock.calls).toEqual([["write"], ["validation"], ["write"]]);
  });

  it("sanitizes untrusted issue and model text before creating the pull request", async () => {
    await finishImplementation({
      client: {} as GitHubClient,
      owner: "octo",
      repo: "repo",
      issueNumber: 7,
      issueTitle: "unsafe\r\n@team ![pixel](https://tracker.invalid)",
      issueIdentity,
      baseBranch: "main",
      snapshot,
      boundHeadSha: "a".repeat(40),
      operationKey: "10",
      result: {
        ...result,
        output: {
          ...result.output,
          summary: "done @team ![pixel](https://tracker.invalid) <!-- dsh-action:summary:v1 -->",
        },
      },
      inputs: inputs({ testCommands: [["npm", "test"]] }),
    });

    const call = mocks.createPullRequest.mock.calls.at(-1);
    expect(String(call?.[5])).not.toContain("\n");
    expect(String(call?.[5])).toContain("@​team [image removed]");
    expect(String(call?.[6])).toContain("@​team [image removed]");
    expect(String(call?.[6])).not.toContain("dsh-action:summary:v1");
  });

  it("returns a completed controller-owned operation without mutating again", async () => {
    mocks.findPullRequest.mockResolvedValue({
      number: 8,
      url: "https://github.com/o/r/pull/8",
      headSha: "c".repeat(40),
      snapshotFingerprint: "snapshot",
    });
    const outcome = await finishImplementation({
      client: {} as GitHubClient,
      owner: "octo",
      repo: "repo",
      issueNumber: 7,
      issueTitle: "Add a safe parser",
      issueIdentity,
      baseBranch: "main",
      snapshot,
      boundHeadSha: "a".repeat(40),
      operationKey: "10",
      result,
      inputs: inputs(),
    });
    expect(outcome.pullNumber).toBe(8);
    expect(mocks.assertOwned).toHaveBeenCalledOnce();
    expect(mocks.revalidateIssue).not.toHaveBeenCalled();
    expect(mocks.createCommit).not.toHaveBeenCalled();
  });

  it("fails before writing when configured validation fails", async () => {
    mocks.assertValidation.mockImplementationOnce(() => {
      throw new Error('Validation command "npm test" exited with code 1');
    });
    mocks.runValidation.mockResolvedValue([
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
    await expect(
      finishImplementation({
        client: {} as GitHubClient,
        owner: "octo",
        repo: "repo",
        issueNumber: 7,
        issueTitle: "Add a safe parser",
        issueIdentity,
        baseBranch: "main",
        snapshot,
        boundHeadSha: "a".repeat(40),
        operationKey: "10",
        result,
        inputs: inputs({ testCommands: [["npm", "test"]] }),
      }),
    ).rejects.toThrow('Validation command "npm test" exited with code 1');
    expect(mocks.createCommit).not.toHaveBeenCalled();
  });
});
