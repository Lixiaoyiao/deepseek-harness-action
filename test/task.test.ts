import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DshRunResult } from "../src/dsh/runner.js";
import type { GitHubClient } from "../src/github/client.js";
import type { WorkspaceSnapshot } from "../src/write/workspace.js";

const mocks = vi.hoisted(() => ({
  assertEquivalent: vi.fn(),
  assertOwned: vi.fn(),
  assertRemoteBranchHead: vi.fn(),
  assertValidation: vi.fn(),
  buildOperation: vi.fn(),
  createCommit: vi.fn(),
  createPullRequest: vi.fn(),
  createRemoteBranch: vi.fn(),
  findPullRequest: vi.fn(),
  findReconciledCommit: vi.fn(),
  revalidateIssue: vi.fn(),
  runValidation: vi.fn(),
  upsertComment: vi.fn(),
}));

vi.mock("../src/write/github.js", () => ({
  assertRemoteBranchHead: mocks.assertRemoteBranchHead,
  createGitHubCommitFromWorkspace: mocks.createCommit,
  createRemoteBranch: mocks.createRemoteBranch,
}));
vi.mock("../src/write/pr.js", () => ({
  createPullRequest: mocks.createPullRequest,
  findTaskPullRequestByOperationKey: mocks.findPullRequest,
}));
vi.mock("../src/write/task.js", () => ({
  assertEquivalentTaskCommit: mocks.assertEquivalent,
  assertTaskCommitOwned: mocks.assertOwned,
  buildAutomationTaskOperation: mocks.buildOperation,
  findReconciledTaskCommit: mocks.findReconciledCommit,
}));
vi.mock("../src/write/issue.js", () => ({ revalidateIssueIdentity: mocks.revalidateIssue }));
vi.mock("../src/write/validate.js", () => ({
  assertValidationSucceeded: mocks.assertValidation,
  runValidationCommandsInDocker: mocks.runValidation,
}));
vi.mock("../src/github/comments.js", () => ({ upsertTrackingComment: mocks.upsertComment }));

import { finishAutomationTask, publishTaskAnswer } from "../src/commands/task.js";

const baseSha = "a".repeat(40);
const existingSha = "b".repeat(40);
const candidateSha = "c".repeat(40);
const operation = {
  key: "d".repeat(24),
  snapshotFingerprint: "e".repeat(24),
  branch: `dsh/task-${"d".repeat(24)}`,
  commitMessage: `feat: apply DeepSeek Harness task\n\nDSH-Task-Key: ${"d".repeat(24)}\nDSH-Task-Snapshot: ${"e".repeat(24)}`,
  pullRequestMarker: `<!-- dsh-action:task:v1 operation=${"d".repeat(24)} snapshot=${"e".repeat(24)} -->`,
};
const snapshot: WorkspaceSnapshot = {
  sourceRoot: "source",
  workerRoot: "worker",
  baseline: new Map(),
};
const result: DshRunResult = {
  output: {
    protocolVersion: 1,
    operation: "task",
    state: "final",
    summary: "Update the cache safely",
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
    limitations: [],
  },
};

const taskInput = () => ({
  client: {} as GitHubClient,
  owner: "o",
  repo: "r",
  baseBranch: "main",
  boundHeadSha: baseSha,
  runIdentity: "run-1",
  taskIdentity: "task-1",
  snapshot,
  result,
  runUrl: "https://github.com/o/r/actions/runs/1",
  runTests: true,
  testCommands: [["npm", "test"]] as const,
  containerImage: `node@sha256:${"f".repeat(64)}`,
  validationTimeoutMs: 30_000,
  relatedIssue: { number: 7, identity: { state: "open", updatedAt: "2026-08-15" } },
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildOperation.mockReturnValue(operation);
  mocks.findPullRequest.mockResolvedValue(null);
  mocks.findReconciledCommit.mockResolvedValue(null);
  mocks.assertRemoteBranchHead.mockResolvedValue(undefined);
  mocks.revalidateIssue.mockResolvedValue(undefined);
  mocks.runValidation.mockResolvedValue([]);
  mocks.createCommit.mockResolvedValue({ sha: candidateSha, paths: ["src/cache.ts"] });
  mocks.createPullRequest.mockResolvedValue({ number: 9, url: "https://github.com/o/r/pull/9" });
});

describe("generic automation task finalizer", () => {
  it("publishes a bounded generic task answer under the task marker", async () => {
    await publishTaskAnswer(
      {} as GitHubClient,
      { owner: "o", repo: "r", issueNumber: 7 },
      41898282,
      {
        ...result,
        output: {
          ...result.output,
          summary: "Answer\n<!-- dsh-action:write -->\nwith marker-like data",
        },
      },
      "https://github.com/o/r/actions/runs/1",
    );
    expect(mocks.upsertComment).toHaveBeenCalledWith(
      expect.anything(),
      { owner: "o", repo: "r", issueNumber: 7 },
      41898282,
      "task",
      expect.stringContaining("## DeepSeek Harness task"),
    );
    const body = String(mocks.upsertComment.mock.calls[0]?.[4]);
    expect(body).toContain("<!-- dsh-action:v1 kind=task -->");
    expect(body).not.toContain("<!-- dsh-action:write -->");
  });

  it("reconciles an already completed task without repeating validation or writes", async () => {
    mocks.findPullRequest.mockResolvedValue({
      number: 9,
      url: "https://github.com/o/r/pull/9",
      headSha: existingSha,
      snapshotFingerprint: operation.snapshotFingerprint,
    });
    await expect(finishAutomationTask(taskInput())).resolves.toEqual({
      branch: operation.branch,
      pullNumber: 9,
      url: "https://github.com/o/r/pull/9",
    });
    expect(mocks.assertOwned).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      existingSha,
      operation.key,
      operation.snapshotFingerprint,
    );
    expect(mocks.runValidation).not.toHaveBeenCalled();
    expect(mocks.createCommit).not.toHaveBeenCalled();
  });

  it("reuses only an equivalent orphan branch and keeps generic task semantics", async () => {
    mocks.findReconciledCommit.mockResolvedValue(existingSha);
    const finished = await finishAutomationTask(taskInput());
    expect(finished).toEqual({
      branch: operation.branch,
      pullNumber: 9,
      url: "https://github.com/o/r/pull/9",
    });
    expect(mocks.assertEquivalent).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      existingSha,
      candidateSha,
      operation,
      baseSha,
    );
    expect(mocks.createRemoteBranch).not.toHaveBeenCalled();
    expect(mocks.revalidateIssue).toHaveBeenCalled();
    const body = String(mocks.createPullRequest.mock.calls.at(-1)?.[6]);
    expect(body).toContain("Related to #7");
    expect(body).not.toContain("Closes #7");
    expect(body).toContain(operation.pullRequestMarker);
  });

  it("creates a stable branch for a fresh verified task", async () => {
    await finishAutomationTask(taskInput());
    expect(mocks.createRemoteBranch).toHaveBeenCalledWith(
      expect.anything(),
      "o",
      "r",
      operation.branch,
      candidateSha,
    );
    expect(mocks.assertValidation).toHaveBeenCalledWith([]);
  });

  it("requires an explicit validation suite unless unverified writes are opted into", async () => {
    await expect(finishAutomationTask({ ...taskInput(), testCommands: [] })).rejects.toThrow(
      "test-commands is empty",
    );
    expect(mocks.runValidation).not.toHaveBeenCalled();
    expect(mocks.createCommit).not.toHaveBeenCalled();
  });
});
