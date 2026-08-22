import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DshRunResult } from "../src/dsh/runner.js";
import { DshAbortedError } from "../src/dsh/errors.js";
import type { GitHubClient } from "../src/github/client.js";
import type { WorkspaceSnapshot } from "../src/write/workspace.js";
import { inputs } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  assertRemoteBranchHead: vi.fn(),
  assertValidation: vi.fn(),
  createCommit: vi.fn(),
  inspectChanges: vi.fn(),
  publishStatus: vi.fn(),
  revalidateIdentity: vi.fn(),
  runValidation: vi.fn(),
  updateRemoteBranch: vi.fn(),
  warning: vi.fn(),
  summaryHeading: vi.fn(),
  summaryRaw: vi.fn(),
  summaryWrite: vi.fn(),
}));

vi.mock("@actions/core", () => {
  const summary = {
    addHeading(...args: unknown[]) {
      mocks.summaryHeading(...args);
      return summary;
    },
    addRaw(...args: unknown[]) {
      mocks.summaryRaw(...args);
      return summary;
    },
    write(...args: unknown[]) {
      mocks.summaryWrite(...args);
      return Promise.resolve(summary);
    },
  };
  return { warning: mocks.warning, summary };
});
vi.mock("../src/github/status.js", () => ({ publishStatusComment: mocks.publishStatus }));
vi.mock("../src/write/pr.js", () => ({
  revalidatePullRequestIdentity: mocks.revalidateIdentity,
}));
vi.mock("../src/write/github.js", () => ({
  assertRemoteBranchHead: mocks.assertRemoteBranchHead,
  createGitHubCommitFromWorkspace: mocks.createCommit,
  updateRemoteBranch: mocks.updateRemoteBranch,
}));
vi.mock("../src/write/validate.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../src/write/validate.js")),
  assertValidationSucceeded: mocks.assertValidation,
  assertWriteValidationConfigured: (runTests: boolean, commands: readonly unknown[]) => {
    if (!runTests) throw new Error("run-tests=false cannot authorize a repository write");
    if (commands.length === 0) throw new Error("test-commands must contain at least one command");
  },
  runValidationCommandsInDocker: mocks.runValidation,
}));
vi.mock("../src/write/workspace.js", () => ({ inspectWorkspaceChanges: mocks.inspectChanges }));

import { finishFix } from "../src/commands/fix.js";

