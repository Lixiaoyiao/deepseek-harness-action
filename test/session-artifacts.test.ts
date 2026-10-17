import { githubClientFixture } from "./helpers/github-client.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { zipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import * as core from "@actions/core";
import { DefaultArtifactClient } from "@actions/artifact";

import { PolicyDeniedError } from "../src/errors.js";
import { GitHubQuotaError } from "../src/github/request-policy.js";
import {
  decodeSessionArchive,
  prepareSessionArtifacts,
  saveSessionArtifact,
  type PrepareSessionArtifactsOptions,
  type SessionArtifactUploader,
  type SessionUploadReceipt,
} from "../src/session/artifact-store.js";
import {
  MAX_SESSION_ARCHIVE_BYTES,
  MAX_SESSION_PAYLOAD_BYTES,
  parseSessionManifest,
  sessionArtifactName,
  sessionClaimName,
  sessionKeyHash,
  validateSessionManifestBinding,
  type SessionBinding,
  type SessionCheckpoint,
  type SessionManifest,
} from "../src/session/contracts.js";
import {
  assertSessionWorkflowPolicy,
  verifySessionWorkflowRun,
} from "../src/session/workflow-policy.js";
import { createControllerSession } from "../src/session/controller.js";
import { inputs } from "./helpers.js";

vi.mock("@actions/core", async (original) => ({
  ...(await original<typeof core>()),
  warning: vi.fn(),
}));

const sha = "a".repeat(40);
const githubTreeSha = "c".repeat(40);
const workflowsTreeSha = "d".repeat(40);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const workflow = `concurrency:\n  group: dsh-session\n  cancel-in-progress: false\njobs:\n  session:\n    name: Session worker\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ./candidate-action\n        with:\n          session-mode: \${{ inputs.mode }}\n`;
const automaticWorkflow =
  workflow
    .replace("group: dsh-session", "group: dsh-session-${{ inputs.session_key }}")
    .replace(
      "session-mode: ${{ inputs.mode }}",
      "session-mode: auto\n          session-key: ${{ inputs.session_key }}",
    ) +
  "on:\n  workflow_dispatch:\n    inputs:\n      session_key:\n        type: string\n        required: true\nrun-name: dsh-session-${{ inputs.session_key }}\n";
const sessionTitle = "dsh-session-maintainer-key";
const binding: SessionBinding = {
  repository: { id: 10, owner: "octo", repo: "repo" },
  workflow: { path: ".github/workflows/session.yml", jobId: "session", jobName: "Session worker" },
  task: { kind: "issue", identity: "task:7" },
  runtime: {
    dshVersion: "0.2.1-rc.2",
    mode: "controlled",
    compositionId: "github-action-controlled",
    containerImage: `node@sha256:${"a".repeat(64)}`,
    extensionDigest: "b".repeat(64),
  },
  keyHash: sessionKeyHash("maintainer-key"),
};
const identity = (runId: number) => ({
  runId,
  runAttempt: 1,
  sourceSha: sha,
  actorId: 50,
  actorLogin: "maintainer",
  jobRunId: runId * 10,
});

function checkpoint(runId = 100, generation = 1): SessionCheckpoint {
  const payload = Buffer.from('{"opaque":"complete raw payload"}\n');
  const now = Date.now();
  const source = identity(runId);
  const manifest: SessionManifest = {
    schemaVersion: 1,
    repository: binding.repository,
    workflow: { ...binding.workflow, sourceSha: sha, runId, runAttempt: 1 },
    task: binding.task,
    runtime: binding.runtime,
    issuer: { actorId: source.actorId, actorLogin: source.actorLogin, jobRunId: source.jobRunId },
    session: { keyHash: binding.keyHash, sessionId: "session-1", generation },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3 * 86400_000).toISOString(),
    payload: { file: "session.jsonl", bytes: payload.length, sha256: hash(payload) },
  };
  return { manifest, payload };
}

function archive(value = checkpoint()): Uint8Array {
  return zipSync(
    {
      "manifest.json": Buffer.from(JSON.stringify(value.manifest)),
      "session.jsonl": value.payload,
    },
    { level: 0 },
  );
}

