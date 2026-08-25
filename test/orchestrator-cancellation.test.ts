import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ActionsCoreModule from "@actions/core";
import type * as FsPromisesModule from "node:fs/promises";
import type * as AgentLoopModule from "../src/agent/loop.js";
import { DshAbortedError, DshCredentialLeakError } from "../src/dsh/errors.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as GitHubFetchModule from "../src/github/fetch.js";
import type * as GitHubPayloadModule from "../src/github/payload.js";
import type * as GitHubPermissionsModule from "../src/github/permissions.js";
import type * as InputsModule from "../src/inputs.js";
import type * as WriteGitHubModule from "../src/write/github.js";
import { runAction } from "../src/orchestrator.js";
import { ValidationIntegrityError } from "../src/write/validation-integrity.js";
import { inputs } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  setSecret: vi.fn(),
  warning: vi.fn(),
  loadInputs: vi.fn(),
  readEventPayload: vi.fn(),
  createGitHubClient: vi.fn(),
  checkActorPermissions: vi.fn(),
  fetchEntitySnapshot: vi.fn(),
  runAgentLoop: vi.fn(),
  progressUpdate: vi.fn(),
  progressFail: vi.fn(),
  makeTemporaryWorkspace: vi.fn(),
  removeTemporaryWorkspace: vi.fn(),
  getBranchHead: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromisesModule>()),
  mkdtemp: mocks.makeTemporaryWorkspace,
  rm: mocks.removeTemporaryWorkspace,
}));

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof ActionsCoreModule>()),
  setSecret: mocks.setSecret,
  warning: mocks.warning,
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
}));

vi.mock("../src/agent/loop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentLoopModule>()),
  runAgentLoop: mocks.runAgentLoop,
}));

vi.mock("../src/write/github.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WriteGitHubModule>()),
  getBranchHead: mocks.getBranchHead,
}));

