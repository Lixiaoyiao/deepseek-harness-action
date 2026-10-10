import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath, URL } from "node:url";

import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { unzipSync } from "fflate";
import {
  assertExpiredFixtureProvenance,
  assertOrphanFixtureProvenance,
  historicalHarnessPaths,
} from "./session-history-fixture-proof.mjs";

const MAX_ARCHIVE = 4 * 1024 * 1024 + 64 * 1024;
const MAX_PAYLOAD = 4 * 1024 * 1024;
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const MEMORY = /^[a-f0-9]{48}$/u;
const CHALLENGE = /^[a-f0-9]{24}$/u;
const SESSION = /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const outcome = (value) =>
  ["success", "failure", "cancelled", "skipped"].includes(value) ? value : "not-run";
function requireCheck(condition, label) {
  if (!condition) throw new Error(`SESSION_E2E_${label}`);
}

/** The fixture stores expected memory outside both checked-out repositories and the worker. */
export function buildSessionTask(phase, challenge, memory) {
  requireCheck(["save", "resume"].includes(phase) && CHALLENGE.test(challenge), "TASK_IDENTITY");
  requireCheck(phase === "resume" || MEMORY.test(memory), "TASK_MEMORY");
  const instruction =
    phase === "save"
      ? `Remember this exact historical memory token for a future independent run: ${memory}.`
      : "Recall the exact 48-character historical memory token from the preceding task in this restored Session. The current task does not supply that token.";
  return {
    prompt: `${instruction} The current challenge is ${challenge}. Return taskOutput with memory, challenge and phase (${phase}). Use only the actual remembered token. Do not call tools, read files, modify anything or make external requests. Return the final Action JSON contract.`,
    schema: JSON.stringify({
      type: "object",
      properties: {
        memory: { type: "string", minLength: 48, maxLength: 48 },
        challenge: { type: "string", const: challenge },
        phase: { type: "string", const: phase },
      },
      required: ["memory", "challenge", "phase"],
      additionalProperties: false,
    }),
  };
}

export function assertSourceProof(proof, expected) {
  requireCheck(
    proof?.schemaVersion === 1 &&
      proof?.qualified === true &&
      ["save", "resume"].includes(proof?.phase) &&
      positive(proof?.generation),
    "SOURCE_PROOF",
  );
  for (const key of [
    "repository",
    "runId",
    "runAttempt",
    "candidateSha",
    "harnessSha",
    "dshMode",
    "keyHash",
  ])
    requireCheck(proof[key] === expected[key], "SOURCE_BINDING");
  requireCheck(
    MEMORY.test(proof.memory) &&
      CHALLENGE.test(proof.challenge) &&
      SESSION.test(proof.sessionId) &&
      positive(proof.artifactId) &&
      HEX64.test(proof.payloadSha256),
    "SOURCE_SHAPE",
  );
  return proof;
}

