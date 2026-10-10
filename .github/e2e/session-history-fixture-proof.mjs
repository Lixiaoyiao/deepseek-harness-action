import { createHash } from "node:crypto";
import { z } from "zod";

const hex64 = /^[a-f0-9]{64}$/u;
const sha = z.string().regex(hex64);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const count = z.number().int().positive();
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
  kind: z.enum(["corrupt", "orphan"]),
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