vi.mock("../src/github/progress.js", () => ({
  StickyProgressReporter: class {
    public readonly commentId = 71;
    public readonly update = mocks.progressUpdate;
    public readonly fail = mocks.progressFail;
  },
}));

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
      prompt: "Inspect the issue",
      taskAccess: "read",
      isolation: "none",
      progressComment: true,
      allowedTools: [],
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
  mocks.createGitHubClient.mockReturnValue({});
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
  mocks.fetchEntitySnapshot.mockResolvedValue({
    kind: "issue",
    number: 7,
    title: "Cancellation fixture",
    body: "Wait until the workflow is cancelled.",
    author: "alice",
    state: "open",
    updatedAt: "2026-08-22T00:00:00Z",
    contentFingerprint: "cancel-fixture",
    comments: [],
  });
  mocks.progressUpdate.mockResolvedValue(undefined);
  mocks.progressFail.mockResolvedValue(undefined);
  mocks.makeTemporaryWorkspace.mockResolvedValue("C:/dsh-action-cancellation-test");
  mocks.removeTemporaryWorkspace.mockResolvedValue(undefined);
  mocks.getBranchHead.mockResolvedValue("a".repeat(40));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("orchestrator cancellation finalization", () => {
  it("actively aborts pre-agent GitHub requests at the overall deadline", async () => {
    vi.useFakeTimers();
    mocks.loadInputs.mockReturnValue(
      inputs({
        command: "task",
        prompt: "Inspect the issue",
        taskAccess: "read",
        isolation: "none",
        progressComment: false,
        allowedTools: [],
        timeoutMinutes: 1,
      }),
    );
    let requestSignal: AbortSignal | undefined;
    mocks.createGitHubClient.mockImplementation((_token: string, signal?: AbortSignal) => {
      requestSignal = signal;
      return {};
    });
    mocks.checkActorPermissions.mockImplementation(
      async () =>
        await new Promise((_, reject) => {
          const abort = (): void => {
            reject(
              requestSignal?.reason instanceof Error
                ? requestSignal.reason
                : new Error("Controller request aborted"),
            );
          };
          if (requestSignal?.aborted === true) abort();
          else requestSignal?.addEventListener("abort", abort, { once: true });
        }),
    );

    const action = runAction();
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(action).resolves.toMatchObject({
      conclusion: "failure",
      error: { code: "AGENT_TIMEOUT", phase: "authorization", retryable: true },
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(mocks.runAgentLoop).not.toHaveBeenCalled();
  });

  it("propagates external cancellation through a pending Controller GitHub request", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    mocks.createGitHubClient.mockImplementation((_token: string, signal?: AbortSignal) => {
      requestSignal = signal;
      return {};
    });
    mocks.checkActorPermissions.mockImplementation(
      async () =>
        await new Promise((_, reject) => {
          const abort = (): void => {
            reject(
              requestSignal?.reason instanceof Error
                ? requestSignal.reason
                : new Error("Controller request aborted"),
            );
          };
          if (requestSignal?.aborted === true) abort();
          else requestSignal?.addEventListener("abort", abort, { once: true });
        }),
    );

    const action = runAction({ signal: controller.signal });
    await vi.waitFor(() => expect(requestSignal).toBeDefined());
    const cancellation = new DshAbortedError();
    controller.abort(cancellation);

    await expect(action).resolves.toMatchObject({
      conclusion: "failure",
      error: { code: "DSH_ABORTED", phase: "authorization" },
    });
    expect(requestSignal?.reason).toBe(cancellation);
    expect(mocks.runAgentLoop).not.toHaveBeenCalled();
  });

  it("turns a run signal into a terminal sticky failure", async () => {
    const controller = new AbortController();
    mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<unknown>;
      expect(hooks.signal).not.toBe(controller.signal);
      await hooks.onTurn?.(1, 3);
      const cancellation = new DshAbortedError();
      controller.abort(cancellation);
      expect(hooks.signal?.reason).toBe(cancellation);
      throw cancellation;
    });

    const outcome = await runAction({ signal: controller.signal });

    expect(outcome).toMatchObject({
      conclusion: "failure",
      operation: "task",
      commentId: 71,
      error: { code: "DSH_ABORTED", phase: "agent" },
    });
    expect(mocks.progressFail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DSH_ABORTED", phase: "agent" }),
    );
    expect(mocks.createGitHubClient).toHaveBeenNthCalledWith(1, "token", expect.any(AbortSignal));
    expect(mocks.createGitHubClient).toHaveBeenNthCalledWith(2, "token");
  });

  it("keeps a stable cancellation identity when the signal reason is foreign", async () => {
    const controller = new AbortController();
    mocks.runAgentLoop.mockImplementation(() => {
      controller.abort(new Error("DSH execution was aborted"));
      return Promise.reject(new Error("DSH execution was aborted"));
    });

    const outcome = await runAction({ signal: controller.signal });

    expect(outcome).toMatchObject({
      conclusion: "failure",
      error: { code: "DSH_ABORTED", phase: "agent" },
    });
    expect(mocks.progressFail).toHaveBeenCalledOnce();
    expect(mocks.progressFail).toHaveBeenCalledWith(
      expect.objectContaining({ code: "DSH_ABORTED", phase: "agent" }),
    );
  });

  it("preserves cancellation when terminal comment publication fails", async () => {
    const controller = new AbortController();
    mocks.progressFail.mockRejectedValueOnce(new Error("GitHub unavailable"));
    mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<unknown>;
      await hooks.onTurn?.(1, 3);
      const cancellation = new DshAbortedError();
      controller.abort(cancellation);
      throw cancellation;
    });

    const outcome = await runAction({ signal: controller.signal });

    expect(outcome).toMatchObject({
      conclusion: "failure",
      error: { code: "DSH_ABORTED", phase: "agent" },
    });
    expect(mocks.warning).toHaveBeenCalledWith(
      expect.stringContaining("progress comment finalization failed"),
    );
  });

  it("starts the terminal sticky update before nested cancellation cleanup settles", async () => {
    const controller = new AbortController();
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<unknown>;
      await hooks.onTurn?.(1, 3);
      const cancellation = new DshAbortedError();
      controller.abort(cancellation);
      await cleanup;
      throw cancellation;
    });

    let actionSettled = false;
    const action = runAction({ signal: controller.signal }).finally(() => {
      actionSettled = true;
    });
    await vi.waitFor(() => expect(mocks.progressFail).toHaveBeenCalledOnce());
    expect(actionSettled).toBe(false);

    releaseCleanup?.();
    const outcome = await action;
    expect(outcome.error?.code).toBe("DSH_ABORTED");
  });

  it("starts terminal publication before a failed workspace preparation finishes cleanup", async () => {
    mocks.loadInputs.mockReturnValue(
      inputs({
        command: "task",
        prompt: "Inspect the issue",
        taskAccess: "read",
        isolation: "docker",
        progressComment: true,
        allowedTools: [],
      }),
    );
    const workspaceFailure = new Error("Cannot resolve the immutable branch head");
    mocks.getBranchHead.mockRejectedValueOnce(workspaceFailure);
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    mocks.removeTemporaryWorkspace.mockImplementationOnce(async () => await cleanup);

    let actionSettled = false;
    const action = runAction().finally(() => {
      actionSettled = true;
    });

    await vi.waitFor(() => expect(mocks.progressFail).toHaveBeenCalledOnce());
    expect(mocks.removeTemporaryWorkspace).toHaveBeenCalledOnce();
    expect(actionSettled).toBe(false);

    releaseCleanup?.();
    await expect(action).resolves.toMatchObject({
      conclusion: "failure",
      error: { code: "ACTION_RUNTIME_FAILED", phase: "context" },
    });
    expect(mocks.runAgentLoop).not.toHaveBeenCalled();
  });

  it("does not let a concurrent signal hide an independent integrity failure", async () => {
    const controller = new AbortController();
    const integrity = new ValidationIntegrityError({
      schemaVersion: 1,
      mode: "strict",
      status: "blocked",
      changeCount: 1,
      dangerousChangeCount: 1,
      controlPlaneChangeCount: 1,
      testChangeCount: 0,
      changes: [],
      truncated: false,
    });
    mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<unknown>;
      await hooks.onTurn?.(1, 3);
      controller.abort(new DshAbortedError());
      throw integrity;
    });

    const outcome = await runAction({ signal: controller.signal });

    expect(outcome).toMatchObject({
      conclusion: "failure",
      error: { code: "VALIDATION_INTEGRITY", category: "domain", phase: "agent" },
      validation: {
        status: "failed",
        integrity: { mode: "strict", status: "blocked", dangerousChangeCount: 1 },
      },
    });
    expect(mocks.progressFail).toHaveBeenCalledTimes(2);
    expect(mocks.progressFail).toHaveBeenLastCalledWith(
      expect.objectContaining({
        code: "VALIDATION_INTEGRITY",
        category: "domain",
        phase: "agent",
      }),
    );
  });

  it("promotes a credential failure over a provisional concurrent cancellation", async () => {
    const controller = new AbortController();
    const credential = new DshCredentialLeakError("stdout");
    mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<unknown>;
      await hooks.onTurn?.(1, 3);
      controller.abort(new DshAbortedError());
      throw credential;
    });

    const outcome = await runAction({ signal: controller.signal });

    expect(outcome).toMatchObject({
      conclusion: "failure",
      error: { code: "DSH_CREDENTIAL_LEAK", phase: "agent" },
    });
    expect(mocks.progressFail).toHaveBeenCalledTimes(2);
    expect(mocks.progressFail).toHaveBeenLastCalledWith(
      expect.objectContaining({ code: "DSH_CREDENTIAL_LEAK", phase: "agent" }),
    );
  });
});