/** Independently verify the SDK artifact's payload and published full-session codec. Never extract files. */
export function inspectCheckpointArchive(input, expected) {
  requireCheck(input.length >= 22 && input.length <= MAX_ARCHIVE, "ARCHIVE_SIZE");
  const names = [];
  const files = unzipSync(input, {
    filter: (entry) => {
      names.push(entry.name);
      return (
        (entry.name === "manifest.json" && entry.originalSize <= 16 * 1024) ||
        (entry.name === "session.jsonl" && entry.originalSize <= MAX_PAYLOAD)
      );
    },
  });
  requireCheck(
    names.length === 2 &&
      names.includes("manifest.json") &&
      names.includes("session.jsonl") &&
      files["manifest.json"]?.length > 0 &&
      files["session.jsonl"]?.length > 0,
    "ARCHIVE_FILES",
  );
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const manifest = JSON.parse(utf8.decode(files["manifest.json"]));
  const payload = Buffer.from(files["session.jsonl"]);
  requireCheck(
    manifest.schemaVersion === 1 &&
      manifest.payload.file === "session.jsonl" &&
      manifest.payload.bytes === payload.length &&
      manifest.payload.sha256 === digest(payload) &&
      manifest.payload.sha256 === expected.payloadSha256,
    "CHECKSUM",
  );
  requireCheck(
    manifest.session.sessionId === expected.sessionId &&
      manifest.session.generation === expected.generation &&
      manifest.session.keyHash === expected.keyHash &&
      manifest.runtime.dshVersion === "0.2.0-rc.2" &&
      manifest.runtime.mode === expected.dshMode &&
      manifest.workflow.runId === expected.runId &&
      manifest.workflow.runAttempt === expected.runAttempt &&
      manifest.workflow.sourceSha === expected.harnessSha &&
      manifest.repository.owner + "/" + manifest.repository.repo === expected.repository &&
      manifest.workflow.path === ".github/workflows/session-auto-e2e.yml" &&
      manifest.workflow.jobId === "session" &&
      manifest.workflow.jobName === "session",
    "MANIFEST_BINDING",
  );
  const rows = utf8
    .decode(payload)
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  requireCheck(rows.length >= 2 && rows.length <= 20_001, "EVENT_BOUND");
  const header = sessionFormatCatalog.readHeader(rows[0]);
  requireCheck(
    header?.header.id === expected.sessionId &&
      header.header.cwd === "/workspace" &&
      header.status === "current" &&
      header.storedVersion === 4,
    "RAW_HEADER",
  );
  const restore = sessionFormatCatalog.createRestore(rows[0], {
    recovery: "strict",
    validation: "current",
  });
  for (const row of rows.slice(1)) restore.decodeRow(row);
  const restored = restore.finish();
  const events = restored.events;
  const last = (type, key) => events.filter((event) => event.type === type).at(-1)?.data?.[key];
  const text = utf8.decode(payload);
  requireCheck(
    last("permission/preset", "preset") === expected.permissionMode &&
      last("sandbox/mode", "mode") === expected.permissionMode &&
      last("approval/policy", "policy") === "never",
    "CURRENT_POLICY",
  );
  requireCheck(
    text.includes(expected.memory) && text.includes(expected.challenge),
    "RAW_MEMORY_AND_CHALLENGE",
  );
  requireCheck(
    events.filter((event) => event.type === "turn/start").length === expected.generation &&
      events.filter((event) => event.type === "turn/end").length === expected.generation &&
      !events.some((event) => event.type === "tool/call"),
    "ONLY_NEW_TASK",
  );
  return {
    payload,
    payloadSha256: digest(payload),
    archiveSha256: digest(input),
    manifestSha256: digest(JSON.stringify(manifest)),
    eventCount: events.length,
    generation: manifest.session.generation,
  };
}

export function resultChecks(result, expected) {
  const session = result?.session;
  return {
    liveTask: result?.conclusion === "success" && result?.operation === "task",
    memory: result?.taskOutput?.memory === expected.memory,
    newChallenge:
      result?.taskOutput?.challenge === expected.challenge &&
      result?.taskOutput?.phase === expected.phase,
    currentTrust:
      result?.policy?.trust === (expected.phase === "save" ? "trusted-write" : "trusted-read"),
    currentPermission: result?.permissions?.workspaceWrite === (expected.phase === "save"),
    currentIsolation:
      result?.isolation?.backend === "docker" &&
      result?.isolation?.processIsolated === true &&
      result?.isolation?.workspaceAccess ===
        (expected.phase === "save" ? "read-write" : "read-only"),
    mode: result?.dsh?.mode === expected.dshMode,
    checkpoint:
      session?.mode === (expected.sessionMode ?? expected.phase) &&
      session?.status === "saved" &&
      session?.generation === (expected.generation ?? (expected.phase === "save" ? 1 : 2)) &&
      positive(session?.artifactId) &&
      HEX64.test(session?.payloadSha256) &&
      SESSION.test(session?.sessionId),
    automaticSelection:
      expected.sessionMode !== "auto" ||
      session?.selection === (expected.phase === "save" ? "created" : "resumed"),
    newRun:
      expected.phase === "save" ||
      (session?.sourceRunId === expected.sourceRunId && expected.runId !== expected.sourceRunId),
    sameSession: expected.phase === "save" || session?.sessionId === expected.sessionId,
    newCheckpoint: expected.phase === "save" || session?.payloadSha256 !== expected.payloadSha256,
    noToolsOrWrites:
      result?.loop?.turns === 1 &&
      result?.loop?.toolCalls === 0 &&
      (result?.loop?.toolReceipts ?? []).length === 0 &&
      (result?.loop?.dshToolReceipts ?? []).length === 0 &&
      !result?.write?.commitSha &&
      !result?.write?.pullRequestNumber &&
      (result?.write?.changedPaths ?? []).length === 0 &&
      (expected.phase !== "save" || result?.write?.status === "no-changes"),
    noValidationExecution:
      result?.validation?.status === "not-applicable" && result?.validation?.commandCount === 0,
  };
}

