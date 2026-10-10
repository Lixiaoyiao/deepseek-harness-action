import { createHash } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { unzipSync } from "fflate";
import { z } from "zod";

const hex64 = /^[a-f0-9]{64}$/u;
const sha = z.string().regex(hex64);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const count = z.number().int().positive();
export const historicalHarnessPaths = Object.freeze([
  ".github/workflows/session-auto-e2e.yml",
  ".github/e2e/session-auto-e2e-proof.mjs",
  ".github/e2e/session-history-fixture.mjs",
  ".github/e2e/session-history-fixture-proof.mjs",
  ".github/e2e/session-history-fixture-action/action.yml",
]);
function assertHistoricalHarness(sourceHarness, sourceSha) {
  const commit = sourceHarness?.commit;
  const tree = sourceHarness?.tree;
  if (
    commit?.sha !== sourceSha ||
    !/^[a-f0-9]{40}$/u.test(commit.tree?.sha ?? "") ||
    tree?.sha !== commit.tree.sha ||
    tree.truncated !== false ||
    !Array.isArray(tree.tree)
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_HARNESS");
  for (const path of historicalHarnessPaths) {
    const bytes = sourceHarness.files?.[path];
    const entries = tree.tree.filter((entry) => entry.path === path);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length === 0 ||
      entries.length !== 1 ||
      entries[0].type !== "blob" ||
      !["100644", "100755"].includes(entries[0].mode) ||
      entries[0].sha !==
        createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")
    )
      throw new Error("SESSION_FIXTURE_EXPIRY_HARNESS");
  }
}
const bindingSchema = z.strictObject({
  repository: z.strictObject({ id: count, owner: z.string().min(1), repo: z.string().min(1) }),
  workflow: z.strictObject({
    path: z.literal(".github/workflows/session-auto-e2e.yml"),
    jobId: z.literal("session"),
    jobName: z.literal("session"),
  }),
  task: z.strictObject({ kind: z.literal("automation"), identity: z.string().min(1).max(256) }),
  runtime: z.strictObject({
    dshVersion: z.literal("0.2.0-rc.2"),
    mode: z.enum(["controlled", "native"]),
    compositionId: z.string().min(1).max(128),
    containerImage: z.string().min(1).max(512),
    extensionDigest: sha,
  }),
  keyHash: sha,
});
const proofSchema = z.strictObject({
  schemaVersion: z.literal(1),
  seeded: z.literal(true),
  kind: z.enum(["corrupt", "orphan", "expired"]),
  repository: z.string().min(1),
  runId: count,
  runAttempt: count.max(1000),
  candidateSha: z.string().regex(/^[a-f0-9]{40}$/u),
  harnessSha: z.string().regex(/^[a-f0-9]{40}$/u),
  dshMode: z.enum(["controlled", "native"]),
  sourceKeyHash: sha,
  targetKeyHash: sha,
  sourceArtifactId: count,
  sourceArtifactName: z.string().min(1),
  sourceArchiveSha256: sha,
  artifactId: count,
  artifactName: z.string().min(1),
  archiveSha256: sha,
  generation: count.max(1_000_000),
  binding: bindingSchema,
  expiry: z
    .strictObject({
      createdAt: z.iso.datetime(),
      sourceExpiresAt: z.iso.datetime(),
      expiresAt: z.iso.datetime(),
      preparedAt: z.iso.datetime(),
    })
    .optional(),
});
export function fixtureKeyHash(value) {
  if (!key.safeParse(value).success) throw new Error("SESSION_FIXTURE_KEY");
  return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

/** Independently reproduce the documented full binding, never a shortened artifact prefix. */
export function fixtureCheckpointName(value, runAttempt, generation) {
  const parsed = bindingSchema.safeParse(value);
  if (
    !parsed.success ||
    !count.max(1000).safeParse(runAttempt).success ||
    !count.max(1_000_000).safeParse(generation).success
  )
    throw new Error("SESSION_FIXTURE_BINDING");
  const binding = parsed.data;
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        repository: [binding.repository.id, binding.repository.owner, binding.repository.repo],
        workflow: [binding.workflow.path, binding.workflow.jobId, binding.workflow.jobName],
        task: [binding.task.kind, binding.task.identity],
        runtime: [
          binding.runtime.dshVersion,
          binding.runtime.mode,
          binding.runtime.compositionId,
          binding.runtime.containerImage,
          binding.runtime.extensionDigest,
        ],
        keyHash: binding.keyHash,
      }),
    )
    .digest("hex");
  return `dsh-session-${binding.keyHash}-${hash}-g${generation}-a${runAttempt}`;
}

