import { DefaultArtifactClient } from "@actions/artifact";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthorityRevalidator } from "../src/orchestration/authority.js";
import { createDshRuntime, disposeDshRuntime, type DshRuntime } from "../src/dsh/runtime.js";
import { ControlledComposition } from "../src/dsh/controlled-composition.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import type { ControlledActionInputs } from "../src/inputs.js";
import { evaluatePolicy } from "../src/security/policy.js";
import {
  createControllerSession,
  type ControllerSessionOptions,
} from "../src/session/controller.js";
import { SESSION_LOG_FILE } from "../src/session/checkpoint.js";
import {
  parseSessionManifest,
  sessionArtifactName,
  sessionKeyHash,
  type SessionBinding,
  type SessionManifest,
} from "../src/session/contracts.js";
import { inputs, permissions, pullRequestContext } from "./helpers.js";
import { githubClientFixture } from "./helpers/github-client.js";

const sessionId = "session-12345678-1234-1234-123456789abc";
const sourceSha = "a".repeat(40);
const githubTreeSha = "c".repeat(40);
const workflowsTreeSha = "d".repeat(40);
const workflowBlobSha = "e".repeat(40);
const jobName = "Verified static job name";
const environment = {
  GITHUB_WORKFLOW_REF: "octo/repo/.github/workflows/session.yml@refs/heads/main",
  GITHUB_WORKFLOW_SHA: sourceSha,
  GITHUB_JOB: "session",
  GITHUB_RUN_ATTEMPT: "1",
  ACTIONS_RUNTIME_TOKEN: "artifact-credential",
};
const runtimes: DshRuntime[] = [];
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string;
  expires_at: string;
  digest: string;
  workflow_run: { id: number; repository_id: number; head_repository_id: number; head_sha: string };
}

