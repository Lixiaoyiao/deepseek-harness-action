import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDshRuntime, disposeDshRuntime, type DshRuntime } from "../src/dsh/runtime.js";
import { ControlledComposition } from "../src/dsh/controlled-composition.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { createGitHubClient } from "../src/github/client.js";
import type { RunState } from "../src/orchestration/lifecycle.js";
import type { AuthorizedRun } from "../src/orchestration/prepare.js";
import type { ControlledActionInputs } from "../src/inputs.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { prepareControllerSession } from "../src/session/controller.js";
import { PolicyDeniedError } from "../src/errors.js";
import type { checkActorPermissions } from "../src/github/permissions.js";
import type {
  prepareSessionArtifacts,
  saveSessionArtifact,
  PreparedSessionArtifacts,
} from "../src/session/artifact-store.js";
import type {
  exportSessionCheckpoint,
  importSessionCheckpoint,
  inspectStoredSession,
} from "../src/session/checkpoint.js";
import type {
  SessionCheckpoint,
  SessionManifestWithoutPayload,
  SessionRunIdentity,
} from "../src/session/contracts.js";
import { sessionKeyHash } from "../src/session/contracts.js";
import { inputs, permissions, pullRequestContext } from "./helpers.js";

const transport = vi.hoisted(() => ({
  prepare: vi.fn<typeof prepareSessionArtifacts>(),
  save: vi.fn<typeof saveSessionArtifact>(),
  restore: vi.fn<typeof importSessionCheckpoint>(),
  export: vi.fn<typeof exportSessionCheckpoint>(),
  inspect: vi.fn<typeof inspectStoredSession>(),
  permissions: vi.fn<typeof checkActorPermissions>(),
}));
vi.mock("../src/session/artifact-store.js", () => ({
  prepareSessionArtifacts: transport.prepare,
  saveSessionArtifact: transport.save,
}));
vi.mock("../src/session/checkpoint.js", () => ({
  SESSION_CHECKPOINT_LIMITS: { knownSecrets: 256 },
  importSessionCheckpoint: transport.restore,
  exportSessionCheckpoint: transport.export,
  inspectStoredSession: transport.inspect,
}));
vi.mock("../src/github/permissions.js", () => ({ checkActorPermissions: transport.permissions }));

const sessionId = "session-12345678-1234-1234-1234-123456789abc";
const environment = {
  GITHUB_WORKFLOW_REF: "octo/repo/.github/workflows/session.yml@refs/heads/main",
  GITHUB_WORKFLOW_SHA: "a".repeat(40),
  GITHUB_JOB: "session",
  GITHUB_RUN_ATTEMPT: "1",
  ACTIONS_RUNTIME_TOKEN: "artifact-credential",
};
const runtimes: DshRuntime[] = [];
function checkpointFixture(manifest: SessionManifestWithoutPayload): SessionCheckpoint {
  return {
    manifest: { ...manifest, payload: { file: "session.jsonl", bytes: 1, sha256: "b".repeat(64) } },
    payload: new Uint8Array([1]),
  };
}