/** Receipt proves a diagnostic artifact's origin; it never certifies the consumer Action. */
export function assertOrphanFixtureProof(value, expected) {
  if (fixtureKeyHash(expected.targetKey ?? "") !== expected.targetKeyHash)
    throw new Error("SESSION_FIXTURE_ORPHAN_KEY");
  const parsed = proofSchema.safeParse(value);
  if (!parsed.success) throw new Error("SESSION_FIXTURE_PROOF");
  const proof = parsed.data;
  for (const field of [
    "repository",
    "runId",
    "runAttempt",
    "candidateSha",
    "harnessSha",
    "dshMode",
    "targetKeyHash",
  ])
    if (proof[field] !== expected[field]) throw new Error("SESSION_FIXTURE_PROOF_BINDING");
  if (
    proof.kind !== "orphan" ||
    proof.expiry !== undefined ||
    proof.sourceKeyHash === proof.targetKeyHash ||
    proof.binding.keyHash !== proof.targetKeyHash ||
    proof.binding.runtime.mode !== proof.dshMode ||
    `${proof.binding.repository.owner}/${proof.binding.repository.repo}` !== proof.repository ||
    proof.binding.task.identity !== `task:${expected.targetKey.toLowerCase()}` ||
    proof.artifactName !== fixtureCheckpointName(proof.binding, proof.runAttempt, proof.generation)
  )
    throw new Error("SESSION_FIXTURE_ORPHAN_BINDING");
  return proof;
}