/** Independent qualification oracle: key history comes from immutable run identity, not an artifact's survival. */
export function selectSessionHistory(runs, current) {
  requireCheck(Array.isArray(runs) && runs.length <= 1000, "HISTORY_BOUND");
  const matches = runs.filter(
    (run) =>
      positive(run?.id) &&
      run.id < current.runId &&
      run.path === ".github/workflows/session-auto-e2e.yml" &&
      run.event === "workflow_dispatch" &&
      run.display_title?.toLowerCase() === current.runTitle.toLowerCase(),
  );
  matches.sort((a, b) => b.id - a.id);
  const source = matches[0];
  if (source === undefined) return { status: "first", source: undefined };
  if (source.status !== "completed" || source.conclusion == null)
    return { status: "unknown", source };
  return { status: source.conclusion === "success" ? "success" : "failed", source };
}

/** Expected failure is a positive proof of denial before model/tool execution, never a success rewrite. */
export function failureChecks(result, expected, actionOutcome) {
  const diagnostic = result?.error?.message ?? "";
  const patterns = {
    failed: /Automatic Session history.*failed/iu,
    unknown:
      expected.orphanProvenanceVerified === true
        ? /^Automatic Session run-name does not match its verified logical key$/u
        : /Automatic Session history.*unknown/iu,
    expired:
      expected.manifestExpiryVerified === true
        ? /^Session checkpoint is expired or has an invalid retention window$/u
        : /Automatic Session history.*expired/iu,
    missing: /Automatic Session history.*missing/iu,
    incompatible: /Automatic Session history.*incompatible/iu,
    corrupt: /Session (?:artifact|ZIP|manifest|payload)|checkpoint.*(?:invalid|corrupt)/iu,
  };
  return {
    actionDenied: actionOutcome === "failure" && result?.conclusion === "failure",
    checkpointError: result?.error?.code === "SESSION_CHECKPOINT",
    exactBoundary: patterns[expected.expectedFailure]?.test(diagnostic) === true,
    noWorkerStart: result?.isolation === undefined && result?.timing?.agentDurationMs === undefined,
    noTaskExecution: (result?.loop?.turns ?? 0) === 0 && result?.taskOutput === undefined,
    noToolExecution:
      (result?.loop?.toolCalls ?? 0) === 0 &&
      (result?.loop?.toolReceipts ?? []).length === 0 &&
      (result?.loop?.dshToolReceipts ?? []).length === 0,
    noCheckpoint: result?.session?.status === "failed" && result?.session?.artifactId === undefined,
    noWrites:
      !result?.write?.commitSha &&
      !result?.write?.pullRequestNumber &&
      (result?.write?.changedPaths ?? []).length === 0,
  };
}

