import { DefaultArtifactClient } from "@actions/artifact";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { unzipSync } from "fflate";
import {
  assertSourceProof,
  inspectCheckpointArchive,
  resultChecks,
} from "./session-auto-e2e-proof.mjs";
import { fixtureCheckpointName, fixtureKeyHash } from "./session-history-fixture-proof.mjs";

const MAX_ARCHIVE = 4 * 1024 * 1024 + 64 * 1024;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const sha = (value) => /^[a-f0-9]{64}$/u.test(value ?? "");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function check(condition, code) {
  if (!condition) throw new Error(`SESSION_FIXTURE_${code}`);
}
async function localFile(path, maximum) {
  const metadata = await lstat(path);
  check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.size <= maximum, "LOCAL_FILE");
  const bytes = await readFile(path);
  check(bytes.length <= maximum, "LOCAL_FILE");
  return bytes;
}
function currentIdentity(env) {
  const current = {
    repository: env.GITHUB_REPOSITORY,
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    candidateSha: env.CANDIDATE_SHA,
    harnessSha: env.HARNESS_SHA,
    dshMode: env.DSH_MODE,
    keyHash: fixtureKeyHash(env.SESSION_KEY ?? ""),
  };
  check(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(current.repository ?? "") &&
      positive(current.runId) &&
      current.runAttempt === 1 &&
      /^[a-f0-9]{40}$/u.test(current.candidateSha ?? "") &&
      /^[a-f0-9]{40}$/u.test(current.harnessSha ?? "") &&
      ["controlled", "native"].includes(current.dshMode) &&
      env.GITHUB_JOB === "session" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === `refs/heads/${env.DEFAULT_BRANCH}` &&
      env.GITHUB_SHA === current.harnessSha &&
      env.GITHUB_WORKFLOW_SHA === current.harnessSha &&
      env.GITHUB_WORKFLOW_REF ===
        `${current.repository}/.github/workflows/session-auto-e2e.yml@refs/heads/${env.DEFAULT_BRANCH}`,
    "CURRENT_BINDING",
  );
  return current;
}
function assertFixtureDirectory(env, directory) {
  const outside = relative(resolve(env.GITHUB_WORKSPACE ?? directory), directory);
  check(
    isAbsolute(env.RUNNER_TEMP ?? "") &&
      isAbsolute(env.GITHUB_WORKSPACE ?? "") &&
      directory === resolve(env.RUNNER_TEMP, "session-e2e") &&
      (outside === ".." || outside.startsWith(`..${sep}`) || isAbsolute(outside)),
    "OUTSIDE_WORKER",
  );
}