function fixture() {
  interface Metadata {
    id: number;
    name: string;
    size_in_bytes: number;
    expired: boolean;
    created_at: string;
    expires_at: string;
    digest: string;
    workflow_run: {
      id: number;
      repository_id: number;
      head_repository_id: number;
      head_sha: string;
    };
  }
  const saved = checkpoint();
  const zip = archive(saved);
  const metadata = (runId: number, generation = 1): Metadata => ({
    id: runId,
    name: sessionArtifactName(binding, 1, generation),
    size_in_bytes: zip.length,
    expired: false,
    created_at: saved.manifest.createdAt,
    expires_at: saved.manifest.expiresAt,
    digest: `sha256:${hash(zip)}`,
    workflow_run: { id: runId, repository_id: 10, head_repository_id: 10, head_sha: sha },
  });
  const state = {
    yaml: workflow,
    repoId: 10,
    event: "workflow_dispatch",
    branch: "main",
    runAttempt: 1,
    sourceStatus: "completed",
    sourceConclusion: "success",
    jobConclusion: "success",
    treeMode: "100644",
    treeEntries: 1,
    currentActor: "maintainer",
    sourceActor: "maintainer",
    current: [] as Metadata[],
    sources: [] as Metadata[],
    history: [] as {
      id: number;
      display_title: string;
      status: string;
      conclusion: string | null;
      updated_at?: string;
    }[],
    title: sessionTitle,
  };
  const api = {
    repos: {
      get: vi.fn(() => ({
        data: { id: state.repoId, full_name: "octo/repo", default_branch: "main" },
      })),
    },
    git: {
      getTree: vi.fn(({ tree_sha }: { tree_sha: string }) => {
        const entry =
          tree_sha === sha
            ? { path: ".github", type: "tree", mode: "040000", sha: githubTreeSha }
            : tree_sha === githubTreeSha
              ? { path: "workflows", type: "tree", mode: "040000", sha: workflowsTreeSha }
              : tree_sha === workflowsTreeSha
                ? {
                    path: "session.yml",
                    type: "blob",
                    mode: state.treeMode,
                    sha: "b".repeat(40),
                    size: Buffer.byteLength(state.yaml),
                  }
                : undefined;
        if (entry === undefined) throw new Error("Unexpected workflow tree fixture request");
        return {
          data: {
            sha: tree_sha === sha ? "e".repeat(40) : tree_sha,
            truncated: false,
            tree: [
              entry,
              ...Array.from(
                { length: tree_sha === sha ? state.treeEntries - 1 : 0 },
                (_, index) => ({
                  path: `unrelated-${String(index)}`,
                  type: "blob",
                  mode: "100644",
                  sha: "f".repeat(40),
                  size: 1,
                }),
              ),
            ],
          },
        };
      }),
      getBlob: vi.fn(() => ({
        data: {
          sha: "b".repeat(40),
          encoding: "base64",
          size: Buffer.byteLength(state.yaml),
          content: Buffer.from(state.yaml).toString("base64"),
        },
      })),
    },
    actions: {
      getWorkflowRun: vi.fn(({ run_id }: { run_id: number }) => ({
        data: {
          id: run_id,
          repository: { id: state.repoId },
          head_repository: { id: state.repoId },
          head_branch: state.branch,
          head_sha: sha,
          path: binding.workflow.path,
          display_title: state.title,
          event: state.event,
          run_attempt: state.runAttempt,
          status: run_id === 200 ? "in_progress" : state.sourceStatus,
          conclusion: run_id === 200 ? null : state.sourceConclusion,
          actor: { id: 50, login: "maintainer" },
          triggering_actor: {
            id: 50,
            login: run_id === 200 ? state.currentActor : state.sourceActor,
          },
          created_at: saved.manifest.createdAt,
          updated_at: saved.manifest.createdAt,
        },
      })),
      listWorkflowRuns: vi.fn(({ page = 1 }: { page?: number } = {}) => ({
        data: {
          total_count: state.history.length + 1,
          workflow_runs: [
            {
              id: 200,
              display_title: state.title,
              status: "in_progress",
              conclusion: null,
              path: binding.workflow.path,
              updated_at: saved.manifest.createdAt,
            },
            ...state.history.map((run) => ({
              path: binding.workflow.path,
              updated_at: saved.manifest.createdAt,
              ...run,
            })),
          ].slice((page - 1) * 100, page * 100),
        },
      })),
      listJobsForWorkflowRunAttempt: vi.fn(({ run_id }: { run_id: number }) => ({
        data: {
          total_count: 1,
          jobs: [
            {
              id: run_id * 10,
              name: "Session worker",
              run_id,
              head_sha: sha,
              started_at: saved.manifest.createdAt,
              completed_at: run_id === 200 ? null : saved.manifest.createdAt,
              status: run_id === 200 ? "in_progress" : "completed",
              conclusion: run_id === 200 ? null : state.jobConclusion,
            },
          ],
        },
      })),
      listWorkflowRunArtifacts: vi.fn(({ run_id }: { run_id: number }) => ({
        data: {
          total_count: (run_id === 200
            ? state.current
            : state.sources.filter((item) => item.workflow_run.id === run_id)
          ).length,
          artifacts:
            run_id === 200
              ? state.current
              : state.sources.filter((item) => item.workflow_run.id === run_id),
        },
      })),
      listArtifactsForRepo: vi.fn(({ page = 1 }: { page?: number } = {}) => ({
        data: {
          total_count: state.sources.length + state.current.length,
          artifacts: [...state.sources, ...state.current].slice((page - 1) * 100, page * 100),
        },
      })),
      downloadArtifact: vi.fn(({ artifact_id }: { artifact_id: number }) => ({
        status: 302,
        headers: {
          location: `https://result.blob.core.windows.net/${String(artifact_id)}?opaque=signed`,
        },
      })),
      getArtifact: vi.fn(({ artifact_id }: { artifact_id: number }) => {
        const item = state.current.find(({ id }) => id === artifact_id);
        if (item === undefined) throw new Error("Missing uploaded artifact fixture");
        return { data: item };
      }),
    },
  };
  const uploader = {
    uploadArtifact: vi.fn<SessionArtifactUploader["uploadArtifact"]>(
      async (
        name: string,
        files: string[],
        _root: string,
        options: { retentionDays: number; compressionLevel: number },
      ) => {
        const contents = await Promise.all(
          files.map(async (file) => ({ file: basename(file), bytes: await readFile(file) })),
        );
        expect(options).toEqual({ retentionDays: 3, compressionLevel: 0 });
        expect(contents.every(({ bytes }) => !bytes.includes("controller-secret"))).toBe(true);
        const bytes = zipSync(
          Object.fromEntries(contents.map(({ file, bytes }) => [file, bytes])),
          { level: 0 },
        );
        const item = {
          ...metadata(200),
          id: 900 + state.current.length,
          name,
          size_in_bytes: bytes.length,
          digest: `sha256:${hash(bytes)}`,
        };
        state.current.push(item);
        return { id: item.id, size: bytes.length, digest: hash(bytes) };
      },
    ),
  };
  const fetchArchive = vi.fn<typeof fetch>(() => Promise.resolve(new Response(Buffer.from(zip))));
  const authorizeCurrent = vi.fn(() => Promise.resolve());
  const receipts: SessionUploadReceipt[] = [];
  const onUploadReceipt = vi.fn((receipt: SessionUploadReceipt) => {
    receipts.push(receipt);
  });
  const options: PrepareSessionArtifactsOptions = {
    client: githubClientFixture({ rest: api }),
    binding: { ...binding, workflow: { ...binding.workflow, jobName: "session" } },
    mode: "save",
    currentRun: { runId: 200, runAttempt: 1, workflowSha: sha, actorLogin: "maintainer" },
    retentionDays: 3,
    deadlineMs: Date.now() + 60_000,
    signal: new AbortController().signal,
    uploader,
    fetchArchive,
    authorizeCurrent,
    onUploadReceipt,
  };
  return {
    options,
    api,
    state,
    uploader,
    fetchArchive,
    authorizeCurrent,
    onUploadReceipt,
    receipts,
    saved,
    metadata,
    zip,
  };
}

