import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactClient } from "@actions/artifact";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import { seedSessionHistoryFixture } from "../.github/e2e/session-history-fixture.mjs";
import { assertOrphanFixtureProvenance } from "../.github/e2e/session-history-fixture-proof.mjs";
import {
  sessionArtifactName,
  sessionKeyHash,
  type SessionBinding,
} from "../src/session/contracts.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const memory = "0123456789abcdef".repeat(3);
const challenge = "b".repeat(24);
const sessionId = "session-11111111-1111-4111-8111-111111111111";

async function fixture(extra: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-history-fixture-"));
  roots.push(root);
  const directory = join(root, "session-e2e");
  await mkdir(directory);
  await mkdir(join(directory, "proof"));
  await mkdir(join(directory, "evidence"));
  const binding: SessionBinding = {
    repository: { id: 1, owner: "octo", repo: "repo" },
    workflow: {
      path: ".github/workflows/session-auto-e2e.yml",
      jobId: "session",
      jobName: "session",
    },
    task: { kind: "automation", identity: "task:source-key" },
    runtime: {
      dshVersion: "0.2.0-rc.2",
      mode: "controlled",
      compositionId: "controlled-fixture",
      containerImage: `node@sha256:${"a".repeat(64)}`,
      extensionDigest: "b".repeat(64),
    },
    keyHash: sessionKeyHash("source-key"),
  };
  const artifactName = sessionArtifactName(binding, 1, 1);
  const now = Date.now();
  const header = sessionFormatCatalog.encodeCurrentHeader(
    {
      version: 4,
      id: sessionId,
      createdAt: now,
      cwd: "/workspace",
      isSeeded: false,
      delegationDepth: 0,
    },
    0,
  );
  const rows = [
    { type: "permission/preset", data: { preset: "workspace-write" } },
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: "approval/policy", data: { policy: "never" } },
    { type: "turn/start", data: { turn: 1 } },
    {
      type: "user/message",
      data: {
        id: "message-1",
        role: "user",
        content: [{ type: "text", text: `${memory} ${challenge}` }],
        source: { kind: "user" },
      },
      surfaceOp: "append",
    },
    { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
  ];
  const payload = Buffer.from(
    [header, ...rows.map((row, seq) => ({ ...row, seq, time: now + seq }))]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const manifest = {
    schemaVersion: 1,
    repository: binding.repository,
    workflow: { ...binding.workflow, runId: 10, runAttempt: 1, sourceSha: "d".repeat(40) },
    task: binding.task,
    runtime: binding.runtime,
    issuer: { actorId: 7, actorLogin: "maintainer", jobRunId: 22 },
    session: { sessionId, keyHash: binding.keyHash, generation: 1 },
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3 * 86400_000).toISOString(),
    payload: { file: "session.jsonl", bytes: payload.length, sha256: hash(payload) },
  };
  const archive = zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "session.jsonl": payload,
  });
  const proof = {
    schemaVersion: 1,
    qualified: true,
    phase: "save",
    repository: "octo/repo",
    runId: 10,
    runAttempt: 1,
    candidateSha: "c".repeat(40),
    harnessSha: "d".repeat(40),
    dshMode: "controlled",
    keyHash: binding.keyHash,
    memory,
    challenge,
    sessionId,
    generation: 1,
    artifactId: 30,
    artifactName,
    payloadSha256: hash(payload),
    archiveSha256: hash(archive),
  };
  await writeFile(join(directory, "proof", "proof.json"), JSON.stringify(proof));
  await writeFile(join(directory, "current-checkpoint.zip"), archive);
  const result = {
    conclusion: "success",
    operation: "task",
    dsh: { mode: "controlled" },
    policy: { trust: "trusted-write" },
    permissions: { workspaceWrite: true },
    isolation: { backend: "docker", processIsolated: true, workspaceAccess: "read-write" },
    taskOutput: { memory, challenge, phase: "save" },
    session: {
      mode: "auto",
      selection: "created",
      status: "saved",
      generation: 1,
      artifactId: 30,
      artifactName,
      sessionId,
      payloadSha256: hash(payload),
    },
    loop: { turns: 1, toolCalls: 0 },
    write: { status: "no-changes", changedPaths: [] },
    validation: { status: "not-applicable", commandCount: 0 },
  };
  const env = {
    GITHUB_REPOSITORY: "octo/repo",
    GITHUB_REPOSITORY_ID: "1",
    GITHUB_RUN_ID: "10",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_JOB: "session",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "d".repeat(40),
    GITHUB_WORKFLOW_SHA: "d".repeat(40),
    GITHUB_WORKFLOW_REF: "octo/repo/.github/workflows/session-auto-e2e.yml@refs/heads/main",
    DEFAULT_BRANCH: "main",
    CANDIDATE_SHA: "c".repeat(40),
    HARNESS_SHA: "d".repeat(40),
    RUNNER_TEMP: root,
    GITHUB_WORKSPACE: join(root, "workspace"),
    GITHUB_ACTOR: "maintainer",
    GITHUB_ACTOR_ID: "7",
    DSH_MODE: "controlled",
    SESSION_KEY: "source-key",
    EXPECTED_FAILURE: "none",
    ACTION_OUTCOME: "success",
    FIXTURE_KIND: "corrupt",
    FIXTURE_TARGET_KEY: "",
    RESULT_JSON: JSON.stringify(result),
    ...extra,
  };
  const calls: { kind: string; name: string; id?: number; options?: unknown }[] = [];
  const uploads: { name: string; files: Record<string, Buffer> }[] = [];
  const artifacts = new Map([
    [artifactName, { id: 30, name: artifactName, size: archive.length, digest: hash(archive) }],
  ]);
  const artifactClient: Pick<ArtifactClient, "getArtifact" | "deleteArtifact" | "uploadArtifact"> =
    {
      getArtifact: (name, options) => {
        calls.push({ kind: "get", name, options });
        const artifact = artifacts.get(name);
        if (artifact === undefined) return Promise.reject(new Error("Artifact missing"));
        return Promise.resolve({ artifact });
      },
      deleteArtifact: (name, options) => {
        calls.push({ kind: "delete", name, options });
        const artifact = artifacts.get(name);
        if (artifact === undefined) return Promise.reject(new Error("Artifact missing"));
        artifacts.delete(name);
        return Promise.resolve({ id: artifact.id });
      },
      uploadArtifact: async (name, paths, root, options) => {
        calls.push({ kind: "upload", name, options });
        const files: Record<string, Buffer> = {};
        for (const path of paths) files[path.slice(root.length + 1)] = await readFile(path);
        uploads.push({ name, files });
        const uploaded = zipSync(files);
        const artifact = { id: 31, name, size: uploaded.length, digest: hash(uploaded) };
        artifacts.set(name, artifact);
        return { id: artifact.id, size: artifact.size, digest: artifact.digest };
      },
    };
  return {
    directory,
    env,
    artifactClient,
    calls,
    uploads,
    artifacts,
    binding,
    artifactName,
    proof,
  };
}