function settledPayload(now: number): Buffer {
  return Buffer.from(
    [
      sessionFormatCatalog.encodeCurrentHeader(
        {
          version: 4,
          id: sessionId,
          createdAt: now,
          cwd: "/workspace",
          isSeeded: false,
          delegationDepth: 0,
        },
        0,
      ),
      { type: "turn/start", seq: 0, time: now, data: { turn: 1 } },
      {
        type: "user/message",
        seq: 1,
        time: now + 1,
        data: {
          id: "message-1",
          role: "user",
          content: [{ type: "text", text: "Remember this verified text" }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      },
      { type: "turn/end", seq: 2, time: now + 2, data: { turn: 1, reason: { kind: "completed" } } },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
}

/** Only GitHub REST, artifact SDK upload and signed-blob download are replaced. */
function fixture(overrides: Partial<ControlledActionInputs> = {}) {
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
  const extensions = resolveExtensionPlan({
    allowedTools: [],
    mcp: configured.mcpConfig,
    plugins: configured.pluginConfig,
    allowPluginInstall: false,
    policy,
  });
  const now = Date.now();
  const payload = settledPayload(now - 60_000);
  const state: {
    permission: string;
    metadataFailureFor: "claim" | "checkpoint" | undefined;
    nextId: number;
  } = { permission: "write", metadataFailureFor: undefined, nextId: 99 };
  const artifacts: Artifact[] = [];
  const archives = new Map<number, Uint8Array>();
  const uploadedFiles = new Map<number, Readonly<Record<string, Buffer>>>();
  const logicalKey =
    configured.sessionMode === "auto" ? configured.sessionKey.toLowerCase() : configured.sessionKey;
  const binding: SessionBinding = {
    repository: { id: 1, owner: "octo", repo: "repo" },
    workflow: { path: ".github/workflows/session.yml", jobId: "session", jobName },
    task: { kind: "pull_request", identity: "task:7" },
    runtime: {
      dshVersion: "0.2.1-rc.2",
      mode: "controlled",
      compositionId: new ControlledComposition().id,
      containerImage: configured.containerImage,
      extensionDigest: extensions.configurationDigest,
    },
    keyHash: sessionKeyHash(logicalKey),
  };
  const expression = (name: string): string => "$" + "{{ inputs." + name + " }}";
  const workflow = [
    "on:",
    "  workflow_dispatch:",
    "    inputs:",
    "      session_key:",
    "        type: string",
    "        required: true",
    "run-name: dsh-session-" + expression("session_key"),
    "concurrency:",
    "  group: dsh-session" +
      (configured.sessionMode === "auto" ? "-" + expression("session_key") : ""),
    "  cancel-in-progress: false",
    "  queue: max",
    "jobs:",
    "  session:",
    "    name: " + jobName,
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: ./candidate-action",
    "        with:",
    "          session-mode: " + (configured.sessionMode === "auto" ? "auto" : expression("mode")),
    "          session-key: " + expression("session_key"),
  ].join("\n");
  const timestamp = (runId: number): string =>
    new Date(now - (runId === 10 ? 0 : 60_000)).toISOString();
  const run = (runId: number) => ({
    id: runId,
    repository: { id: 1 },
    head_repository: { id: 1 },
    head_branch: "main",
    head_sha: sourceSha,
    path: binding.workflow.path,
    display_title: "dsh-session-" + logicalKey,
    event: "workflow_dispatch",
    run_attempt: 1,
    status: runId === 10 ? "in_progress" : "completed",
    conclusion: runId === 10 ? null : "success",
    actor: { id: 3, login: "alice" },
    triggering_actor: { id: 3, login: "alice" },
    created_at: timestamp(runId),
    updated_at: timestamp(runId),
  });
  const permissionRead = vi.fn(() => Promise.resolve({ data: { permission: state.permission } }));
  const getArtifact = vi.fn(({ artifact_id }: { artifact_id: number }) => {
    const artifact = artifacts.find(({ id }) => id === artifact_id);
    if (artifact === undefined) throw new Error("Missing artifact transport fixture");
    const kind = artifact.name.endsWith("-claim") ? "claim" : "checkpoint";
    if (state.metadataFailureFor === kind) {
      throw Object.assign(new Error("confirmed " + kind + " metadata unavailable"), {
        status: 503,
      });
    }
    return Promise.resolve({ data: artifact });
  });
  const client = githubClientFixture({
    rest: {
      users: { getByUsername: () => Promise.resolve({ data: { type: "User" } }) },
      repos: {
        get: () =>
          Promise.resolve({ data: { id: 1, full_name: "octo/repo", default_branch: "main" } }),
        getCollaboratorPermissionLevel: permissionRead,
      },
      git: {
        getTree: ({ tree_sha }: { tree_sha: string }) => {
          const entry =
            tree_sha === sourceSha
              ? { path: ".github", type: "tree", mode: "040000", sha: githubTreeSha }
              : tree_sha === githubTreeSha
                ? { path: "workflows", type: "tree", mode: "040000", sha: workflowsTreeSha }
                : tree_sha === workflowsTreeSha
                  ? {
                      path: "session.yml",
                      type: "blob",
                      mode: "100644",
                      sha: workflowBlobSha,
                      size: Buffer.byteLength(workflow),
                    }
                  : undefined;
          if (entry === undefined) throw new Error("Unexpected workflow tree request");
          return Promise.resolve({ data: { sha: tree_sha, truncated: false, tree: [entry] } });
        },
        getBlob: () =>
          Promise.resolve({
            data: {
              sha: workflowBlobSha,
              encoding: "base64",
              size: Buffer.byteLength(workflow),
              content: Buffer.from(workflow).toString("base64"),
            },
          }),
      },
      actions: {
        getWorkflowRun: ({ run_id }: { run_id: number }) => Promise.resolve({ data: run(run_id) }),
        listJobsForWorkflowRunAttempt: ({ run_id }: { run_id: number }) =>
          Promise.resolve({
            data: {
              total_count: 1,
              jobs: [
                {
                  id: run_id * 10,
                  name: jobName,
                  run_id,
                  head_sha: sourceSha,
                  started_at: timestamp(run_id),
                  completed_at: run_id === 10 ? null : timestamp(run_id),
                  status: run_id === 10 ? "in_progress" : "completed",
                  conclusion: run_id === 10 ? null : "success",
                },
              ],
            },
          }),
        listWorkflowRuns: () => {
          const runs = [
            run(10),
            ...(artifacts.some((item) => item.workflow_run.id === 9) ? [run(9)] : []),
          ];
          return Promise.resolve({ data: { total_count: runs.length, workflow_runs: runs } });
        },
        listWorkflowRunArtifacts: ({ run_id }: { run_id: number }) => {
          const found = artifacts.filter((item) => item.workflow_run.id === run_id);
          return Promise.resolve({ data: { total_count: found.length, artifacts: found } });
        },
        listArtifactsForRepo: () =>
          Promise.resolve({ data: { total_count: artifacts.length, artifacts: [...artifacts] } }),
        getArtifact,
        downloadArtifact: ({ artifact_id }: { artifact_id: number }) =>
          Promise.resolve({
            status: 302,
            headers: { location: "https://result.blob.core.windows.net/" + String(artifact_id) },
          }),
      },
    },
  });
  const addArtifact = (id: number, name: string, bytes: Uint8Array, runId: number) => {
    const created = new Date(runId === 10 ? Date.now() : now - 60_000);
    artifacts.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + 3 * 86400_000).toISOString(),
      digest: "sha256:" + hash(bytes),
      workflow_run: { id: runId, repository_id: 1, head_repository_id: 1, head_sha: sourceSha },
    });
    archives.set(id, bytes);
  };
  const uploaded = vi
    .spyOn(DefaultArtifactClient.prototype, "uploadArtifact")
    .mockImplementation(async (name, paths) => {
      const files = Object.fromEntries(
        await Promise.all(
          paths.map(async (path) => [basename(path), await readFile(path)] as const),
        ),
      );
      const bytes = zipSync(files, { level: 0 });
      const id = state.nextId++;
      addArtifact(id, name, bytes, 10);
      uploadedFiles.set(id, files);
      return { id, size: bytes.length, digest: hash(bytes) };
    });
  const downloaded = vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const bytes = archives.get(Number(url.pathname.slice(1)));
    if (bytes === undefined) throw new Error("Unexpected signed-blob transport request");
    return Promise.resolve(new Response(Buffer.from(bytes)));
  });
  vi.stubGlobal("fetch", downloaded);
  const authority = {
    trust: policy.trust,
    allowed: policy.allowed,
    revalidate: createAuthorityRevalidator({
      client,
      context,
      command: {
        operation: "task",
        source: "explicit-input",
        requestedAccess: "read",
        instructions: "current follow-up",
      },
      inputs: configured,
      policy,
      signal: new AbortController().signal,
    }),
  };
  const options: ControllerSessionOptions = {
    inputs: configured,
    client,
    context,
    operation: "task",
    authority,
    compositionId: binding.runtime.compositionId,
    extensionDigest: extensions.configurationDigest,
    deadlineMs: Date.now() + 10_000,
    signal: new AbortController().signal,
    environment,
  };
  const seedCheckpoint = () => {
    const manifest: SessionManifest = {
      schemaVersion: 1,
      repository: binding.repository,
      workflow: { ...binding.workflow, sourceSha, runId: 9, runAttempt: 1 },
      task: binding.task,
      runtime: binding.runtime,
      issuer: { actorId: 3, actorLogin: "alice", jobRunId: 90 },
      session: { keyHash: binding.keyHash, sessionId, generation: 1 },
      createdAt: timestamp(9),
      expiresAt: new Date(now - 60_000 + 3 * 86400_000).toISOString(),
      payload: { file: "session.jsonl", bytes: payload.length, sha256: hash(payload) },
    };
    addArtifact(
      90,
      sessionArtifactName(binding, 1, 1),
      zipSync(
        {
          "manifest.json": Buffer.from(JSON.stringify(manifest)),
          "session.jsonl": payload,
        },
        { level: 0 },
      ),
      9,
    );
    return manifest;
  };
  return {
    options,
    state,
    payload,
    artifacts,
    archives,
    uploadedFiles,
    uploaded,
    downloaded,
    permissionRead,
    getArtifact,
    seedCheckpoint,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map(disposeDshRuntime));
});