function sourceIdentity(runId: number): SessionRunIdentity {
  return {
    runId,
    runAttempt: 1,
    sourceSha: "a".repeat(40),
    actorId: 3,
    actorLogin: "alice",
    jobRunId: 100,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  transport.permissions.mockResolvedValue(permissions(true));
  transport.prepare.mockImplementation(async (options): Promise<PreparedSessionArtifacts> => {
    await options.authorizeCurrent();
    return {
      binding: {
        ...options.binding,
        workflow: { ...options.binding.workflow, jobName: "Verified static job name" },
      },
      current: sourceIdentity(10),
      generation: 1,
      selection: "created",
      claimArtifactId: 99,
      options,
    };
  });
  transport.save.mockImplementation(async ({ prepared }) => {
    await prepared.options.authorizeCurrent();
    return { id: 101, name: "verified-checkpoint", generation: 1 };
  });
  transport.export.mockImplementation(({ manifest }) =>
    Promise.resolve(checkpointFixture(manifest)),
  );
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(disposeDshRuntime));
});
function options(overrides: Partial<ControlledActionInputs> = {}) {
  const configured = inputs({ sessionMode: "save", sessionKey: "logical-task", ...overrides });
  const context = pullRequestContext({ rawEventName: "issue_comment" });
  const policy = evaluatePolicy({
    context,
    operation: "task",
    allowWrite: false,
    permissions: permissions(true),
    requestedAccess: "read",
    commandSource: "explicit-input",
  });
  const authorized: AuthorizedRun = {
    context,
    client: createGitHubClient("controller-github-secret"),
    command: {
      operation: "task",
      source: "explicit-input",
      requestedAccess: "read",
      instructions: "current follow-up",
    },
    currentRunUrl: "https://github.com/octo/repo/actions/runs/10",
    policy,
    deferWriteProgress: false,
    initializeProgress: () => undefined,
  };
  const state: RunState = { phase: "context" };
  const extensions = resolveExtensionPlan({
    allowedTools: [],
    mcp: configured.mcpConfig,
    plugins: configured.pluginConfig,
    allowPluginInstall: false,
    policy,
  });
  return {
    inputs: configured,
    authorized,
    state,
    composition: new ControlledComposition(),
    extensions,
    deadlineMs: Date.now() + 10_000,
    signal: new AbortController().signal,
    environment,
  };
}
async function freshRuntime() {
  const value = await createDshRuntime();
  runtimes.push(value);
  return value;
}