const commitSha = "c".repeat(40);
const result: DshRunResult = {
  output: {
    protocolVersion: 1,
    operation: "fix",
    state: "final",
    summary: "Fixed the root cause",
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.inspectChanges.mockResolvedValue({
    added: [],
    modified: ["src/fix.ts"],
    deleted: [],
    all: ["src/fix.ts"],
  });
  mocks.createCommit.mockResolvedValue({ sha: commitSha, paths: ["src/fix.ts"] });
  mocks.publishStatus.mockResolvedValue(undefined);
  mocks.revalidateIdentity.mockResolvedValue(undefined);
  mocks.assertRemoteBranchHead.mockResolvedValue(undefined);
  mocks.updateRemoteBranch.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("finishFix recovery", () => {
  it("uses one absolute deadline across identity checks and Docker validation", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    mocks.revalidateIdentity.mockImplementationOnce(() => {
      clock += 9 * 60_000;
      return Promise.resolve();
    });

    await finishFix({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 1,
      snapshot,
      boundHeadSha: "a".repeat(40),
      headBranch: "feature",
      identity: {
        headSha: "a".repeat(40),
        headRef: "feature",
        headRepositoryId: 1,
        baseRepositoryId: 1,
      },
      result,
      inputs: inputs({ testCommands: [["npm", "test"]] }),
      runUrl: "https://github.com/octo/repo/actions/runs/1",
      validationDeadlineMs: 1_000 + 10 * 60_000,
    });

    expect(mocks.runValidation.mock.calls[0]?.[3]).toBe(60_000);
  });

  it("does not start later validation work or mutate after the shared deadline expires", async () => {
    let clock = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    mocks.revalidateIdentity.mockImplementationOnce(() => {
      clock += 10 * 60_000 + 1;
      return Promise.resolve();
    });

    await expect(
      finishFix({
        client: {} as GitHubClient,
        target: { owner: "octo", repo: "repo", issueNumber: 7 },
        expectedAuthorId: 1,
        snapshot,
        boundHeadSha: "a".repeat(40),
        headBranch: "feature",
        identity: {
          headSha: "a".repeat(40),
          headRef: "feature",
          headRepositoryId: 1,
          baseRepositoryId: 1,
        },
        result,
        inputs: inputs({ testCommands: [["npm", "test"]] }),
        runUrl: "https://github.com/octo/repo/actions/runs/1",
        validationDeadlineMs: 1_000 + 10 * 60_000,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_TIMEOUT" });

    expect(mocks.inspectChanges).not.toHaveBeenCalled();
    expect(mocks.runValidation).not.toHaveBeenCalled();
    expect(mocks.createCommit).not.toHaveBeenCalled();
    expect(mocks.updateRemoteBranch).not.toHaveBeenCalled();
  });

  it("fails closed before commit or branch mutation when default validation has no commands", async () => {
    const onPhase = vi.fn();
    await expect(
      finishFix({
        client: {} as GitHubClient,
        target: { owner: "octo", repo: "repo", issueNumber: 7 },
        expectedAuthorId: 1,
        snapshot,
        boundHeadSha: "a".repeat(40),
        headBranch: "feature",
        identity: {
          headSha: "a".repeat(40),
          headRef: "feature",
          headRepositoryId: 1,
          baseRepositoryId: 1,
        },
        result,
        inputs: inputs(),
        runUrl: "https://github.com/octo/repo/actions/runs/1",
        onPhase,
      }),
    ).rejects.toThrow("test-commands must contain at least one command");

    expect(mocks.runValidation).not.toHaveBeenCalled();
    expect(mocks.createCommit).not.toHaveBeenCalled();
    expect(mocks.updateRemoteBranch).not.toHaveBeenCalled();
    expect(mocks.publishStatus).not.toHaveBeenCalled();
    expect(onPhase).toHaveBeenLastCalledWith("validation");
  });

  it("reports partial success instead of failing after a pushed fix when comment publication fails", async () => {
    mocks.publishStatus.mockRejectedValue(new Error("GitHub comments unavailable"));
    const onPhase = vi.fn();

    const outcome = await finishFix({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 1,
      snapshot,
      boundHeadSha: "a".repeat(40),
      headBranch: "feature",
      identity: {
        headSha: "a".repeat(40),
        headRef: "feature",
        headRepositoryId: 1,
        baseRepositoryId: 1,
      },
      result,
      inputs: inputs({ testCommands: [["npm", "test"]] }),
      runUrl: "https://github.com/octo/repo/actions/runs/1",
      onPhase,
    });

    expect(outcome).toMatchObject({ commitSha, status: "partial-success" });
    expect(mocks.updateRemoteBranch).toHaveBeenCalledOnce();
    expect(mocks.warning).toHaveBeenCalledWith(expect.stringContaining("Partial success"));
    expect(mocks.summaryHeading).toHaveBeenCalledWith("DeepSeek Harness fix: partial success", 2);
    expect(onPhase.mock.calls).toEqual([["validation"], ["write"]]);
  });

  it("keeps generic PR tasks on the task marker and commit vocabulary", async () => {
    await finishFix({
      client: {} as GitHubClient,
      target: { owner: "octo", repo: "repo", issueNumber: 7 },
      expectedAuthorId: 1,
      snapshot,
      boundHeadSha: "a".repeat(40),
      headBranch: "feature",
      identity: {
        headSha: "a".repeat(40),
        headRef: "feature",
        headRepositoryId: 1,
        baseRepositoryId: 1,
      },
      result: {
        ...result,
        output: { ...result.output, operation: "task", summary: "Updated the cache" },
      },
      inputs: inputs({ testCommands: [["npm", "test"]] }),
      runUrl: "https://github.com/octo/repo/actions/runs/1",
    });
    expect(mocks.createCommit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ message: "feat: apply DeepSeek Harness task" }),
      snapshot,
    );
    expect(mocks.publishStatus).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      expect.stringContaining("task prepared"),
      expect.any(String),
      expect.any(String),
      "task",
    );
  });

  it("rejects an explicit unverified write before validation or mutation", async () => {
    await expect(
      finishFix({
        client: {} as GitHubClient,
        target: { owner: "octo", repo: "repo", issueNumber: 7 },
        expectedAuthorId: 1,
        snapshot,
        boundHeadSha: "a".repeat(40),
        headBranch: "feature",
        identity: {
          headSha: "a".repeat(40),
          headRef: "feature",
          headRepositoryId: 1,
          baseRepositoryId: 1,
        },
        result,
        inputs: inputs({ runTests: false, testCommands: [["npm", "test"]] }),
        runUrl: "https://github.com/octo/repo/actions/runs/1",
      }),
    ).rejects.toThrow("run-tests=false cannot authorize a repository write");
    expect(mocks.runValidation).not.toHaveBeenCalled();
    expect(mocks.createCommit).not.toHaveBeenCalled();
    expect(mocks.updateRemoteBranch).not.toHaveBeenCalled();
  });

  it("performs no GitHub mutation when cancellation lands as validation returns", async () => {
    const controller = new AbortController();
    const cancellation = new DshAbortedError();
    mocks.runValidation.mockImplementationOnce(() => {
      controller.abort(cancellation);
      return Promise.resolve([]);
    });

    await expect(
      finishFix({
        client: {} as GitHubClient,
        target: { owner: "octo", repo: "repo", issueNumber: 7 },
        expectedAuthorId: 1,
        snapshot,
        boundHeadSha: "a".repeat(40),
        headBranch: "feature",
        identity: {
          headSha: "a".repeat(40),
          headRef: "feature",
          headRepositoryId: 1,
          baseRepositoryId: 1,
        },
        result,
        inputs: inputs({ testCommands: [["npm", "test"]] }),
        runUrl: "https://github.com/octo/repo/actions/runs/1",
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(mocks.createCommit).not.toHaveBeenCalled();
    expect(mocks.updateRemoteBranch).not.toHaveBeenCalled();
    expect(mocks.publishStatus).not.toHaveBeenCalled();
  });
});