describe("Session trusted workflow policy", () => {
  it.each(["../docs/session.md", "../docs/zh-CN/session.md"])(
    "documents compatible queued Session workflow semantics in %s",
    async (path) => {
      const contents = await readFile(new URL(path, import.meta.url), "utf8");
      const snippet = /```yaml\r?\n([\s\S]*?)```/u.exec(contents)?.[1];
      if (snippet === undefined) throw new Error("Missing documented Session YAML");
      const document = parseDocument(snippet);
      expect(document.errors).toEqual([]);
      expect(document.getIn(["concurrency", "queue"])).toBe("max");
      expect(document.getIn(["concurrency", "cancel-in-progress"])).toBe(false);
      expect(document.getIn(["concurrency", "group"])).toBe(
        "dsh-session-${{ inputs.session_key }}",
      );
      expect(document.get("run-name")).toBe("dsh-session-${{ inputs.session_key }}");
      expect(document.getIn(["on", "workflow_dispatch", "inputs", "session_key", "required"])).toBe(
        true,
      );
      expect(document.getIn(["on", "workflow_dispatch", "inputs", "session_key", "type"])).toBe(
        "string",
      );
    },
  );
  it.each([undefined, "single"])(
    "warns once about queue: max for a current workflow using %s pending slots",
    async (queue) => {
      const f = fixture();
      if (queue !== undefined)
        f.state.yaml = workflow.replace(
          "cancel-in-progress: false",
          `cancel-in-progress: false\n  queue: ${queue}`,
        );
      const onWorkflowWarning = vi.fn();
      const prepared = await prepareSessionArtifacts({ ...f.options, onWorkflowWarning });
      expect(onWorkflowWarning).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining("queue: max"),
      );
      await saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      });
      expect(onWorkflowWarning).toHaveBeenCalledTimes(1);
    },
  );
  it("reports the current workflow warning once through repeated Controller preparation", async () => {
    const f = fixture();
    const warning = vi.mocked(core.warning).mockClear();
    const upload = vi
      .spyOn(DefaultArtifactClient.prototype, "uploadArtifact")
      .mockImplementation(async (name, files, root) =>
        f.uploader.uploadArtifact(name, files, root, { retentionDays: 3, compressionLevel: 0 }),
      );
    try {
      const session = createControllerSession({
        inputs: inputs({ sessionMode: "save", sessionKey: "maintainer-key" }),
        client: f.options.client,
        context: {
          kind: "automation",
          repository: { ...binding.repository, fullName: "octo/repo" },
          runId: "200",
          actor: "maintainer",
        },
        operation: "task",
        authority: { trust: "trusted-read", allowed: true, revalidate: f.authorizeCurrent },
        compositionId: binding.runtime.compositionId,
        extensionDigest: binding.runtime.extensionDigest,
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
        environment: {
          GITHUB_WORKFLOW_REF: "octo/repo/.github/workflows/session.yml@refs/heads/main",
          GITHUB_WORKFLOW_SHA: sha,
          GITHUB_JOB: "session",
          GITHUB_RUN_ATTEMPT: "1",
        },
      });
      if (session === undefined) throw new Error("Expected enabled Session");
      await Promise.all([session.prepare(), session.prepare()]);
      await session.prepare();
      expect(session.snapshot()).toMatchObject({ status: "claimed", generation: 1 });
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("queue: max"));
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockClear();
      upload.mockRestore();
    }
  });
  it("does not warn for a current workflow with queue: max", async () => {
    const f = fixture();
    f.state.yaml = workflow.replace(
      "cancel-in-progress: false",
      "cancel-in-progress: false\n  queue: max",
    );
    const onWorkflowWarning = vi.fn();
    await expect(
      prepareSessionArtifacts({ ...f.options, onWorkflowWarning }),
    ).resolves.toMatchObject({
      generation: 1,
    });
    expect(onWorkflowWarning).not.toHaveBeenCalled();
  });
  it("resumes an older workflow without queue: max and only warns for the current run", async () => {
    const f = fixture();
    f.state.sources.push(f.metadata(100));
    const onWorkflowWarning = vi.fn();
    const prepared = await prepareSessionArtifacts({
      ...f.options,
      mode: "resume",
      sourceRunId: 100,
      onWorkflowWarning,
    });
    expect(prepared).toMatchObject({ selection: "resumed", generation: 2, source: { runId: 100 } });
    expect(onWorkflowWarning).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("queue: max"),
    );
  });
  it("accepts only the same maintainer key for auto run-name and concurrency", () => {
    expect(assertSessionWorkflowPolicy(automaticWorkflow, "session", binding.keyHash).jobId).toBe(
      "session",
    );
    for (const yaml of [
      automaticWorkflow.replace(
        "run-name: dsh-session-${{ inputs.session_key }}",
        "run-name: unknown",
      ),
      automaticWorkflow.replace(
        "group: dsh-session-${{ inputs.session_key }}",
        "group: dsh-session",
      ),
      automaticWorkflow.replace("required: true", "required: false"),
      automaticWorkflow.replace("type: string", "type: choice"),
      automaticWorkflow.replace(
        "session-key: ${{ inputs.session_key }}",
        "session-key: ${{ github.event.issue.title }}",
      ),
    ])
      expect(() => assertSessionWorkflowPolicy(yaml, "session", binding.keyHash)).toThrow(
        PolicyDeniedError,
      );
  });
  it("accepts a static maintained auto key and rejects a different literal key", () => {
    const yaml = automaticWorkflow.replaceAll("${{ inputs.session_key }}", "maintainer-key");
    expect(assertSessionWorkflowPolicy(yaml, "session", binding.keyHash).jobId).toBe("session");
    expect(() => assertSessionWorkflowPolicy(yaml, "session", sessionKeyHash("different"))).toThrow(
      /literal key/u,
    );
  });
  it("accepts one nonmatrix Action with a runtime input expression and normalizes static name", () => {
    expect(assertSessionWorkflowPolicy(workflow, "session")).toEqual({
      jobId: "session",
      jobName: "Session worker",
      stepIndex: 0,
      singlePendingSlot: true,
    });
  });
  it.each([
    workflow.replace("group: dsh-session", "group: ${{ github.ref }}"),
    workflow.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    workflow.replace("cancel-in-progress: false", 'cancel-in-progress: "false"'),
    workflow.replace(
      "runs-on: ubuntu-latest",
      "runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        version: [1, 2]",
    ),
    workflow.replace("name: Session worker", "name: ${{ matrix.name }}"),
    workflow + "      - uses: ./other\n        with:\n          session-mode: save\n",
    workflow.replace("      - uses: ./candidate-action", "      - run: echo untrusted"),
  ])("rejects unverified workflow concurrency/producer/matrix configuration", (source) => {
    expect(() => assertSessionWorkflowPolicy(source, "session")).toThrow(PolicyDeniedError);
  });
  it.each(["pull_request", "pull_request_target"])(
    "rejects %s workflow provenance",
    async (event) => {
      const f = fixture();
      f.state.event = event;
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/trusted default-branch/u);
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it.each(["repository", "branch", "attempt", "symlink", "sha"])(
    "rejects mismatched %s server provenance",
    async (kind) => {
      const f = fixture();
      if (kind === "repository") f.state.repoId = 99;
      if (kind === "branch") f.state.branch = "untrusted-feature";
      if (kind === "attempt") f.state.runAttempt = 2;
      if (kind === "symlink") f.state.treeMode = "120000";
      const selected =
        kind === "sha"
          ? { ...f.options.currentRun, workflowSha: "c".repeat(40) }
          : f.options.currentRun;
      await expect(prepareSessionArtifacts({ ...f.options, currentRun: selected })).rejects.toThrow(
        PolicyDeniedError,
      );
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it("binds exact attempt jobs and never uses a current default-branch workflow file", async () => {
    const f = fixture();
    const verified = await verifySessionWorkflowRun({
      client: f.options.client,
      repository: binding.repository,
      workflowPath: binding.workflow.path,
      jobId: "session",
      runId: 100,
      runAttempt: 1,
      successful: true,
      signal: f.options.signal,
    });
    expect(verified.jobRunId).toBe(1000);
    expect(f.api.git.getTree.mock.calls[0]?.[0]).toMatchObject({ tree_sha: sha });
    expect(f.api.git.getTree.mock.calls.map(([request]) => request.tree_sha)).toEqual([
      sha,
      githubTreeSha,
      workflowsTreeSha,
    ]);
    for (const [request] of f.api.git.getTree.mock.calls) {
      expect(request).not.toHaveProperty("recursive");
      expect(request).toHaveProperty("request.dshImmutable", true);
      expect(request).toHaveProperty("request.signal", f.options.signal);
    }
    expect(f.api.actions.listJobsForWorkflowRunAttempt.mock.calls[0]?.[0]).toMatchObject({
      attempt_number: 1,
    });
  });
  it.each([5000, 5001])(
    "verifies a workflow in a repository with %s tree entries",
    async (count) => {
      const f = fixture();
      f.state.treeEntries = count;
      await expect(
        verifySessionWorkflowRun({
          client: f.options.client,
          repository: binding.repository,
          workflowPath: binding.workflow.path,
          jobId: "session",
          runId: 100,
          successful: true,
          signal: f.options.signal,
        }),
      ).resolves.toMatchObject({ runId: 100, sourceSha: sha, jobRunId: 1000 });
    },
  );
  it.each([
    [sha, "truncated"],
    [githubTreeSha, "truncated"],
    [workflowsTreeSha, "truncated"],
    [sha, "missing"],
    [githubTreeSha, "missing"],
    [workflowsTreeSha, "missing"],
    [sha, "duplicate"],
    [githubTreeSha, "mismatched-sha"],
    [workflowsTreeSha, "mismatched-sha"],
    [sha, "invalid-sha"],
    [githubTreeSha, "invalid-entry-sha"],
    [sha, "symlink"],
    [githubTreeSha, "symlink"],
    [sha, "submodule"],
    [githubTreeSha, "submodule"],
  ])("rejects an unverifiable workflow path at %s with %s", async (treeSha, defect) => {
    const f = fixture();
    const getTree = f.api.git.getTree.getMockImplementation();
    if (getTree === undefined) throw new Error("Missing GitHub tree fixture");
    f.api.git.getTree.mockImplementation((request) => {
      const response = getTree(request);
      if (request.tree_sha !== treeSha) return response;
      if (defect === "truncated") response.data.truncated = true;
      if (defect === "missing") response.data.tree = [];
      if (defect === "mismatched-sha") response.data.sha = "f".repeat(40);
      if (defect === "invalid-sha") response.data.sha = "unverifiable";
      const entry = response.data.tree[0];
      if (entry !== undefined) {
        if (defect === "duplicate") response.data.tree.push(entry);
        if (defect === "invalid-entry-sha") entry.sha = "unverifiable";
        if (defect === "symlink") Object.assign(entry, { type: "blob", mode: "120000" });
        if (defect === "submodule") Object.assign(entry, { type: "commit", mode: "160000" });
      }
      return response;
    });
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(PolicyDeniedError);
    expect(f.api.git.getBlob).not.toHaveBeenCalled();
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it.each(["sha", "size", "encoding", "decoded-size", "utf8"])(
    "rejects workflow blob %s mismatches before claiming",
    async (defect) => {
      const f = fixture();
      const getBlob = f.api.git.getBlob.getMockImplementation();
      if (getBlob === undefined) throw new Error("Missing GitHub blob fixture");
      f.api.git.getBlob.mockImplementation(() => {
        const response = getBlob();
        if (defect === "sha") response.data.sha = "f".repeat(40);
        if (defect === "size") response.data.size++;
        if (defect === "encoding") response.data.encoding = "utf-8";
        if (defect === "decoded-size")
          response.data.content = Buffer.from("short").toString("base64");
        if (defect === "utf8")
          response.data.content = Buffer.alloc(response.data.size, 0xff).toString("base64");
        return response;
      });
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(PolicyDeniedError);
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it("retains the 256 KiB workflow bound and permits an ordinary executable workflow", async () => {
    const f = fixture();
    f.state.treeMode = "100755";
    f.state.yaml += `#${" ".repeat(256 * 1024 - Buffer.byteLength(f.state.yaml) - 1)}`;
    await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({ generation: 1 });
    const oversized = fixture();
    oversized.state.yaml = f.state.yaml + " ";
    await expect(prepareSessionArtifacts(oversized.options)).rejects.toThrow(
      /bounded regular file/u,
    );
    expect(oversized.api.git.getBlob).not.toHaveBeenCalled();
    expect(oversized.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it.each(["cancel", "deadline"])("stops workflow path reads after %s", async (reason) => {
    const f = fixture();
    const controller = new AbortController();
    const getTree = f.api.git.getTree.getMockImplementation();
    if (getTree === undefined) throw new Error("Missing GitHub tree fixture");
    f.api.git.getTree.mockImplementation((request) => {
      controller.abort(new Error("cancelled workflow read"));
      return getTree(request);
    });
    await expect(
      prepareSessionArtifacts({
        ...f.options,
        signal: controller.signal,
        ...(reason === "deadline" ? { deadlineMs: Date.now() - 1 } : {}),
      }),
    ).rejects.toThrow(reason === "deadline" ? /budget is exhausted/u : /cancelled workflow read/u);
    expect(f.api.git.getTree).toHaveBeenCalledTimes(reason === "deadline" ? 0 : 1);
    expect(f.api.git.getBlob).not.toHaveBeenCalled();
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("rejects a different rerun initiator before claim and immutable workflow reads", async () => {
    const f = fixture();
    f.state.currentActor = "different-maintainer";
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/initiator differs/u);
    expect(f.api.git.getTree).not.toHaveBeenCalled();
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("compares the current initiator login case-insensitively", async () => {
    const f = fixture();
    f.state.currentActor = "Maintainer";
    await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({ generation: 1 });
  });
  it("source initiator identity is provenance and may differ from the current actor", async () => {
    const f = fixture();
    f.state.sourceActor = "previous-maintainer";
    await expect(
      verifySessionWorkflowRun({
        client: f.options.client,
        repository: binding.repository,
        workflowPath: binding.workflow.path,
        jobId: "session",
        runId: 100,
        successful: true,
        signal: f.options.signal,
      }),
    ).resolves.toMatchObject({ actorLogin: "previous-maintainer" });
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
});

describe("Session manifest and restricted ZIP", () => {
  it("preserves exact complete payload bytes and checks source bindings independent of object order", () => {
    const saved = checkpoint();
    expect(Buffer.from(decodeSessionArchive(archive(saved)).payload)).toEqual(saved.payload);
    validateSessionManifestBinding(
      saved.manifest,
      { ...binding, repository: { owner: "octo", repo: "repo", id: 10 } },
      identity(100),
    );
  });
  it.each([0, 8])("rejects a %s-day retention window without echoing payload", (days) => {
    const saved = checkpoint();
    expect(() =>
      parseSessionManifest({
        ...saved.manifest,
        expiresAt: new Date(Date.parse(saved.manifest.createdAt) + days * 86400_000).toISOString(),
      }),
    ).toThrow(/retention/u);
  });
  it("round trips deflate and stops decompression at the declared byte bound", () => {
    const saved = checkpoint();
    const zip = Buffer.from(
      zipSync(
        {
          "manifest.json": Buffer.from(JSON.stringify(saved.manifest)),
          "session.jsonl": saved.payload,
        },
        { level: 6 },
      ),
    );
    expect(Buffer.from(decodeSessionArchive(zip).payload)).toEqual(saved.payload);
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(100, central + 24);
    zip.writeUInt32LE(100, 22);
    expect(() => decodeSessionArchive(zip)).toThrow(/exceeded its declared byte bound/u);
  });
  it.each(["task", "mode", "extension", "issuer", "attempt"])(
    "rejects changed %s binding",
    (field) => {
      const saved = checkpoint();
      if (field === "task") saved.manifest.task = { ...saved.manifest.task, identity: "task:8" };
      if (field === "mode") saved.manifest.runtime = { ...saved.manifest.runtime, mode: "native" };
      if (field === "extension")
        saved.manifest.runtime = { ...saved.manifest.runtime, extensionDigest: "c".repeat(64) };
      if (field === "issuer") saved.manifest.issuer = { ...saved.manifest.issuer, actorId: 99 };
      if (field === "attempt")
        saved.manifest.workflow = { ...saved.manifest.workflow, runAttempt: 2 };
      expect(() => validateSessionManifestBinding(saved.manifest, binding, identity(100))).toThrow(
        /binding/u,
      );
    },
  );
  it.each(["third-entry", "traversal", "symlink", "bomb", "crc", "hash", "archive-size"])(
    "rejects %s ZIP before extracting to a runner path",
    (kind) => {
      const saved = checkpoint();
      let zip = Buffer.from(archive(saved));
      if (kind === "third-entry")
        zip = Buffer.from(
          zipSync({
            "manifest.json": Buffer.from(JSON.stringify(saved.manifest)),
            "session.jsonl": saved.payload,
            "extra.txt": Buffer.from("x"),
          }),
        );
      if (kind === "traversal")
        zip = Buffer.from(
          zipSync({
            "manifest.json": Buffer.from(JSON.stringify(saved.manifest)),
            "../session.jsonl": saved.payload,
          }),
        );
      const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      if (kind === "symlink") zip.writeUInt32LE(0xa1ff0000, central + 38);
      if (kind === "bomb") zip.writeUInt32LE(MAX_SESSION_PAYLOAD_BYTES + 1, central + 24);
      if (kind === "crc") zip[50] = (zip[50] ?? 0) ^ 1;
      if (kind === "hash") {
        saved.manifest.payload.sha256 = "f".repeat(64);
        zip = Buffer.from(archive(saved));
      }
      if (kind === "archive-size") zip = Buffer.alloc(MAX_SESSION_ARCHIVE_BYTES + 1);
      expect(() => decodeSessionArchive(zip)).toThrow(PolicyDeniedError);
    },
  );
});

describe("Controller Session artifact admission and advance", () => {
  function automaticFixture() {
    const f = fixture();
    f.state.yaml = automaticWorkflow;
    const options: PrepareSessionArtifactsOptions = { ...f.options, mode: "auto" };
    return { ...f, options };
  }
  const successfulHistory = (id = 100, title = sessionTitle) => ({
    id,
    display_title: title,
    status: "completed",
    conclusion: "success",
  });
  it.each(["insert", "replace"])(
    "auto tolerates an artifact page shift (%s) without repeating its claim",
    async (change) => {
      const f = automaticFixture();
      const original = Array.from({ length: 101 }, (_, index) => ({
        ...f.metadata(1000 + index),
        name: `another-session-${String(index)}`,
      }));
      f.state.sources.push(
        { ...f.metadata(2000), name: "new-other-session-artifact" },
        ...(change === "insert" ? original : original.slice(0, -1)),
      );
      f.api.actions.listArtifactsForRepo.mockReturnValueOnce({
        data: { total_count: original.length, artifacts: original.slice(0, 100) },
      });

      await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({
        selection: "created",
        generation: 1,
      });
      expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
      expect(
        f.api.actions.listArtifactsForRepo.mock.calls.map(([request]) => request?.page),
      ).toEqual([1, 2, 1, 2]);
    },
  );
  it("auto rejects persistently duplicated artifact pages before claiming a Session", async () => {
    const f = automaticFixture();
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      ...f.metadata(1000 + index),
      name: `another-session-${String(index)}`,
    }));
    f.state.sources.push(...firstPage, ...firstPage.slice(-1));
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/unstable or duplicated/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    expect(f.api.actions.listArtifactsForRepo).toHaveBeenCalledTimes(4);
  });
  it("auto retains the repository artifact bound without rescanning an oversized listing", async () => {
    const f = automaticFixture();
    f.api.actions.listArtifactsForRepo.mockReturnValue({
      data: { total_count: 1001, artifacts: [] },
    });
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/exceed the bound/u);
    expect(f.api.actions.listArtifactsForRepo).toHaveBeenCalledTimes(1);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("auto does not retry a repository artifact transport failure", async () => {
    const f = automaticFixture();
    f.api.actions.listArtifactsForRepo.mockImplementation(() => {
      throw new Error("artifact HTTP unavailable");
    });
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow("artifact HTTP unavailable");
    expect(f.api.actions.listArtifactsForRepo).toHaveBeenCalledTimes(1);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("auto creates only after complete history proves no previous key, and saves the first generation", async () => {
    const f = automaticFixture();
    f.state.history.push(successfulHistory(90, "dsh-session-an-independent-key"));
    const prepared = await prepareSessionArtifacts(f.options);
    expect(prepared).toMatchObject({ selection: "created", generation: 1 });
    expect(prepared.source).toBeUndefined();
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).resolves.toMatchObject({ generation: 1 });
    expect(f.api.actions.listWorkflowRuns).toHaveBeenCalledTimes(2);
  });
  it("auto scans every history page before admitting a new independent key", async () => {
    const f = automaticFixture();
    for (let id = 1; id <= 100; id++)
      f.state.history.push(successfulHistory(id, `dsh-session-other-${String(id)}`));
    await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({
      selection: "created",
    });
    expect(f.api.actions.listWorkflowRuns).toHaveBeenCalledTimes(2);
  });
  it("auto restores an independent successful run by key without a source run input", async () => {
    const f = automaticFixture();
    f.state.history.push(successfulHistory());
    f.state.sources.push(f.metadata(100));
    const prepared = await prepareSessionArtifacts(f.options);
    expect(prepared).toMatchObject({ selection: "resumed", generation: 2, source: { runId: 100 } });
    expect(prepared.checkpoint?.payload).toEqual(f.saved.payload);
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200, 2),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).resolves.toMatchObject({ generation: 2 });
  });
  it("auto uses case-insensitive run titles matching GitHub key concurrency", async () => {
    const f = automaticFixture();
    f.state.title = sessionTitle.toUpperCase().replace("DSH-SESSION-", "dsh-session-");
    f.state.history.push(successfulHistory());
    f.state.sources.push(f.metadata(100));
    await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({
      selection: "resumed",
    });
  });
  it.each(["failed", "unknown", "missing", "expired", "corrupt", "incompatible"])(
    "auto refuses %s history before a claim or worker and never falls back to an older success",
    async (kind) => {
      const f = automaticFixture();
      f.state.history.push(successfulHistory());
      if (kind === "failed")
        f.state.history.push({ ...successfulHistory(150), conclusion: "failure" });
      if (kind === "unknown")
        f.state.history.push({
          ...successfulHistory(150),
          status: "in_progress",
          conclusion: null,
        });
      if (!["missing"].includes(kind)) f.state.sources.push(f.metadata(100));
      const source = f.state.sources[0];
      if (kind === "expired" && source !== undefined) source.expired = true;
      if (kind === "incompatible" && source !== undefined)
        source.name = `dsh-session-${binding.keyHash}-${"f".repeat(64)}-g1-a1`;
      if (kind === "corrupt") f.fetchArchive.mockResolvedValueOnce(new Response("invalid archive"));
      const expected = kind === "corrupt" ? /SHA256/u : new RegExp(kind, "u");
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(expected);
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it("auto refuses successful history with no checkpoint even when an older checkpoint remains", async () => {
    const f = automaticFixture();
    f.state.history.push(successfulHistory(), successfulHistory(150));
    f.state.sources.push(f.metadata(100));
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/missing/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("auto rejects rerunning an old Actions run before any history discovery or claim", async () => {
    const f = automaticFixture();
    f.state.runAttempt = 2;
    await expect(
      prepareSessionArtifacts({
        ...f.options,
        currentRun: { ...f.options.currentRun, runAttempt: 2 },
      }),
    ).rejects.toThrow(/cannot rerun/u);
    expect(f.api.actions.listWorkflowRuns).not.toHaveBeenCalled();
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it.each(["success", "failure", null])(
    "auto rejects older unkeyed workflow history with %s even when a matching checkpoint remains",
    async (conclusion) => {
      const f = automaticFixture();
      f.state.history.push(successfulHistory(), {
        ...successfulHistory(90, "Legacy explicit Session"),
        conclusion,
      });
      f.state.sources.push(f.metadata(100));
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(
        /unknown.*no verifiable key/u,
      );
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it("auto detects an active same-key conflict while another key can be active independently", async () => {
    const f = automaticFixture();
    f.state.history.push({
      ...successfulHistory(210, "dsh-session-different"),
      status: "in_progress",
      conclusion: null,
    });
    const prepared = await prepareSessionArtifacts(f.options);
    f.state.history.push({ ...successfulHistory(211), status: "in_progress", conclusion: null });
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toThrow(/same-key conflict/u);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it.each(["success", "failure", null])(
    "auto rejects an older queued request after a newer same-key request completed with %s",
    async (conclusion) => {
      const f = automaticFixture();
      f.state.history.push({ ...successfulHistory(210), conclusion });
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(
        /stale or concurrent same-key conflict/u,
      );
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it.each(["queued", "waiting", "pending", "requested"])(
    "auto permits a newer same-key request which is still %s",
    async (status) => {
      const f = automaticFixture();
      f.state.history.push({ ...successfulHistory(210), status, conclusion: null });
      await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({
        selection: "created",
      });
    },
  );
  it("auto rechecks changed parent history before checkpoint save", async () => {
    const f = automaticFixture();
    const prepared = await prepareSessionArtifacts(f.options);
    f.state.history.push(successfulHistory());
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toThrow(/parent history changed/u);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it.each(["bound", "incomplete", "duplicate", "http", "wrong-title", "legacy-artifact"])(
    "auto fails closed for %s history evidence",
    async (kind) => {
      const f = automaticFixture();
      if (kind === "bound")
        f.api.actions.listWorkflowRuns.mockReturnValueOnce({
          data: { total_count: 1001, workflow_runs: [] },
        });
      if (kind === "incomplete")
        f.api.actions.listWorkflowRuns.mockReturnValue({
          data: { total_count: 1, workflow_runs: [] },
        });
      if (kind === "duplicate")
        f.state.history.push(successfulHistory(100), successfulHistory(100));
      if (kind === "http")
        f.api.actions.listWorkflowRuns.mockImplementationOnce(() => {
          throw new Error("history HTTP unavailable");
        });
      if (kind === "wrong-title") f.state.title = "unbound-title";
      if (kind === "legacy-artifact") f.state.sources.push(f.metadata(100));
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow();
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it("creates one metadata-only claim before model, then checks fresh authority and saves exactly two files", async () => {
    const f = fixture();
    const prepared = await prepareSessionArtifacts(f.options);
    expect(prepared.binding.workflow.jobName).toBe("Session worker");
    expect(prepared.claimArtifactId).toBe(900);
    expect(f.uploader.uploadArtifact.mock.calls[0]?.[0]).toBe(sessionClaimName(binding.keyHash, 1));
    expect(f.uploader.uploadArtifact.mock.calls[0]?.[1]).toHaveLength(1);
    const result = await saveSessionArtifact({
      prepared,
      checkpoint: checkpoint(200),
      deadlineMs: f.options.deadlineMs,
      signal: f.options.signal,
    });
    expect(result.generation).toBe(1);
    expect(f.authorizeCurrent).toHaveBeenCalledTimes(2);
    expect(f.uploader.uploadArtifact.mock.calls[1]?.[1]).toHaveLength(2);
    expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(2);
    expect(f.receipts.map(({ kind }) => kind)).toEqual(["claim", "checkpoint"]);
    expect(f.api.actions.getArtifact.mock.calls[0]?.[0]).not.toHaveProperty("request.dshImmutable");
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toThrow(/already saved/u);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(2);
  });
  it.each([
    "run",
    "repository",
    "sha",
    "name",
    "id",
    "size",
    "digest",
    "retention",
    "attempt-window",
  ])(
    "refuses a confirmed upload with wrong fresh server %s without uploading again",
    async (field) => {
      const f = fixture();
      f.api.actions.getArtifact.mockImplementationOnce(({ artifact_id }) => {
        const uploaded = f.state.current.find(({ id }) => id === artifact_id);
        if (uploaded === undefined) throw new Error("Missing uploaded fixture");
        const item = { ...uploaded, workflow_run: { ...uploaded.workflow_run } };
        if (field === "run") item.workflow_run.id = 100;
        if (field === "repository") item.workflow_run.repository_id = 99;
        if (field === "sha") item.workflow_run.head_sha = "f".repeat(40);
        if (field === "name") item.name = "different-name";
        if (field === "id") item.id++;
        if (field === "size") item.size_in_bytes++;
        if (field === "digest") item.digest = `sha256:${"f".repeat(64)}`;
        if (field === "retention")
          item.expires_at = new Date(Date.parse(item.created_at) + 86400_000).toISOString();
        if (field === "attempt-window")
          item.created_at = new Date(Date.parse(item.created_at) - 86400_000).toISOString();
        return { data: item };
      });
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(PolicyDeniedError);
      expect(f.receipts).toEqual([
        expect.objectContaining({
          kind: "claim",
          id: 900,
          name: sessionClaimName(binding.keyHash, 1),
        }),
      ]);
      expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
      expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(1);
    },
  );
  it("records a confirmed claim before post-upload metadata lookup fails", async () => {
    const f = fixture();
    const failure = new Error("Artifact metadata lookup unavailable");
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      expect(f.receipts).toHaveLength(1);
      throw failure;
    });
    await expect(prepareSessionArtifacts(f.options)).rejects.toBe(failure);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("admits one acknowledged claim when its exact metadata becomes visible after a 404", async () => {
    const f = fixture();
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const prepared = await prepareSessionArtifacts(f.options);
    expect(prepared).toMatchObject({ claimArtifactId: 900, generation: 1, selection: "created" });
    expect(f.api.actions.getArtifact.mock.calls.map(([request]) => request.artifact_id)).toEqual([
      900, 900,
    ]);
    expect(f.receipts).toHaveLength(1);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(f.authorizeCurrent).toHaveBeenCalledTimes(1);
  });
  it("saves one acknowledged checkpoint when its exact metadata becomes visible after a 404", async () => {
    const f = fixture();
    const prepared = await prepareSessionArtifacts(f.options);
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      expect(f.receipts[1]).toMatchObject({ kind: "checkpoint", id: 901 });
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    const saved = await saveSessionArtifact({
      prepared,
      checkpoint: checkpoint(200),
      deadlineMs: f.options.deadlineMs,
      signal: f.options.signal,
    });
    expect(saved).toMatchObject({ id: 901, generation: 1 });
    expect(f.api.actions.getArtifact.mock.calls.map(([request]) => request.artifact_id)).toEqual([
      900, 901, 901,
    ]);
    expect(f.receipts.map(({ kind, id }) => ({ kind, id }))).toEqual([
      { kind: "claim", id: 900 },
      { kind: "checkpoint", id: 901 },
    ]);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(2);
    expect(f.authorizeCurrent).toHaveBeenCalledTimes(2);
  });
  it("keeps an acknowledged claim but fails closed when metadata remains missing", async () => {
    const f = fixture();
    f.api.actions.getArtifact.mockImplementation(() => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/bounded confirmation/u);
    expect(f.api.actions.getArtifact.mock.calls.map(([request]) => request.artifact_id)).toEqual([
      900, 900, 900, 900, 900,
    ]);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("stops acknowledged receipt confirmation at its time bound", async () => {
    const f = fixture();
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5_000);
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    try {
      await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/bounded confirmation/u);
      expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(1);
      expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
      expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("cancels a pending receipt visibility wait without another read or upload", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      setTimeout(() => controller.abort(new Error("Cancelled receipt confirmation")), 25);
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    await expect(
      prepareSessionArtifacts({ ...f.options, signal: controller.signal }),
    ).rejects.toThrow(/abort|cancel/iu);
    expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(1);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("rejects a late metadata response after the confirmation signal expires", async () => {
    const f = fixture();
    const getArtifact = vi.fn(({ request: { signal } }: { request: { signal: AbortSignal } }) => {
      const uploaded = f.state.current[0];
      if (uploaded === undefined) throw new Error("Missing uploaded fixture");
      return new Promise<{ data: ReturnType<typeof f.metadata> }>((resolve) => {
        signal.addEventListener("abort", () => resolve({ data: uploaded }), { once: true });
      });
    });
    const client = githubClientFixture({
      rest: { ...f.api, actions: { ...f.api.actions, getArtifact } },
    });
    await expect(prepareSessionArtifacts({ ...f.options, client })).rejects.toThrow(/timeout/iu);
    expect(f.options.signal.aborted).toBe(false);
    expect(getArtifact).toHaveBeenCalledTimes(1);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("honors the existing task deadline during acknowledged receipt confirmation", async () => {
    const f = fixture();
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      throw Object.assign(new Error("Not Found"), { status: 404 });
    });
    await expect(
      prepareSessionArtifacts({ ...f.options, deadlineMs: Date.now() + 750 }),
    ).rejects.toThrow(/abort|timeout/iu);
    expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(1);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 503])(
    "preserves an acknowledged claim but does not retry metadata HTTP %i",
    async (status) => {
      const f = fixture();
      const failure = Object.assign(new Error("Artifact metadata rejected"), { status });
      f.api.actions.getArtifact.mockImplementationOnce(() => {
        throw failure;
      });
      await expect(prepareSessionArtifacts(f.options)).rejects.toBe(failure);
      expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(1);
      expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
      expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects a mismatching visible receipt after a 404 without further reads or uploads", async () => {
    const f = fixture();
    f.api.actions.getArtifact
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      })
      .mockImplementationOnce(({ artifact_id }) => {
        const uploaded = f.state.current.find(({ id }) => id === artifact_id);
        if (uploaded === undefined) throw new Error("Missing uploaded fixture");
        return { data: { ...uploaded, digest: `sha256:${"f".repeat(64)}` } };
      });
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/fresh GitHub artifact/u);
    expect(f.api.actions.getArtifact).toHaveBeenCalledTimes(2);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("records a confirmed checkpoint before its metadata lookup fails", async () => {
    const f = fixture();
    const prepared = await prepareSessionArtifacts(f.options);
    const failure = new Error("Checkpoint metadata lookup unavailable");
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      expect(f.receipts).toHaveLength(2);
      throw failure;
    });
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toBe(failure);
    expect(f.receipts[1]).toMatchObject({ kind: "checkpoint", id: 901 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(2);
  });
  it("preserves post-upload quota identity and the confirmed receipt without retry", async () => {
    const f = fixture();
    const quota = new GitHubQuotaError({
      credentialScope: "production-action",
      clientRole: "main-controller",
      requests: 1,
      cacheHits: 0,
      coalesced: 0,
      retries: 0,
      waitMs: 0,
      quotaFailures: 1,
    });
    f.api.actions.getArtifact.mockImplementationOnce(() => {
      throw quota;
    });
    await expect(prepareSessionArtifacts(f.options)).rejects.toBe(quota);
    expect(f.receipts[0]).toMatchObject({ kind: "claim", id: 900 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("refuses a checkpoint manifest claiming retention beyond its actual artifact", async () => {
    const f = fixture();
    const prepared = await prepareSessionArtifacts(f.options);
    const saved = checkpoint(200);
    saved.manifest.expiresAt = new Date(
      Date.parse(saved.manifest.createdAt) + 4 * 86400_000,
    ).toISOString();
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: saved,
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toThrow(/retention is shorter/u);
    expect(f.receipts[1]).toMatchObject({ kind: "checkpoint", id: 901 });
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(2);
  });
  it("records an acknowledged ID but rejects an incomplete SDK receipt", async () => {
    const f = fixture();
    f.uploader.uploadArtifact.mockResolvedValueOnce({ id: 900 });
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/incomplete or invalid/u);
    expect(f.receipts).toEqual([
      { kind: "claim", id: 900, name: sessionClaimName(binding.keyHash, 1) },
    ]);
    expect(f.api.actions.getArtifact).not.toHaveBeenCalled();
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("rejects a downloaded manifest whose expiry exceeds the actual source artifact", async () => {
    const f = fixture();
    const item = f.metadata(100);
    item.expires_at = new Date(Date.parse(item.created_at) + 86400_000).toISOString();
    f.state.sources.push(item);
    await expect(
      prepareSessionArtifacts({ ...f.options, mode: "resume", sourceRunId: 100 }),
    ).rejects.toThrow(/retention differs/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("restores only the exact successful selected source, with no Controller auth header on blob fetch", async () => {
    const f = fixture();
    f.state.sources.push(f.metadata(100));
    const prepared = await prepareSessionArtifacts({
      ...f.options,
      mode: "resume",
      sourceRunId: 100,
    });
    expect(prepared.generation).toBe(2);
    expect(prepared.source?.runId).toBe(100);
    expect(Buffer.from(prepared.checkpoint?.payload ?? [])).toEqual(f.saved.payload);
    expect(f.fetchArchive.mock.calls[0]?.[1]).not.toHaveProperty("headers");
    expect(f.api.actions.downloadArtifact.mock.calls[0]?.[0]).toMatchObject({
      artifact_id: 100,
      archive_format: "zip",
    });
  });
  it.each(["failure", "old-attempt", "duplicate", "stale-parent", "missing"])(
    "refuses %s parent without creating a claim or replaying a task",
    async (kind) => {
      const f = fixture();
      f.state.sources.push(f.metadata(100));
      if (kind === "failure") f.state.sourceConclusion = "failure";
      if (kind === "old-attempt") f.state.runAttempt = 2;
      if (kind === "duplicate") f.state.sources.push(f.metadata(100));
      if (kind === "stale-parent") f.state.sources.push(f.metadata(150, 2));
      if (kind === "missing") f.state.sources.splice(0);
      const currentRun =
        kind === "old-attempt" ? { ...f.options.currentRun, runAttempt: 2 } : f.options.currentRun;
      await expect(
        prepareSessionArtifacts({ ...f.options, currentRun, mode: "resume", sourceRunId: 100 }),
      ).rejects.toThrow(PolicyDeniedError);
      expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
    },
  );
  it("refuses same-attempt duplicate claim and excludes a prior failed attempt claim", async () => {
    const f = fixture();
    const claim = f.metadata(200);
    claim.name = sessionClaimName(binding.keyHash, 1);
    f.state.current.push(claim);
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/advance twice/u);
    claim.name = sessionClaimName(binding.keyHash, 2);
    await expect(prepareSessionArtifacts(f.options)).resolves.toMatchObject({ generation: 1 });
  });
  it("fresh permission revocation blocks save after successful admission", async () => {
    const f = fixture();
    const prepared = await prepareSessionArtifacts(f.options);
    f.authorizeCurrent.mockRejectedValueOnce(new PolicyDeniedError("Actor permission changed"));
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toThrow(/permission changed/u);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("fresh permission rejection blocks the initial claim upload", async () => {
    const f = fixture();
    f.authorizeCurrent.mockRejectedValueOnce(new PolicyDeniedError("Actor permission changed"));
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/permission changed/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("refuses a substituted same-name claim ID before final upload", async () => {
    const f = fixture();
    const prepared = await prepareSessionArtifacts(f.options);
    const claim = f.state.current[0];
    if (claim === undefined) throw new Error("Expected claim fixture");
    claim.id++;
    await expect(
      saveSessionArtifact({
        prepared,
        checkpoint: checkpoint(200),
        deadlineMs: f.options.deadlineMs,
        signal: f.options.signal,
      }),
    ).rejects.toThrow(/claim is missing/u);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
  });
  it("rejects two successful runs that claim the same logical generation", async () => {
    const f = fixture();
    f.state.sources.push(f.metadata(100), f.metadata(150));
    await expect(
      prepareSessionArtifacts({ ...f.options, mode: "resume", sourceRunId: 100 }),
    ).rejects.toThrow(/Conflicting/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it.each([
    "1000001",
    "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
  ])("rejects unbounded artifact generation %s before claiming", async (generation) => {
    const f = fixture();
    const item = f.metadata(100);
    item.name = item.name.replace("-g1-a1", `-g${generation}-a1`);
    f.state.sources.push(item);
    await expect(
      prepareSessionArtifacts({ ...f.options, mode: "resume", sourceRunId: 100 }),
    ).rejects.toThrow(/outside its bound/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("fails before claiming when the highest supported generation is exhausted", async () => {
    const f = fixture();
    f.state.sources.push(f.metadata(100, 1_000_000));
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/generation limit/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("rejects an unbounded artifact attempt before claiming", async () => {
    const f = fixture();
    const item = f.metadata(100);
    item.name = item.name.replace("-a1", "-a1001");
    f.state.sources.push(item);
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/outside its bound/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("bounds download bytes even when the signed response omits content-length", async () => {
    const f = fixture();
    f.state.sources.push(f.metadata(100));
    f.fetchArchive.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_SESSION_ARCHIVE_BYTES));
            controller.enqueue(new Uint8Array(1));
            controller.close();
          },
        }),
      ),
    );
    await expect(
      prepareSessionArtifacts({ ...f.options, mode: "resume", sourceRunId: 100 }),
    ).rejects.toThrow(/stream exceeds its byte bound/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("rejects a source artifact created outside its exact producer attempt window", async () => {
    const f = fixture();
    const item = f.metadata(100);
    item.created_at = new Date(Date.now() - 86400_000).toISOString();
    f.state.sources.push(item);
    await expect(
      prepareSessionArtifacts({ ...f.options, mode: "resume", sourceRunId: 100 }),
    ).rejects.toThrow(/provenance/u);
    expect(f.uploader.uploadArtifact).not.toHaveBeenCalled();
  });
  it("does not retry an ambiguous SDK claim write or echo its credentials", async () => {
    const f = fixture();
    f.uploader.uploadArtifact.mockRejectedValueOnce(new Error("controller-secret"));
    await expect(prepareSessionArtifacts(f.options)).rejects.toThrow(/uncertain/u);
    expect(f.uploader.uploadArtifact).toHaveBeenCalledTimes(1);
    expect(f.receipts).toHaveLength(0);
    expect(f.api.actions.getArtifact).not.toHaveBeenCalled();
  });
});