describe("Controller Session integration with isolated transport", () => {
  it("auto normalizes logical keys and reports automatic checkpoint selection", async () => {
    const configured = options({ sessionMode: "auto", sessionKey: "Logical-Task" });
    transport.prepare.mockImplementationOnce(async (request) => {
      await request.authorizeCurrent();
      return {
        binding: request.binding,
        current: sourceIdentity(10),
        source: sourceIdentity(9),
        generation: 2,
        selection: "resumed",
        claimArtifactId: 99,
        options: request,
      };
    });
    await prepareControllerSession(configured);
    expect(transport.prepare.mock.calls[0]?.[0]).toMatchObject({
      mode: "auto",
      binding: { keyHash: sessionKeyHash("logical-task") },
    });
    expect(transport.prepare.mock.calls[0]?.[0]).not.toHaveProperty("sourceRunId");
    expect(configured.state.session).toMatchObject({
      mode: "auto",
      status: "claimed",
      selection: "resumed",
      generation: 2,
      sourceRunId: 9,
    });
  });
  it("retains an acknowledged claim when subsequent fresh metadata verification fails", async () => {
    const configured = options();
    transport.prepare.mockImplementationOnce((request) => {
      request.onUploadReceipt?.({ kind: "claim", id: 999, name: "claim" });
      return Promise.reject(new PolicyDeniedError("confirmed claim metadata unavailable"));
    });
    await expect(prepareControllerSession(configured)).rejects.toThrow(
      "confirmed claim metadata unavailable",
    );
    expect(configured.state.session).toMatchObject({ status: "failed", claimArtifactId: 999 });
  });
  it("retains checkpoint receipt and raw checksum after an acknowledged upload fails verification", async () => {
    const configured = options();
    const session = await prepareControllerSession(configured);
    if (session === undefined) throw new Error("missing Session");
    const value = await freshRuntime();
    await session.restore(value);
    if (value.session === undefined) throw new Error("missing runtime Session");
    value.session.sessionId = sessionId;
    transport.save.mockImplementationOnce(({ prepared }) => {
      prepared.options.onUploadReceipt?.({
        kind: "checkpoint",
        id: 1001,
        name: "checkpoint",
        sha256: "c".repeat(64),
      });
      return Promise.reject(new PolicyDeniedError("confirmed checkpoint metadata unavailable"));
    });
    await expect(session.save(value)).rejects.toThrow("confirmed checkpoint metadata unavailable");
    expect(configured.state.session).toMatchObject({
      status: "failed",
      claimArtifactId: 99,
      artifactId: 1001,
      archiveSha256: "c".repeat(64),
      payloadSha256: "b".repeat(64),
    });
  });
  it("does nothing for an old workflow without opt-in", async () => {
    const configured = options({ sessionMode: "off", sessionKey: "" });
    expect(await prepareControllerSession({ ...configured, environment: {} })).toBeUndefined();
    expect(transport.prepare).not.toHaveBeenCalled();
  });
  it("requires current trust before any claim", async () => {
    const configured = options();
    await expect(
      prepareControllerSession({
        ...configured,
        authorized: {
          ...configured.authorized,
          policy: { ...configured.authorized.policy, trust: "untrusted" },
        },
      }),
    ).rejects.toThrow("current trusted");
    expect(configured.state.session?.status).toBe("failed");
    expect(transport.prepare).not.toHaveBeenCalled();
  });
  it("saves with server-verified job provenance and freshly rechecked current authority", async () => {
    const configured = options();
    const session = await prepareControllerSession(configured);
    if (session === undefined) throw new Error("missing Session");
    const value = await freshRuntime();
    await session.restore(value);
    expect(value.session?.knownSecrets).toContain("artifact-credential");
    if (value.session === undefined) throw new Error("missing runtime Session");
    value.session.sessionId = sessionId;
    await session.save(value);
    expect(transport.permissions).toHaveBeenCalledTimes(2);
    expect(transport.export.mock.calls[0]?.[0].manifest.workflow).toMatchObject({
      jobName: "Verified static job name",
      sourceSha: "a".repeat(40),
      runId: 10,
      runAttempt: 1,
    });
    expect(transport.export.mock.calls[0]?.[0].manifest).not.toHaveProperty("policy");
    expect(configured.state.session).toMatchObject({
      status: "saved",
      claimArtifactId: 99,
      artifactId: 101,
      sessionId,
      generation: 1,
    });
  });
  it("does not restore old authorization if current actor authority is revoked before saving", async () => {
    const configured = options();
    const session = await prepareControllerSession(configured);
    if (session === undefined) throw new Error("missing Session");
    const value = await freshRuntime();
    await session.restore(value);
    if (value.session === undefined) throw new Error("missing runtime Session");
    value.session.sessionId = sessionId;
    transport.permissions.mockResolvedValueOnce(permissions(false));
    await expect(session.save(value)).rejects.toThrow("no longer permits");
    expect(configured.state.session).toMatchObject({ status: "failed", claimArtifactId: 99 });
  });
  it("passes only a verified checkpoint into fresh dedicated runtime storage", async () => {
    const configured = options({ sessionMode: "resume", sessionSourceRunId: "9" });
    const checkpoint = checkpointFixture({
      schemaVersion: 1,
      repository: { id: 1, owner: "octo", repo: "repo" },
      workflow: {
        path: ".github/workflows/session.yml",
        jobId: "session",
        jobName: "session",
        sourceSha: "a".repeat(40),
        runId: 9,
        runAttempt: 1,
      },
      task: { kind: "pull_request", identity: "task:42" },
      runtime: {
        dshVersion: "0.2.0-rc.2",
        mode: "controlled",
        compositionId: "controlled",
        containerImage: configured.inputs.containerImage,
        extensionDigest: configured.extensions.configurationDigest,
      },
      issuer: { actorId: 3, actorLogin: "alice", jobRunId: 100 },
      session: { keyHash: "c".repeat(64), sessionId, generation: 1 },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
    });
    transport.prepare.mockImplementationOnce((original) =>
      Promise.resolve({
        binding: original.binding,
        current: sourceIdentity(10),
        source: sourceIdentity(9),
        checkpoint,
        generation: 2,
        selection: "resumed",
        claimArtifactId: 99,
        options: original,
      }),
    );
    transport.restore.mockResolvedValueOnce({
      sessionId,
      eventCount: 40,
      bytes: 1,
      sha256: "b".repeat(64),
    });
    const session = await prepareControllerSession(configured);
    if (session === undefined) throw new Error("missing Session");
    const value = await freshRuntime();
    await session.restore(value);
    expect(transport.restore.mock.calls[0]?.[0]).toMatchObject({
      checkpoint,
      source: { runId: 9 },
      workspacePath: "/workspace",
    });
    expect(value.session).toMatchObject({ sessionId, checkpointEventCount: 40 });
    expect(configured.state.session).toMatchObject({
      status: "restored",
      sourceRunId: 9,
      generation: 2,
    });
  });
});
