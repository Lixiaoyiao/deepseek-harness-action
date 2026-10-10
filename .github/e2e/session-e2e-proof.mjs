import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { unzipSync } from "fflate";

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
    proof?.schemaVersion === 1 && proof?.qualified === true && proof?.phase === "save",
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
      manifest.workflow.path === ".github/workflows/session-e2e.yml" &&
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
      session?.mode === expected.phase &&
      session?.status === "saved" &&
      session?.generation === (expected.phase === "save" ? 1 : 2) &&
      positive(session?.artifactId) &&
      HEX64.test(session?.payloadSha256) &&
      SESSION.test(session?.sessionId),
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
    phase: env.PHASE,
    repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    candidateSha: env.CANDIDATE_SHA,
    harnessSha: env.HARNESS_SHA,
    dshMode: env.DSH_MODE,
    sourceRunId: env.SOURCE_RUN_ID === "" ? undefined : Number(env.SOURCE_RUN_ID),
    keyHash: digest(env.SESSION_KEY ?? ""),
  };
  requireCheck(
    ["save", "resume"].includes(value.phase) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.repository) &&
      positive(value.runId) &&
      positive(value.runAttempt) &&
      HEX40.test(value.candidateSha) &&
      HEX40.test(value.harnessSha) &&
      ["controlled", "native"].includes(value.dshMode) &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(env.SESSION_KEY ?? "") &&
      (value.phase === "save"
        ? value.sourceRunId === undefined
        : positive(value.sourceRunId) && value.sourceRunId !== value.runId),
    "IDENTITY",
  );
  return value;
}

// Fixture/qualification reads use this job's GITHUB_TOKEN. Model credentials stay in the Action.
function githubReader(env) {
  const audit = { credentialScope: "session-e2e-fixture-job-token", apiCommands: 0, retries: 0 };
  const read = (path, maximum = 1024 * 1024) => {
    requireCheck(audit.apiCommands < 8, "REQUEST_BUDGET");
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
  let parent;
  if (current.phase === "resume") {
    const run = reader.json(`repos/${current.repository}/actions/runs/${current.sourceRunId}`);
    requireCheck(
      run.id === current.sourceRunId &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.event === "workflow_dispatch" &&
        run.path === ".github/workflows/session-e2e.yml" &&
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
      generation: 1,
      permissionMode: "workspace-write",
    });
    await writeFile(join(directory, "source-checkpoint.zip"), archive);
  }
  const memory = parent?.memory ?? randomBytes(24).toString("hex");
  const challenge = randomBytes(12).toString("hex");
  // These validated hex oracle values stay intact in same-job outputs, but are masked in logs.
  process.stdout.write(`::add-mask::${memory}\n::add-mask::${challenge}\n`);
  const expected = {
    ...current,
    memory,
    challenge,
    ...(parent === undefined
      ? {}
      : { sessionId: parent.sessionId, payloadSha256: parent.payloadSha256 }),
  };
  await writeFile(join(directory, "expected.json"), JSON.stringify(expected) + "\n", {
    mode: 0o600,
  });
  const task = buildSessionTask(current.phase, challenge, memory);
  const delimiter = `session_task_${randomBytes(16).toString("hex")}`;
  await appendFile(
    env.GITHUB_OUTPUT,
    `prompt<<${delimiter}\n${task.prompt}\n${delimiter}\nschema=${task.schema}\n`,
  );
  await writeFile(
    join(directory, "evidence", "preparation.json"),
    JSON.stringify({
      phase: current.phase,
      runId: current.runId,
      sourceRunId: current.sourceRunId,
      fixtureRequests: reader.audit,
    }) + "\n",
  );
}

async function verify(env, directory) {
  const expected = JSON.parse(await boundedFile(join(directory, "expected.json"), 8 * 1024));
  const current = identity(env);
  for (const key of [
    "phase",
    "runId",
    "runAttempt",
    "repository",
    "candidateSha",
    "harnessSha",
    "dshMode",
    "keyHash",
    "sourceRunId",
  ])
    requireCheck(expected[key] === current[key], "CURRENT_BINDING");
  let result;
  try {
    result = JSON.parse(env.RESULT_JSON ?? "");
  } catch {
    /* A missing output is never a passing result. */
  }
  const reader = githubReader(env);
  const checks = resultChecks(result, expected);
  checks.actionOutcome = env.ACTION_OUTCOME === "success";
  let checkpoint;
  let archiveError;
  if (checks.checkpoint) {
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
        generation: current.phase === "save" ? 1 : 2,
        permissionMode: current.phase === "save" ? "workspace-write" : "read-only",
      });
      if (current.phase === "resume") {
        const prior = unzipSync(
          await boundedFile(join(directory, "source-checkpoint.zip"), MAX_ARCHIVE),
        )["session.jsonl"];
        requireCheck(
          checkpoint.payload.subarray(0, prior.length).equals(Buffer.from(prior)),
          "LOSSLESS_PREFIX",
        );
      }
      checks.rawCheckpoint = true;
    } catch (error) {
      checks.rawCheckpoint = false;
      archiveError =
        error instanceof Error && /^SESSION_E2E_[A-Z_]+$/u.test(error.message)
          ? error.message
          : "SESSION_E2E_ARCHIVE_INVALID";
    }
  } else checks.rawCheckpoint = false;
  const qualified = Object.values(checks).every((value) => value === true);
  const evidence = {
    schemaVersion: 1,
    qualified,
    ...current,
    actionOutcome: outcome(env.ACTION_OUTCOME),
    errorCode: /^[A-Z][A-Z0-9_]{0,79}$/u.test(result?.error?.code ?? "") ? result.error.code : null,
    checks,
    fixtureRequests: reader.audit,
    ...(archiveError === undefined ? {} : { archiveError }),
    ...(checkpoint === undefined
      ? {}
      : {
          sessionId: result.session.sessionId,
          artifactId: result.session.artifactId,
          payloadSha256: checkpoint.payloadSha256,
          archiveSha256: checkpoint.archiveSha256,
          eventCount: checkpoint.eventCount,
          generation: checkpoint.generation,
        }),
  };
  await writeFile(
    join(directory, "evidence", "qualification.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );
  if (qualified)
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