async function freshRuntime() {
  const value = await createDshRuntime();
  runtimes.push(value);
  return value;
}
async function preparedSession(configured: ControllerSessionOptions) {
  const session = createControllerSession(configured);
  if (session === undefined) throw new Error("missing Session");
  await session.prepare();
  return session;
}
async function completeWorker(runtime: DshRuntime, payload: Buffer) {
  if (runtime.session === undefined) throw new Error("missing runtime Session");
  runtime.session.sessionId = sessionId;
  const directory = join(runtime.dshHome, "sessions", "--workspace--", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, SESSION_LOG_FILE), payload);
}

describe("Controller Session with real artifact validation and isolated external transport", () => {
  it("keeps an acknowledged claim in its owner when preparation fails", async () => {
    const f = fixture();
    f.state.nextId = 999;
    f.state.metadataFailureFor = "claim";
    const session = createControllerSession(f.options);
    if (session === undefined) throw new Error("missing Session");
    const preparing = session.snapshot();
    await expect(session.prepare()).rejects.toThrow("confirmed claim metadata unavailable");
    expect(session.snapshot()).toMatchObject({ status: "failed", claimArtifactId: 999 });
    expect(preparing).toEqual({ mode: "save", status: "preparing" });
    expect(f.uploaded).toHaveBeenCalledOnce();
  });

  it("auto normalizes logical keys and reports automatic checkpoint selection", async () => {
    const f = fixture({ sessionMode: "auto", sessionKey: "Logical-Task" });
    f.seedCheckpoint();
    const session = await preparedSession(f.options);
    expect(f.uploaded.mock.calls[0]?.[0]).toContain(sessionKeyHash("logical-task"));
    expect(session.snapshot()).toMatchObject({
      mode: "auto",
      status: "claimed",
      selection: "resumed",
      generation: 2,
      sourceRunId: 9,
    });
    expect(f.downloaded).toHaveBeenCalledOnce();
  });

  it("retains checkpoint receipt and raw checksum after an acknowledged upload fails verification", async () => {
    const f = fixture();
    const session = await preparedSession(f.options);
    const runtime = await freshRuntime();
    await session.restore(runtime);
    await completeWorker(runtime, f.payload);
    f.state.nextId = 1001;
    f.state.metadataFailureFor = "checkpoint";
    await expect(session.save(runtime)).rejects.toThrow(
      "confirmed checkpoint metadata unavailable",
    );
    const archive = f.archives.get(1001);
    if (archive === undefined) throw new Error("missing acknowledged archive");
    expect(session.snapshot()).toMatchObject({
      status: "failed",
      claimArtifactId: 99,
      artifactId: 1001,
      archiveSha256: hash(archive),
      payloadSha256: hash(f.payload),
    });
    expect(f.uploaded).toHaveBeenCalledTimes(2);
  });

  it("does nothing for an old workflow without opt-in", () => {
    const f = fixture();
    expect(
      createControllerSession({
        ...f.options,
        inputs: { ...f.options.inputs, sessionMode: "off", sessionKey: "" },
        environment: {},
      }),
    ).toBeUndefined();
    expect(f.uploaded).not.toHaveBeenCalled();
    expect(f.permissionRead).not.toHaveBeenCalled();
  });

  it("requires current trust before any claim", async () => {
    const f = fixture();
    const session = createControllerSession({
      ...f.options,
      authority: { ...f.options.authority, trust: "untrusted" },
    });
    if (session === undefined) throw new Error("missing Session");
    await expect(session.prepare()).rejects.toThrow("current trusted");
    expect(session.snapshot().status).toBe("failed");
    expect(f.uploaded).not.toHaveBeenCalled();
  });

  it("saves with server-verified job provenance and freshly rechecked current authority", async () => {
    const f = fixture();
    const session = await preparedSession(f.options);
    const runtime = await freshRuntime();
    await session.restore(runtime);
    expect(runtime.session?.knownSecrets).toContain("artifact-credential");
    await completeWorker(runtime, f.payload);
    await session.save(runtime);
    session.finish("failed");
    const manifestBytes = f.uploadedFiles.get(100)?.["manifest.json"];
    if (manifestBytes === undefined) throw new Error("missing uploaded manifest");
    const manifest = parseSessionManifest(JSON.parse(manifestBytes.toString("utf8")));
    expect(manifest.workflow).toMatchObject({ jobName, sourceSha, runId: 10, runAttempt: 1 });
    expect(manifest).not.toHaveProperty("policy");
    expect(f.uploadedFiles.get(100)?.["session.jsonl"]).toEqual(f.payload);
    expect(f.permissionRead).toHaveBeenCalledTimes(2);
    expect(f.uploaded).toHaveBeenCalledTimes(2);
    expect(session.snapshot()).toMatchObject({
      status: "saved",
      claimArtifactId: 99,
      artifactId: 100,
      sessionId,
      generation: 1,
    });
  });

  it("does not restore old authorization if current actor authority is revoked before saving", async () => {
    const f = fixture();
    const session = await preparedSession(f.options);
    const runtime = await freshRuntime();
    await session.restore(runtime);
    await completeWorker(runtime, f.payload);
    f.state.permission = "read";
    await expect(session.save(runtime)).rejects.toThrow("no longer permits");
    expect(session.snapshot()).toMatchObject({ status: "failed", claimArtifactId: 99 });
    expect(f.uploaded).toHaveBeenCalledOnce();
    expect(f.artifacts).toHaveLength(1);
  });

  it("restores verified checkpoint bytes into fresh dedicated runtime storage", async () => {
    const f = fixture({ sessionMode: "resume", sessionSourceRunId: "9" });
    f.seedCheckpoint();
    const session = await preparedSession(f.options);
    const runtime = await freshRuntime();
    await session.restore(runtime);
    expect(
      await readFile(
        join(runtime.dshHome, "sessions", "--workspace--", sessionId, SESSION_LOG_FILE),
      ),
    ).toEqual(f.payload);
    expect(runtime.session).toMatchObject({ sessionId, checkpointEventCount: 3 });
    expect(session.snapshot()).toMatchObject({ status: "restored", sourceRunId: 9, generation: 2 });
    expect(f.downloaded).toHaveBeenCalledOnce();
    expect(f.uploaded).toHaveBeenCalledOnce();
  });
});