/** Prove a legal manifest aged across real time; a retained artifact never proves artifact.expired. */
export function assertExpiredFixtureProvenance({
  receipt,
  sourceProof,
  sourceRun,
  artifact,
  current,
  history,
  archive,
  sourceHarness,
}) {
  const parsed = proofSchema.safeParse(receipt);
  if (!parsed.success) throw new Error("SESSION_FIXTURE_PROOF");
  const proof = parsed.data;
  const expiry = proof.expiry;
  for (const field of ["repository", "runId", "runAttempt", "dshMode", "targetKeyHash"])
    if (proof[field] !== current[field]) throw new Error("SESSION_FIXTURE_EXPIRY_BINDING");
  if (
    proof.kind !== "expired" ||
    expiry === undefined ||
    proof.runAttempt !== 1 ||
    proof.generation !== 1 ||
    fixtureKeyHash(current.targetKey ?? "") !== proof.targetKeyHash ||
    proof.sourceKeyHash !== proof.targetKeyHash ||
    proof.binding.keyHash !== proof.targetKeyHash ||
    proof.binding.runtime.mode !== proof.dshMode ||
    `${proof.binding.repository.owner}/${proof.binding.repository.repo}` !== proof.repository ||
    proof.binding.task.identity !== `task:${current.targetKey.toLowerCase()}` ||
    proof.sourceArtifactName !== proof.artifactName ||
    proof.sourceArtifactId === proof.artifactId ||
    fixtureCheckpointName(proof.binding, proof.runAttempt, proof.generation) !== proof.artifactName
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_BINDING");
  if (
    history.status !== "success" ||
    history.source?.id !== proof.runId ||
    sourceRun.id !== proof.runId ||
    sourceRun.id >= current.currentRunId ||
    sourceRun.run_attempt !== proof.runAttempt ||
    sourceRun.status !== "completed" ||
    sourceRun.conclusion !== "success" ||
    sourceRun.event !== "workflow_dispatch" ||
    sourceRun.path !== proof.binding.workflow.path ||
    sourceRun.head_sha !== proof.harnessSha ||
    sourceRun.head_branch !== current.defaultBranch ||
    sourceRun.repository?.full_name !== proof.repository ||
    sourceRun.head_repository?.full_name !== proof.repository ||
    sourceRun.repository?.id !== proof.binding.repository.id ||
    sourceRun.head_repository?.id !== proof.binding.repository.id ||
    sourceRun.display_title?.toLowerCase() !== `dsh-session-${current.targetKey.toLowerCase()}`
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_SOURCE");
  if (proof.harnessSha !== current.harnessSha)
    assertHistoricalHarness(sourceHarness, proof.harnessSha);
  if (
    sourceProof?.schemaVersion !== 1 ||
    sourceProof.qualified !== true ||
    sourceProof.phase !== "save" ||
    sourceProof.generation !== proof.generation ||
    sourceProof.artifactId !== proof.sourceArtifactId ||
    sourceProof.artifactName !== proof.sourceArtifactName ||
    sourceProof.archiveSha256 !== proof.sourceArchiveSha256 ||
    sourceProof.keyHash !== proof.sourceKeyHash ||
    !hex64.test(sourceProof.manifestSha256 ?? "")
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_QUALIFICATION");
  for (const field of [
    "repository",
    "runId",
    "runAttempt",
    "candidateSha",
    "harnessSha",
    "dshMode",
  ])
    if (sourceProof[field] !== proof[field])
      throw new Error("SESSION_FIXTURE_EXPIRY_QUALIFICATION");
  const created = Date.parse(expiry.createdAt);
  const expires = Date.parse(expiry.expiresAt);
  const prepared = Date.parse(expiry.preparedAt);
  const originalExpiry = Date.parse(expiry.sourceExpiresAt);
  const now = Date.now();
  const runCreated = Date.parse(sourceRun.created_at);
  const runUpdated = Date.parse(sourceRun.updated_at);
  if (
    expires - created !== 86400_000 ||
    expires >= now ||
    created > prepared + 60_000 ||
    prepared >= expires ||
    originalExpiry <= prepared ||
    originalExpiry - created < 86400_000 ||
    originalExpiry - created > 7 * 86400_000 ||
    !Number.isFinite(runCreated) ||
    !Number.isFinite(runUpdated) ||
    runUpdated < runCreated ||
    created < runCreated - 60_000 ||
    created > runUpdated + 60_000 ||
    prepared < runCreated - 60_000 ||
    prepared > runUpdated + 60_000
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_WINDOW");
  const artifactCreated = Date.parse(artifact?.created_at);
  const artifactExpires = Date.parse(artifact?.expires_at);
  if (
    artifact?.id !== proof.artifactId ||
    artifact.name !== proof.artifactName ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes !== archive.length ||
    archive.length < 22 ||
    archive.length > 4 * 1024 * 1024 + 64 * 1024 ||
    artifact.digest !== `sha256:${proof.archiveSha256}` ||
    createHash("sha256").update(archive).digest("hex") !== proof.archiveSha256 ||
    artifact.workflow_run?.id !== proof.runId ||
    artifact.workflow_run?.head_sha !== proof.harnessSha ||
    artifact.workflow_run?.repository_id !== proof.binding.repository.id ||
    artifact.workflow_run?.head_repository_id !== proof.binding.repository.id ||
    !Number.isFinite(artifactCreated) ||
    !Number.isFinite(artifactExpires) ||
    artifactExpires <= now ||
    artifactCreated < runCreated - 60_000 ||
    artifactCreated > runUpdated + 60_000 ||
    Math.abs(artifactCreated - created) > 30 * 60_000 ||
    expires > artifactExpires + 60_000 ||
    artifactExpires + 60_000 < artifactCreated + 3 * 86400_000
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_ARTIFACT");
  const names = [];
  const files = unzipSync(archive, {
    filter: (entry) => {
      names.push(entry.name);
      return (
        (entry.name === "manifest.json" && entry.originalSize <= 16 * 1024) ||
        (entry.name === "session.jsonl" && entry.originalSize <= 4 * 1024 * 1024)
      );
    },
  });
  if (names.length !== 2 || !files["manifest.json"]?.length || !files["session.jsonl"]?.length)
    throw new Error("SESSION_FIXTURE_EXPIRY_ARCHIVE");
  const manifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(files["manifest.json"]),
  );
  const restoredOriginal = { ...manifest, expiresAt: expiry.sourceExpiresAt };
  if (
    manifest.createdAt !== expiry.createdAt ||
    manifest.expiresAt !== expiry.expiresAt ||
    createHash("sha256").update(JSON.stringify(restoredOriginal)).digest("hex") !==
      sourceProof.manifestSha256 ||
    createHash("sha256").update(files["session.jsonl"]).digest("hex") !==
      sourceProof.payloadSha256 ||
    manifest.payload?.sha256 !== sourceProof.payloadSha256 ||
    manifest.payload?.bytes !== files["session.jsonl"].length ||
    manifest.session?.sessionId !== sourceProof.sessionId ||
    manifest.session?.generation !== proof.generation ||
    manifest.session?.keyHash !== proof.targetKeyHash ||
    !isDeepStrictEqual(manifest.repository, proof.binding.repository) ||
    !isDeepStrictEqual(manifest.task, proof.binding.task) ||
    !isDeepStrictEqual(manifest.runtime, proof.binding.runtime) ||
    manifest.workflow?.runId !== proof.runId ||
    manifest.workflow?.runAttempt !== proof.runAttempt ||
    manifest.workflow?.sourceSha !== proof.harnessSha ||
    manifest.workflow?.path !== proof.binding.workflow.path ||
    manifest.workflow?.jobId !== proof.binding.workflow.jobId ||
    manifest.workflow?.jobName !== proof.binding.workflow.jobName ||
    manifest.issuer?.actorId !== sourceRun.actor?.id ||
    manifest.issuer?.actorLogin !== sourceRun.actor?.login
  )
    throw new Error("SESSION_FIXTURE_EXPIRY_ARCHIVE");
  return proof;
}

/** Cross-check the real REST origin and independent successful Action proof before allowing this oracle case. */
export function assertOrphanFixtureProvenance({
  receipt,
  sourceProof,
  sourceRun,
  artifact,
  current,
  history,
}) {
  const proof = assertOrphanFixtureProof(receipt, current);
  if (
    history.status !== "first" ||
    history.source !== undefined ||
    sourceRun.id !== proof.runId ||
    sourceRun.id >= current.currentRunId ||
    sourceRun.run_attempt !== proof.runAttempt ||
    sourceRun.status !== "completed" ||
    sourceRun.conclusion !== "success" ||
    sourceRun.event !== "workflow_dispatch" ||
    sourceRun.path !== ".github/workflows/session-auto-e2e.yml" ||
    sourceRun.head_sha !== proof.harnessSha ||
    sourceRun.head_branch !== current.defaultBranch ||
    sourceRun.repository?.full_name !== proof.repository ||
    sourceRun.head_repository?.full_name !== proof.repository ||
    sourceRun.repository?.id !== proof.binding.repository.id ||
    sourceRun.head_repository?.id !== proof.binding.repository.id ||
    !/^dsh-session-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(sourceRun.display_title ?? "") ||
    sourceRun.display_title.toLowerCase() === `dsh-session-${current.targetKey.toLowerCase()}` ||
    fixtureKeyHash(sourceRun.display_title.slice("dsh-session-".length)) !== proof.sourceKeyHash
  )
    throw new Error("SESSION_FIXTURE_ORPHAN_SOURCE");
  if (
    sourceProof?.schemaVersion !== 1 ||
    sourceProof.qualified !== true ||
    sourceProof.phase !== "save" ||
    sourceProof.generation !== proof.generation ||
    sourceProof.artifactId !== proof.sourceArtifactId ||
    sourceProof.artifactName !== proof.sourceArtifactName ||
    sourceProof.archiveSha256 !== proof.sourceArchiveSha256 ||
    sourceProof.keyHash !== proof.sourceKeyHash
  )
    throw new Error("SESSION_FIXTURE_ORPHAN_QUALIFICATION");
  for (const field of [
    "repository",
    "runId",
    "runAttempt",
    "candidateSha",
    "harnessSha",
    "dshMode",
  ])
    if (sourceProof[field] !== proof[field])
      throw new Error("SESSION_FIXTURE_ORPHAN_QUALIFICATION");
  if (
    artifact?.id !== proof.artifactId ||
    artifact.name !== proof.artifactName ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > 4 * 1024 * 1024 + 64 * 1024 ||
    !Number.isFinite(Date.parse(artifact.created_at)) ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    Date.parse(artifact.expires_at) <= Date.now() ||
    artifact.digest !== `sha256:${proof.archiveSha256}` ||
    artifact.workflow_run?.id !== proof.runId ||
    artifact.workflow_run?.head_sha !== proof.harnessSha ||
    artifact.workflow_run?.repository_id !== proof.binding.repository.id ||
    artifact.workflow_run?.head_repository_id !== proof.binding.repository.id
  )
    throw new Error("SESSION_FIXTURE_ORPHAN_ARTIFACT");
  return proof;
}