async function boundedFile(path, maximum) {
  const metadata = await lstat(path);
  requireCheck(
    metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximum,
    "LOCAL_FILE",
  );
  const bytes = await readFile(path);
  requireCheck(bytes.length <= maximum, "LOCAL_FILE");
  return bytes;
}

function identity(env) {
  const value = {
    requestedPhase: env.PHASE,
    sessionMode: "auto",
    expectedFailure: env.EXPECTED_FAILURE ?? "none",
    repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    candidateSha: env.CANDIDATE_SHA,
    harnessSha: env.HARNESS_SHA,
    dshMode: env.DSH_MODE,
    keyHash: digest((env.SESSION_KEY ?? "").toLowerCase()),
    runTitle: `dsh-session-${env.SESSION_KEY ?? ""}`,
    fixtureKind: env.FIXTURE_KIND ?? "none",
    fixtureSourceRunId: Number(env.FIXTURE_SOURCE_RUN_ID || 0),
  };
  requireCheck(
    ["auto", "save", "resume"].includes(value.requestedPhase) &&
      ["none", "failed", "expired", "missing", "corrupt", "unknown", "incompatible"].includes(
        value.expectedFailure,
      ) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) &&
      positive(value.runId) &&
      positive(value.runAttempt) &&
      HEX40.test(value.candidateSha) &&
      HEX40.test(value.harnessSha) &&
      ["controlled", "native"].includes(value.dshMode) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(env.SESSION_KEY ?? ""),
    "IDENTITY",
  );
  requireCheck(
    ["none", "corrupt", "orphan", "expired"].includes(value.fixtureKind) &&
      (value.fixtureSourceRunId === 0 ||
        (positive(value.fixtureSourceRunId) &&
          value.fixtureSourceRunId < value.runId &&
          ["unknown", "expired"].includes(value.expectedFailure) &&
          value.fixtureKind === "none")) &&
      (value.fixtureKind === "none" ||
        (value.expectedFailure === "none" &&
          env.FORCE_FAILURE !== "true" &&
          ["auto", "save"].includes(value.requestedPhase))) &&
      (value.fixtureKind === "orphan"
        ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(env.FIXTURE_TARGET_KEY ?? "") &&
          (env.FIXTURE_TARGET_KEY ?? "").toLowerCase() !== (env.SESSION_KEY ?? "").toLowerCase()
        : (env.FIXTURE_TARGET_KEY ?? "") === ""),
    "FIXTURE_SELECTION",
  );
  return value;
}