describe("trusted current-run Session history fixture seam", () => {
  it("replaces only the independently qualified own checkpoint through the SDK", async () => {
    const value = await fixture();
    const receipt = await seedSessionHistoryFixture(value);
    expect(value.calls.filter((call) => call.kind === "delete")).toEqual([
      { kind: "delete", name: value.artifactName, options: undefined },
    ]);
    expect(value.uploads).toHaveLength(1);
    expect(value.uploads[0]?.name).toBe(value.artifactName);
    expect(Object.keys(value.uploads[0]?.files ?? {})).toEqual(["manifest.json", "session.jsonl"]);
    expect(JSON.stringify(receipt)).not.toContain(memory);
    expect(receipt).toMatchObject({
      seeded: true,
      kind: "corrupt",
      sourceArtifactId: 30,
      artifactId: 31,
    });
    expect(await readFile(join(value.directory, "proof", "proof.json"), "utf8")).toContain(memory);
  });
  it.each([
    { ACTION_OUTCOME: "failure" },
    { EXPECTED_FAILURE: "corrupt" },
    { GITHUB_RUN_ID: "11" },
    { GITHUB_REF: "refs/pull/1/merge" },
    { GITHUB_REPOSITORY: "fork/repo" },
    { GITHUB_RUN_ATTEMPT: "2" },
    { GITHUB_ACTOR: "someone-else" },
    { GITHUB_ACTOR_ID: "99" },
  ])("creates no effects when the verified producer binding changes: %j", async (extra) => {
    const value = await fixture(extra);
    await expect(seedSessionHistoryFixture(value)).rejects.toThrow(/SESSION_(?:FIXTURE|E2E)_/u);
    expect(value.calls).toEqual([]);
  });
  it("refuses to delete a name whose SDK ID differs from the qualified result", async () => {
    const value = await fixture();
    value.artifacts.set(value.artifactName, {
      id: 99,
      name: value.artifactName,
      size: 100,
      digest: "0".repeat(64),
    });
    await expect(seedSessionHistoryFixture(value)).rejects.toThrow(/SESSION_FIXTURE_/u);
    expect(value.calls.some((call) => call.kind === "delete" || call.kind === "upload")).toBe(
      false,
    );
  });
  it("uploads an orphan under the full fresh target binding without deleting the source checkpoint", async () => {
    const value = await fixture({ FIXTURE_KIND: "orphan", FIXTURE_TARGET_KEY: "target-key" });
    const receipt = await seedSessionHistoryFixture(value);
    const targetBinding = {
      ...value.binding,
      keyHash: sessionKeyHash("target-key"),
      task: { kind: "automation" as const, identity: "task:target-key" },
    };
    expect(receipt.artifactName).toBe(sessionArtifactName(targetBinding, 1, 1));
    expect(value.calls.some((call) => call.kind === "delete")).toBe(false);
    expect(value.artifacts.has(value.artifactName)).toBe(true);
    const artifact = value.artifacts.get(receipt.artifactName);
    if (artifact === undefined) throw new Error("Missing uploaded orphan metadata");
    const provenance = {
      receipt,
      sourceProof: value.proof,
      sourceRun: {
        id: 10,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        event: "workflow_dispatch",
        path: ".github/workflows/session-auto-e2e.yml",
        head_sha: value.proof.harnessSha,
        head_branch: "main",
        repository: { full_name: "octo/repo", id: 1 },
        head_repository: { full_name: "octo/repo", id: 1 },
        display_title: "dsh-session-source-key",
      },
      artifact: {
        id: artifact.id,
        name: artifact.name,
        size_in_bytes: artifact.size,
        expired: false,
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3 * 86400_000).toISOString(),
        digest: `sha256:${artifact.digest}`,
        workflow_run: {
          id: 10,
          head_sha: value.proof.harnessSha,
          repository_id: 1,
          head_repository_id: 1,
        },
      },
      current: {
        repository: "octo/repo",
        runId: 10,
        runAttempt: 1,
        candidateSha: value.proof.candidateSha,
        harnessSha: value.proof.harnessSha,
        dshMode: "controlled",
        targetKey: "target-key",
        targetKeyHash: sessionKeyHash("target-key"),
        currentRunId: 11,
        defaultBranch: "main",
      },
      history: { status: "first" },
    };
    expect(assertOrphanFixtureProvenance(provenance)).toEqual(receipt);
    expect(() =>
      assertOrphanFixtureProvenance({
        ...provenance,
        sourceRun: { ...provenance.sourceRun, display_title: "dsh-session-target-key" },
      }),
    ).toThrow("ORPHAN_SOURCE");
    expect(() =>
      assertOrphanFixtureProvenance({
        ...provenance,
        history: { status: "success", source: { id: 9 } },
      }),
    ).toThrow("ORPHAN_SOURCE");
    expect(() =>
      assertOrphanFixtureProvenance({
        ...provenance,
        artifact: {
          ...provenance.artifact,
          workflow_run: { ...provenance.artifact.workflow_run, id: 9 },
        },
      }),
    ).toThrow("ORPHAN_ARTIFACT");
    expect(() =>
      assertOrphanFixtureProvenance({
        ...provenance,
        sourceRun: { ...provenance.sourceRun, head_repository: { full_name: "fork/repo", id: 2 } },
      }),
    ).toThrow("ORPHAN_SOURCE");
    expect(() =>
      assertOrphanFixtureProvenance({
        ...provenance,
        sourceProof: { ...value.proof, qualified: false },
      }),
    ).toThrow("ORPHAN_QUALIFICATION");
    expect(() =>
      assertOrphanFixtureProvenance({
        ...provenance,
        artifact: { ...provenance.artifact, digest: `sha256:${"0".repeat(64)}` },
      }),
    ).toThrow("ORPHAN_ARTIFACT");
  });
  it("rejects same-key diagnostic fixtures before reading or deleting an artifact", async () => {
    const value = await fixture({ FIXTURE_KIND: "orphan", FIXTURE_TARGET_KEY: "SOURCE-KEY" });
    await expect(seedSessionHistoryFixture(value)).rejects.toThrow("TARGET_KEY");
    expect(value.calls).toEqual([]);
  });
  it("rejects a fixture directory inside the worker before any SDK effect", async () => {
    const value = await fixture();
    value.env.GITHUB_WORKSPACE = value.directory;
    await expect(seedSessionHistoryFixture(value)).rejects.toThrow("OUTSIDE_WORKER");
    expect(value.calls).toEqual([]);
  });
  it("does not retry an uncertain fixture upload or write a successful receipt", async () => {
    const value = await fixture();
    let attempts = 0;
    value.artifactClient.uploadArtifact = () => {
      attempts += 1;
      return Promise.reject(new Error("SDK transport response lost"));
    };
    await expect(seedSessionHistoryFixture(value)).rejects.toThrow("SDK transport response lost");
    expect(attempts).toBe(1);
    expect(value.calls.filter((call) => call.kind === "delete")).toHaveLength(1);
    await expect(readFile(join(value.directory, "fixture", "receipt.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("does not upload after the SDK deletion acknowledgement has a different artifact ID", async () => {
    const value = await fixture();
    value.artifactClient.deleteArtifact = () => Promise.resolve({ id: 99 });
    await expect(seedSessionHistoryFixture(value)).rejects.toThrow("DELETED_ID");
    expect(value.uploads).toEqual([]);
  });
  it("supports the official SDK's optional metadata digest after independent archive verification", async () => {
    const value = await fixture();
    const get = value.artifactClient.getArtifact;
    value.artifactClient.getArtifact = async (name, options) => {
      const { artifact } = await get(name, options);
      return { artifact: { id: artifact.id, name: artifact.name, size: artifact.size } };
    };
    await expect(seedSessionHistoryFixture(value)).resolves.toMatchObject({
      seeded: true,
      artifactId: 31,
    });
  });
});