/** One current-job SDK adapter owns validation, exact checkpoint replacement and safe receipt publication. */
export async function seedSessionHistoryFixture({ env, directory, artifactClient }) {
  assertFixtureDirectory(env, directory);
  const current = currentIdentity(env);
  check(
    env.ACTION_OUTCOME === "success" &&
      env.EXPECTED_FAILURE === "none" &&
      ["corrupt", "orphan", "expired"].includes(env.FIXTURE_KIND),
    "SUCCESSFUL_ACTION_REQUIRED",
  );
  const proof = assertSourceProof(
    JSON.parse(await localFile(join(directory, "proof", "proof.json"), 8 * 1024)),
    current,
  );
  check(
    proof.phase === "save" && proof.generation === 1 && sha(proof.archiveSha256),
    "FRESH_PRODUCER_REQUIRED",
  );
  const result = JSON.parse(env.RESULT_JSON ?? "");
  check(
    Object.values(resultChecks(result, { ...proof, sessionMode: "auto" })).every(Boolean) &&
      result.session.artifactId === proof.artifactId &&
      result.session.artifactName === proof.artifactName &&
      result.session.sessionId === proof.sessionId &&
      result.session.payloadSha256 === proof.payloadSha256,
    "QUALIFIED_RESULT_BINDING",
  );
  const archive = await localFile(join(directory, "current-checkpoint.zip"), MAX_ARCHIVE);
  check(digest(archive) === proof.archiveSha256, "QUALIFIED_ARCHIVE");
  const inspected = inspectCheckpointArchive(archive, {
    ...proof,
    permissionMode: "workspace-write",
  });
  const files = unzipSync(archive);
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(files["manifest.json"]),
  );
  const sourceBinding = {
    repository: manifest.repository,
    workflow: {
      path: manifest.workflow.path,
      jobId: manifest.workflow.jobId,
      jobName: manifest.workflow.jobName,
    },
    task: manifest.task,
    runtime: manifest.runtime,
    keyHash: manifest.session.keyHash,
  };
  check(
    sourceBinding.repository.id === Number(env.GITHUB_REPOSITORY_ID) &&
      manifest.issuer.actorId === Number(env.GITHUB_ACTOR_ID) &&
      manifest.issuer.actorLogin === env.GITHUB_ACTOR &&
      sourceBinding.task.kind === "automation" &&
      sourceBinding.task.identity === `task:${env.SESSION_KEY.toLowerCase()}` &&
      fixtureCheckpointName(sourceBinding, current.runAttempt, proof.generation) ===
        proof.artifactName,
    "SOURCE_CHECKPOINT_NAME",
  );
  const targetKey = env.FIXTURE_TARGET_KEY ?? "";
  check(
    env.FIXTURE_KIND === "orphan"
      ? fixtureKeyHash(targetKey) !== current.keyHash
      : targetKey === "",
    "TARGET_KEY",
  );
  const binding =
    env.FIXTURE_KIND === "orphan"
      ? {
          ...sourceBinding,
          keyHash: fixtureKeyHash(targetKey),
          task: { kind: "automation", identity: `task:${targetKey.toLowerCase()}` },
        }
      : sourceBinding;
  const artifactName = fixtureCheckpointName(binding, current.runAttempt, proof.generation);
  let expiry;
  if (env.FIXTURE_KIND === "expired") {
    const created = Date.parse(manifest.createdAt);
    const originalExpiry = Date.parse(manifest.expiresAt);
    const prepared = Date.now();
    const expires = created + 86400_000;
    check(
      Number.isFinite(created) &&
        Number.isFinite(originalExpiry) &&
        created <= prepared + 60_000 &&
        originalExpiry > prepared &&
        originalExpiry - created >= 86400_000 &&
        originalExpiry - created <= 7 * 86400_000 &&
        expires > prepared &&
        proof.manifestSha256 === digest(JSON.stringify(manifest)),
      "EXPIRY_VALID_WINDOW",
    );
    expiry = {
      createdAt: manifest.createdAt,
      sourceExpiresAt: manifest.expiresAt,
      expiresAt: new Date(expires).toISOString(),
      preparedAt: new Date(prepared).toISOString(),
    };
  }
  const own = (await artifactClient.getArtifact(proof.artifactName)).artifact;
  check(
    own.id === proof.artifactId &&
      own.name === proof.artifactName &&
      own.size === archive.length &&
      (own.digest === undefined || own.digest.replace(/^sha256:/u, "") === proof.archiveSha256),
    "OWN_ARTIFACT",
  );
  const outputDirectory = join(directory, "fixture", "checkpoint");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const content =
    env.FIXTURE_KIND === "corrupt"
      ? {
          "manifest.json": Buffer.from(
            '{"fixture":"intentionally-malformed-session-checkpoint"}\n',
          ),
          "session.jsonl": Buffer.from("intentionally-invalid-diagnostic-session\n"),
        }
      : {
          "manifest.json": Buffer.from(
            JSON.stringify({
              ...manifest,
              ...(expiry === undefined
                ? { task: binding.task, session: { ...manifest.session, keyHash: binding.keyHash } }
                : { expiresAt: expiry.expiresAt }),
            }) + "\n",
          ),
          "session.jsonl": inspected.payload,
        };
  const paths = [];
  for (const [name, bytes] of Object.entries(content)) {
    const path = join(outputDirectory, name);
    await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
    paths.push(path);
  }
  if (["corrupt", "expired"].includes(env.FIXTURE_KIND)) {
    if (expiry !== undefined)
      check(Date.now() < Date.parse(expiry.expiresAt), "EXPIRY_VALID_WINDOW");
    const deleted = await artifactClient.deleteArtifact(proof.artifactName);
    check(deleted.id === proof.artifactId, "DELETED_ID");
  }
  const uploaded = await artifactClient.uploadArtifact(artifactName, paths, outputDirectory, {
    retentionDays: 3,
    compressionLevel: 0,
  });
  check(
    positive(uploaded.id) &&
      uploaded.id !== proof.artifactId &&
      positive(uploaded.size) &&
      uploaded.size <= MAX_ARCHIVE &&
      sha(uploaded.digest),
    "UPLOAD_RECEIPT",
  );
  const saved = (await artifactClient.getArtifact(artifactName)).artifact;
  check(
    saved.id === uploaded.id &&
      saved.name === artifactName &&
      saved.size === uploaded.size &&
      (saved.digest === undefined || saved.digest.replace(/^sha256:/u, "") === uploaded.digest),
    "UPLOAD_METADATA",
  );
  const { keyHash: sourceKeyHash, ...runIdentity } = current;
  if (expiry !== undefined) check(Date.now() < Date.parse(expiry.expiresAt), "EXPIRY_VALID_WINDOW");
  const receipt = {
    schemaVersion: 1,
    seeded: true,
    kind: env.FIXTURE_KIND,
    ...runIdentity,
    sourceKeyHash,
    targetKeyHash: binding.keyHash,
    sourceArtifactId: proof.artifactId,
    sourceArtifactName: proof.artifactName,
    sourceArchiveSha256: proof.archiveSha256,
    artifactId: uploaded.id,
    artifactName,
    archiveSha256: uploaded.digest,
    generation: proof.generation,
    binding,
    ...(expiry === undefined ? {} : { expiry }),
  };
  await writeFile(
    join(directory, "fixture", "receipt.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "evidence", "history-fixture.json"),
    JSON.stringify(receipt, null, 2) + "\n",
    { mode: 0o600 },
  );
  return receipt;
}

async function main() {
  const directory = resolve(process.env.RUNNER_TEMP ?? "", "session-e2e");
  const receipt = await seedSessionHistoryFixture({
    env: process.env,
    directory,
    artifactClient: new DefaultArtifactClient(),
  });
  process.stdout.write(JSON.stringify(receipt) + "\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const code =
      error instanceof Error && /^SESSION_(?:FIXTURE|E2E)_[A-Z_]+$/u.test(error.message)
        ? error.message
        : "SESSION_FIXTURE_FAILED";
    process.stderr.write(code + "\n");
    process.exitCode = 1;
  });
}