// Fixture/qualification reads use this job's GITHUB_TOKEN. Model credentials stay in the Action.
function githubReader(env) {
  const audit = { credentialScope: "session-e2e-fixture-job-token", apiCommands: 0, retries: 0 };
  const read = (path, maximum = 1024 * 1024) => {
    requireCheck(audit.apiCommands < 18, "REQUEST_BUDGET");
    audit.apiCommands += 1;
    try {
      return execFileSync("gh", ["api", "--method", "GET", path], {
        env,
        timeout: 30_000,
        maxBuffer: maximum,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error("SESSION_E2E_GITHUB_READ_FAILED_NO_RETRY");
    }
  };
  return {
    audit,
    json: (path) => JSON.parse(read(path).toString("utf8")),
    archive: (path) => read(path, MAX_ARCHIVE),
  };
}

async function prepare(env, directory) {
  const current = identity(env);
  const reader = githubReader(env);
  const runs = [];
  for (let page = 1; page <= 10; page++) {
    const listed = reader.json(
      `repos/${current.repository}/actions/workflows/session-auto-e2e.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`,
    );
    requireCheck(
      listed.total_count <= 1000 && Array.isArray(listed.workflow_runs),
      "HISTORY_BOUND",
    );
    runs.push(...listed.workflow_runs);
    if (runs.length >= listed.total_count) break;
    requireCheck(page < 10, "HISTORY_BOUND");
  }
  const history = selectSessionHistory(runs, current);
  const phase = history.status === "first" ? "save" : "resume";
  requireCheck(current.requestedPhase === "auto" || current.requestedPhase === phase, "PHASE");
  requireCheck(
    current.fixtureKind === "none" || history.status === "first",
    "FRESH_FIXTURE_PRODUCER",
  );
  let orphanProof;
  let expiryProof;
  if (current.fixtureSourceRunId > 0) {
    const source = reader.json(
      `repos/${current.repository}/actions/runs/${current.fixtureSourceRunId}`,
    );
    const listed = reader.json(
      `repos/${current.repository}/actions/runs/${current.fixtureSourceRunId}/artifacts?per_page=100`,
    );
    requireCheck(
      listed.total_count <= 100 && Array.isArray(listed.artifacts),
      "FIXTURE_ARTIFACT_BOUND",
    );
    const readProof = (name, file) => {
      const candidates = listed.artifacts.filter(
        (artifact) => artifact.name === name && !artifact.expired,
      );
      requireCheck(
        candidates.length === 1 &&
          candidates[0].size_in_bytes <= 16 * 1024 &&
          candidates[0].workflow_run?.id === current.fixtureSourceRunId &&
          candidates[0].workflow_run?.head_sha ===
            (current.expectedFailure === "expired" ? source.head_sha : current.harnessSha),
        "FIXTURE_PROOF_ARTIFACT",
      );
      const zip = reader.archive(
        `repos/${current.repository}/actions/artifacts/${candidates[0].id}/zip`,
      );
      requireCheck(candidates[0].digest === `sha256:${digest(zip)}`, "FIXTURE_PROOF_DIGEST");
      const names = [];
      const entries = unzipSync(zip, {
        filter: (entry) => {
          names.push(entry.name);
          return entry.name === file && entry.originalSize <= 8 * 1024;
        },
      });
      requireCheck(
        names.length === 1 && names[0] === file && entries[file]?.length > 0,
        "FIXTURE_PROOF_FILE",
      );
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entries[file]));
    };
    const receipt = readProof(
      `session-e2e-fixture-${source.id}-${source.run_attempt}`,
      "receipt.json",
    );
    const sourceProof = assertSourceProof(
      readProof(`session-e2e-proof-${source.id}-${source.run_attempt}`, "proof.json"),
      {
        ...current,
        runId: source.id,
        runAttempt: source.run_attempt,
        keyHash: receipt.sourceKeyHash,
        ...(current.expectedFailure === "expired"
          ? {
              candidateSha: receipt.candidateSha,
              harnessSha: source.head_sha,
            }
          : {}),
      },
    );
    const artifacts = listed.artifacts.filter(
      (artifact) => artifact.id === receipt.artifactId && artifact.name === receipt.artifactName,
    );
    requireCheck(artifacts.length === 1, "FIXTURE_CHECKPOINT_ARTIFACT");
    const provenance = {
      receipt,
      sourceProof,
      sourceRun: source,
      artifact: artifacts[0],
      history,
      current: {
        ...current,
        runId: source.id,
        runAttempt: source.run_attempt,
        targetKey: env.SESSION_KEY,
        targetKeyHash: current.keyHash,
        currentRunId: current.runId,
        defaultBranch: env.DEFAULT_BRANCH,
      },
    };
    if (current.expectedFailure === "expired") {
      let sourceHarness;
      if (source.head_sha !== current.harnessSha) {
        requireCheck(HEX40.test(source.head_sha), "FIXTURE_SOURCE_SHA");
        const commit = reader.json(`repos/${current.repository}/git/commits/${source.head_sha}`);
        requireCheck(
          commit.sha === source.head_sha && HEX40.test(commit.tree?.sha ?? ""),
          "FIXTURE_SOURCE_TREE",
        );
        const tree = reader.json(
          `repos/${current.repository}/git/trees/${commit.tree.sha}?recursive=1`,
        );
        const files = {};
        const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
        for (const path of historicalHarnessPaths)
          files[path] = await boundedFile(join(root, path), 128 * 1024);
        sourceHarness = { commit, tree, files };
      }
      const archive = reader.archive(
        `repos/${current.repository}/actions/artifacts/${receipt.artifactId}/zip`,
      );
      expiryProof = assertExpiredFixtureProvenance({ ...provenance, archive, sourceHarness });
    } else orphanProof = assertOrphanFixtureProvenance(provenance);
  }
  if (current.expectedFailure !== "none") {
    requireCheck(
      history.source !== undefined || orphanProof !== undefined,
      "FAILURE_REQUIRES_HISTORY",
    );
    if (["failed", "unknown"].includes(current.expectedFailure) && orphanProof === undefined)
      requireCheck(history.status === current.expectedFailure, "FAILURE_HISTORY");
  } else requireCheck(["first", "success"].includes(history.status), "HISTORY_NOT_SUCCESSFUL");
  let parent;
  if (phase === "resume" && current.expectedFailure === "none") {
    const run = reader.json(`repos/${current.repository}/actions/runs/${history.source.id}`);
    requireCheck(
      run.id === history.source.id &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.event === "workflow_dispatch" &&
        run.path === ".github/workflows/session-auto-e2e.yml" &&
        run.head_sha === current.harnessSha &&
        run.head_branch === env.DEFAULT_BRANCH &&
        run.repository?.full_name === current.repository &&
        run.head_repository?.full_name === current.repository &&
        positive(run.run_attempt),
      "SOURCE_RUN",
    );
    const artifacts = reader.json(
      `repos/${current.repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    requireCheck(artifacts.total_count <= 100, "SOURCE_ARTIFACT_BOUND");
    const matches = artifacts.artifacts.filter(
      (artifact) =>
        artifact.name === `session-e2e-proof-${run.id}-${run.run_attempt}` && !artifact.expired,
    );
    requireCheck(
      matches.length === 1 && matches[0].size_in_bytes <= 16 * 1024,
      "SOURCE_PROOF_ARTIFACT",
    );
    const proofZip = reader.archive(
      `repos/${current.repository}/actions/artifacts/${matches[0].id}/zip`,
    );
    const proofEntries = unzipSync(proofZip, {
      filter: (entry) => entry.name === "proof.json" && entry.originalSize <= 8 * 1024,
    });
    requireCheck(
      Object.keys(proofEntries).length === 1 && proofEntries["proof.json"]?.length > 0,
      "SOURCE_PROOF_FILE",
    );
    parent = assertSourceProof(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(proofEntries["proof.json"])),
      { ...current, runId: run.id, runAttempt: run.run_attempt },
    );
    const archive = reader.archive(
      `repos/${current.repository}/actions/artifacts/${parent.artifactId}/zip`,
    );
    inspectCheckpointArchive(archive, {
      ...parent,
      permissionMode: parent.phase === "save" ? "workspace-write" : "read-only",
    });
    await writeFile(join(directory, "source-checkpoint.zip"), archive);
  }
  const memory = parent?.memory ?? randomBytes(24).toString("hex");
  const challenge = randomBytes(12).toString("hex");
  const expected = {
    ...current,
    phase,
    ...(history.source === undefined ? {} : { sourceRunId: history.source.id }),
    ...(orphanProof === undefined
      ? {}
      : {
          orphanProvenanceVerified: true,
          orphanArtifactId: orphanProof.artifactId,
          orphanSourceRunId: orphanProof.runId,
        }),
    ...(expiryProof === undefined
      ? {}
      : {
          manifestExpiryVerified: true,
          expiryArtifactId: expiryProof.artifactId,
          expirySourceRunId: expiryProof.runId,
          manifestExpiresAt: expiryProof.expiry.expiresAt,
          expirySourceCandidateSha: expiryProof.candidateSha,
          expirySourceHarnessSha: expiryProof.harnessSha,
        }),
    generation: (parent?.generation ?? 0) + 1,
    memory,
    challenge,
    ...(parent === undefined
      ? {}
      : { sessionId: parent.sessionId, payloadSha256: parent.payloadSha256 }),
  };
  await writeFile(join(directory, "expected.json"), JSON.stringify(expected) + "\n", {
    mode: 0o600,
  });
  const task = buildSessionTask(phase, challenge, memory);
  const delimiter = `session_task_${randomBytes(16).toString("hex")}`;
  await appendFile(
    env.GITHUB_OUTPUT,
    `prompt<<${delimiter}\n${task.prompt}\n${delimiter}\nschema=${task.schema}\nphase=${phase}\n`,
  );
  await writeFile(
    join(directory, "evidence", "preparation.json"),
    JSON.stringify({
      phase,
      runId: current.runId,
      sourceRunId: history.source?.id,
      historyStatus: history.status,
      expectedFailure: current.expectedFailure,
      fixtureRequests: reader.audit,
      ...(orphanProof === undefined
        ? {}
        : {
            fixtureBoundary: "orphan-provenance-denial",
            orphanArtifactId: orphanProof.artifactId,
            orphanSourceRunId: orphanProof.runId,
          }),
      ...(expiryProof === undefined
        ? {}
        : {
            fixtureBoundary: "manifest-expiry-denial",
            expiryArtifactId: expiryProof.artifactId,
            expirySourceRunId: expiryProof.runId,
            manifestExpiresAt: expiryProof.expiry.expiresAt,
            expirySourceCandidateSha: expiryProof.candidateSha,
            expirySourceHarnessSha: expiryProof.harnessSha,
          }),
    }) + "\n",
  );
}

async function verify(env, directory) {
  const expected = JSON.parse(await boundedFile(join(directory, "expected.json"), 8 * 1024));
  const current = identity(env);
  for (const key of [
    "requestedPhase",
    "sessionMode",
    "expectedFailure",
    "runId",
    "runAttempt",
    "repository",
    "candidateSha",
    "harnessSha",
    "dshMode",
    "keyHash",
    "runTitle",
    "fixtureKind",
    "fixtureSourceRunId",
  ])
    requireCheck(expected[key] === current[key], "CURRENT_BINDING");
  let result;
  try {
    result = JSON.parse(env.RESULT_JSON ?? "");
  } catch {
    /* A missing output is never a passing result. */
  }
  const reader = githubReader(env);
  const isFailureProof = expected.expectedFailure !== "none";
  const checks = isFailureProof
    ? failureChecks(result, expected, env.ACTION_OUTCOME)
    : resultChecks(result, expected);
  if (!isFailureProof) checks.actionOutcome = env.ACTION_OUTCOME === "success";
  let checkpoint;
  let archiveError;
  if (!isFailureProof && checks.checkpoint) {
    try {
      const receipt = reader.json(
        `repos/${current.repository}/actions/artifacts/${result.session.artifactId}`,
      );
      requireCheck(
        receipt.id === result.session.artifactId &&
          receipt.name === result.session.artifactName &&
          receipt.workflow_run?.id === current.runId &&
          receipt.workflow_run?.head_sha === current.harnessSha &&
          !receipt.expired &&
          receipt.size_in_bytes <= MAX_ARCHIVE,
        "CURRENT_ARTIFACT",
      );
      const archive = reader.archive(
        `repos/${current.repository}/actions/artifacts/${receipt.id}/zip`,
      );
      checkpoint = inspectCheckpointArchive(archive, {
        ...expected,
        sessionId: result.session.sessionId,
        payloadSha256: result.session.payloadSha256,
        generation: expected.generation,
        permissionMode: expected.phase === "save" ? "workspace-write" : "read-only",
      });
      if (expected.phase === "resume") {
        const prior = unzipSync(
          await boundedFile(join(directory, "source-checkpoint.zip"), MAX_ARCHIVE),
        )["session.jsonl"];
        requireCheck(
          checkpoint.payload.subarray(0, prior.length).equals(Buffer.from(prior)),
          "LOSSLESS_PREFIX",
        );
      }
      checks.rawCheckpoint = true;
      await writeFile(join(directory, "current-checkpoint.zip"), archive, { mode: 0o600 });
    } catch (error) {
      checks.rawCheckpoint = false;
      archiveError =
        error instanceof Error && /^SESSION_E2E_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "SESSION_E2E_ARCHIVE_INVALID";
    }
  } else if (!isFailureProof) checks.rawCheckpoint = false;
  const qualified = Object.values(checks).every((value) => value === true);
  const evidence = {
    schemaVersion: 1,
    qualified,
    ...current,
    phase: expected.phase,
    sourceRunId: expected.sourceRunId,
    expectedFailure: expected.expectedFailure,
    actionOutcome: outcome(env.ACTION_OUTCOME),
    errorCode: /^[A-Z][A-Z0-9_]{0,79}$/u.test(result?.error?.code ?? "") ? result.error.code : null,
    checks,
    fixtureRequests: reader.audit,
    ...(expected.manifestExpiryVerified === true
      ? {
          fixtureBoundary: "manifest-expiry-denial",
          expiryArtifactId: expected.expiryArtifactId,
          expirySourceRunId: expected.expirySourceRunId,
          manifestExpiresAt: expected.manifestExpiresAt,
          expirySourceCandidateSha: expected.expirySourceCandidateSha,
          expirySourceHarnessSha: expected.expirySourceHarnessSha,
        }
      : {}),
    ...(archiveError === undefined ? {} : { archiveError }),
    ...(checkpoint === undefined
      ? {}
      : {
          sessionId: result.session.sessionId,
          artifactId: result.session.artifactId,
          artifactName: result.session.artifactName,
          payloadSha256: checkpoint.payloadSha256,
          archiveSha256: checkpoint.archiveSha256,
          manifestSha256: checkpoint.manifestSha256,
          eventCount: checkpoint.eventCount,
          generation: checkpoint.generation,
        }),
  };
  await writeFile(
    join(directory, "evidence", "qualification.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  if (qualified && !isFailureProof)
    await writeFile(
      join(directory, "proof", "proof.json"),
      JSON.stringify({ ...evidence, memory: expected.memory, challenge: expected.challenge }) +
        "\n",
    );
  process.stdout.write(JSON.stringify(evidence) + "\n");
  requireCheck(qualified, "QUALIFICATION_FAILED");
}

async function main() {
  const directory = resolve(process.env.RUNNER_TEMP ?? "", "session-e2e");
  const outside = relative(resolve(process.env.GITHUB_WORKSPACE ?? directory), directory);
  requireCheck(
    isAbsolute(process.env.RUNNER_TEMP ?? "") &&
      (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)),
    "OUTSIDE_WORKER",
  );
  await mkdir(join(directory, "evidence"), { recursive: true, mode: 0o700 });
  await mkdir(join(directory, "proof"), { recursive: true, mode: 0o700 });
  if (process.argv[2] === "prepare") await prepare(process.env, directory);
  else if (process.argv[2] === "verify") await verify(process.env, directory);
  else throw new Error("SESSION_E2E_COMMAND");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (error) => {
    const diagnostic =
      error instanceof Error && /^SESSION_E2E_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "SESSION_E2E_FIXTURE_FAILED";
    process.stderr.write(diagnostic + "\n");
    process.exitCode = 1;
    // Failed preparation still leaves safe evidence; never retain error bodies or authentication.
    if (isAbsolute(process.env.RUNNER_TEMP ?? "")) {
      const directory = join(process.env.RUNNER_TEMP, "session-e2e", "evidence");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        join(directory, "fixture-failure.json"),
        JSON.stringify({ qualified: false, diagnostic }) + "\n",
      );
    }
  });
}
