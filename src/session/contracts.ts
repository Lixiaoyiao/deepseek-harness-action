import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { z } from "zod";

import { PolicyDeniedError } from "../errors.js";

export const SESSION_PAYLOAD_FILE = "session.jsonl";
export const SESSION_MANIFEST_FILE = "manifest.json";
export const MAX_SESSION_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_MANIFEST_BYTES = 16 * 1024;
export const MAX_SESSION_ARCHIVE_BYTES = MAX_SESSION_PAYLOAD_BYTES + 64 * 1024;
export const SESSION_CONCURRENCY_GROUP = "dsh-session";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
const timestamp = z.iso.datetime();
const repositorySchema = z.strictObject({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  owner: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/u),
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u),
});
const taskSchema = z.strictObject({
  kind: z.enum(["issue", "pull_request", "automation"]),
  identity: z.string().min(1).max(256),
});
const runtimeSchema = z.strictObject({
  dshVersion: z.literal("0.2.1-rc.2"),
  mode: z.enum(["controlled", "native"]),
  compositionId: z.string().min(1).max(128),
  containerImage: z.string().min(1).max(512),
  extensionDigest: sha256,
});
const workflowIdentitySchema = z.strictObject({
  path: z.string().regex(/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u),
  jobId: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u),
  jobName: z.string().min(1).max(128),
});

export const sessionManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  repository: repositorySchema,
  workflow: workflowIdentitySchema.extend({
    sourceSha: commit,
    runId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    runAttempt: z.number().int().min(1).max(1000),
  }),
  task: taskSchema,
  runtime: runtimeSchema,
  issuer: z.strictObject({
    actorId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    actorLogin: z.string().min(1).max(100),
    jobRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  session: z.strictObject({
    keyHash: sha256,
    sessionId: identifier,
    generation: z.number().int().min(1).max(1_000_000),
  }),
  createdAt: timestamp,
  expiresAt: timestamp,
  payload: z.strictObject({
    file: z.literal(SESSION_PAYLOAD_FILE),
    bytes: z.number().int().min(1).max(MAX_SESSION_PAYLOAD_BYTES),
    sha256,
  }),
});

export type SessionManifest = z.infer<typeof sessionManifestSchema>;
export type SessionManifestWithoutPayload = Omit<SessionManifest, "payload">;
export type SessionRepository = SessionManifest["repository"];
export interface SessionBinding {
  readonly repository: SessionRepository;
  readonly workflow: Pick<SessionManifest["workflow"], "path" | "jobId" | "jobName">;
  readonly task: SessionManifest["task"];
  readonly runtime: SessionManifest["runtime"];
  readonly keyHash: string;
}
export interface SessionRunIdentity {
  readonly runId: number;
  readonly runAttempt: number;
  readonly sourceSha: string;
  readonly actorId: number;
  readonly actorLogin: string;
  readonly jobRunId: number;
}
export interface SessionCheckpoint {
  readonly manifest: SessionManifest;
  readonly payload: Uint8Array;
}

export function sessionKeyHash(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(key)) {
    throw new PolicyDeniedError(
      "Session key must be 1-64 ASCII letters, digits, dot, underscore or hyphen",
    );
  }
  return createHash("sha256").update(key).digest("hex");
}

export function sessionBindingHash(binding: SessionBinding): string {
  return createHash("sha256")
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
}

export function sessionArtifactPrefix(binding: SessionBinding): string {
  return `dsh-session-${binding.keyHash}-${sessionBindingHash(binding)}-`;
}

export function sessionArtifactName(
  binding: SessionBinding,
  runAttempt: number,
  generation: number,
): string {
  if (
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > 1000 ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > 1_000_000
  ) {
    throw new PolicyDeniedError("Invalid Session artifact generation or run attempt");
  }
  return `${sessionArtifactPrefix(binding)}g${String(generation)}-a${String(runAttempt)}`;
}

export function sessionClaimName(keyHash: string, runAttempt: number): string {
  if (
    !/^[a-f0-9]{64}$/u.test(keyHash) ||
    !Number.isSafeInteger(runAttempt) ||
    runAttempt < 1 ||
    runAttempt > 1000
  ) {
    throw new PolicyDeniedError("Invalid Session claim key or run attempt");
  }
  return `dsh-session-${keyHash}-a${String(runAttempt)}-claim`;
}

export function parseSessionManifest(value: unknown, now = Date.now()): SessionManifest {
  const parsed = sessionManifestSchema.safeParse(value);
  if (!parsed.success) throw new PolicyDeniedError("Session manifest is malformed or incompatible");
  const manifest = parsed.data;
  const created = Date.parse(manifest.createdAt);
  const expires = Date.parse(manifest.expiresAt);
  if (
    created > now + 60_000 ||
    expires <= now ||
    expires <= created ||
    expires - created < 24 * 60 * 60 * 1000 ||
    expires - created > 7 * 24 * 60 * 60 * 1000
  ) {
    throw new PolicyDeniedError("Session checkpoint is expired or has an invalid retention window");
  }
  return manifest;
}

export function validateSessionManifestBinding(
  manifest: SessionManifest,
  expected: SessionBinding,
  source: SessionRunIdentity,
): void {
  const matches =
    isDeepStrictEqual(manifest.repository, expected.repository) &&
    manifest.workflow.path === expected.workflow.path &&
    manifest.workflow.jobId === expected.workflow.jobId &&
    manifest.workflow.jobName === expected.workflow.jobName &&
    manifest.workflow.runId === source.runId &&
    manifest.workflow.runAttempt === source.runAttempt &&
    manifest.workflow.sourceSha === source.sourceSha &&
    isDeepStrictEqual(manifest.task, expected.task) &&
    isDeepStrictEqual(manifest.runtime, expected.runtime) &&
    manifest.session.keyHash === expected.keyHash &&
    manifest.issuer.actorId === source.actorId &&
    manifest.issuer.actorLogin === source.actorLogin &&
    manifest.issuer.jobRunId === source.jobRunId;
  if (!matches)
    throw new PolicyDeniedError(
      "Session checkpoint provenance or runtime/task binding does not match",
    );
}
