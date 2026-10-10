import { record } from "../security/record.js";
import { DefaultArtifactClient } from "@actions/artifact";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

import { PolicyDeniedError } from "../errors.js";
import type { GitHubClient } from "../github/client.js";
import {
  MAX_SESSION_ARCHIVE_BYTES,
  MAX_SESSION_MANIFEST_BYTES,
  MAX_SESSION_PAYLOAD_BYTES,
  SESSION_MANIFEST_FILE,
  SESSION_PAYLOAD_FILE,
  parseSessionManifest,
  sessionArtifactName,
  sessionArtifactPrefix,
  sessionClaimName,
  validateSessionManifestBinding,
  type SessionBinding,
  type SessionCheckpoint,
  type SessionRunIdentity,
} from "./contracts.js";
import { verifySessionWorkflowRun, type VerifiedSessionWorkflowRun } from "./workflow-policy.js";

function denied(message: string): never {
  throw new PolicyDeniedError(message);
}
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Restricted SDK ZIP format: exactly two regular files; no extraction to runner paths. */
export function decodeSessionArchive(input: Uint8Array, now = Date.now()): SessionCheckpoint {
  const bytes = Buffer.from(input);
  if (bytes.length < 22 || bytes.length > MAX_SESSION_ARCHIVE_BYTES)
    denied("Session artifact archive exceeds its size bound");
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 20) !== 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== 2 ||
    bytes.readUInt16LE(end + 10) !== 2
  )
    denied("Session artifact must be one non-ZIP64 archive with exactly two files");
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (centralStart + centralSize !== end)
    denied("Session ZIP central directory does not match its archive");
  let position = centralStart;
  const files = new Map<string, Buffer>();
  const ranges: { start: number; end: number }[] = [];
  for (let index = 0; index < 2; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50)
      denied("Session ZIP file metadata is invalid");
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const checksum = bytes.readUInt32LE(position + 16);
    const compressed = bytes.readUInt32LE(position + 20);
    const uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const external = bytes.readUInt32LE(position + 38);
    const local = bytes.readUInt32LE(position + 42);
    const next = position + 46 + nameLength + extraLength + commentLength;
    if (
      next > end ||
      flags & ~0x0808 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(position + 34) !== 0 ||
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      local === 0xffffffff
    )
      denied("Session ZIP encryption, split archives or unsupported compression are forbidden");
    const mode = (external >>> 16) & 0xf000;
    if ((mode !== 0 && mode !== 0x8000) || (external & 0x10) !== 0)
      denied("Session ZIP entries must be regular files, never symlinks or directories");
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(position + 46, position + 46 + nameLength),
      );
    } catch {
      denied("Session ZIP filenames must be valid UTF-8");
    }
    if (![SESSION_MANIFEST_FILE, SESSION_PAYLOAD_FILE].includes(name) || files.has(name))
      denied("Session ZIP contains an unexpected or duplicate file");
    const maximum =
      name === SESSION_MANIFEST_FILE ? MAX_SESSION_MANIFEST_BYTES : MAX_SESSION_PAYLOAD_BYTES;
    if (uncompressed < 1 || uncompressed > maximum || compressed > MAX_SESSION_ARCHIVE_BYTES)
      denied("Session ZIP declared file size exceeds its bound");
    if (
      local + 30 > centralStart ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method
    )
      denied("Session ZIP local file header does not match");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (
      dataStart + compressed > centralStart ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(Buffer.from(name))
    )
      denied("Session ZIP local filename or data range does not match");
    let dataEnd = dataStart + compressed;
    if ((flags & 8) !== 0) {
      if (dataEnd + 12 > centralStart) denied("Session ZIP data descriptor is missing");
      if (bytes.readUInt32LE(dataEnd) === 0x08074b50) dataEnd += 4;
      if (
        dataEnd + 12 > centralStart ||
        bytes.readUInt32LE(dataEnd) !== checksum ||
        bytes.readUInt32LE(dataEnd + 4) !== compressed ||
        bytes.readUInt32LE(dataEnd + 8) !== uncompressed
      )
        denied("Session ZIP data descriptor does not match");
      dataEnd += 12;
    } else if (
      bytes.readUInt32LE(local + 14) !== checksum ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== uncompressed
    )
      denied("Session ZIP local size or checksum does not match");
    let content: Buffer;
    try {
      content =
        method === 0
          ? Buffer.from(bytes.subarray(dataStart, dataStart + compressed))
          : inflateRawSync(bytes.subarray(dataStart, dataStart + compressed), {
              maxOutputLength: uncompressed,
            });
    } catch {
      denied("Session ZIP decompression failed or exceeded its declared byte bound");
    }
    if (content.length !== uncompressed || crc32(content) !== checksum)
      denied("Session ZIP file size or checksum is inconsistent");
    files.set(name, content);
    ranges.push({ start: local, end: dataEnd });
    position = next;
  }
  ranges.sort((a, b) => a.start - b.start);
  if (
    position !== end ||
    ranges[0]?.start !== 0 ||
    ranges[0].end !== ranges[1]?.start ||
    ranges[1].end !== centralStart
  )
    denied("Session ZIP contains overlapping or unlisted data entries");
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(files.get(SESSION_MANIFEST_FILE)),
    );
  } catch {
    denied("Session manifest must contain valid UTF-8 JSON");
  }
  const manifest = parseSessionManifest(value, now);
  const payload = files.get(SESSION_PAYLOAD_FILE);
  if (payload?.length !== manifest.payload.bytes || digest(payload) !== manifest.payload.sha256)
    denied("Session payload size or SHA256 differs from its manifest");
  return { manifest, payload };
}

interface ArtifactMetadata {
  readonly id: number;
  readonly name: string;
  readonly size_in_bytes: number;
  readonly expired: boolean;
  readonly created_at: string | null;
  readonly expires_at: string | null;
  readonly digest?: string | null;
  readonly workflow_run?: {
    readonly id?: number;
    readonly repository_id?: number;
    readonly head_repository_id?: number;
    readonly head_sha?: string;
  } | null;
}
export interface SessionArtifactUploader {
  uploadArtifact(
    name: string,
    files: string[],
    rootDirectory: string,
    options: { retentionDays: number; compressionLevel: number },
  ): Promise<{ id?: number; size?: number; digest?: string }>;
}
export interface SessionUploadReceipt {
  readonly kind: "claim" | "checkpoint";
  readonly id: number;
  readonly name: string;
  readonly sha256?: string;
}
export interface PrepareSessionArtifactsOptions {
  readonly client: GitHubClient;
  readonly binding: SessionBinding;
  readonly mode: "auto" | "save" | "resume";
  readonly currentRun: {
    readonly runId: number;
    readonly runAttempt: number;
    readonly workflowSha: string;
    readonly actorLogin: string;
  };
  readonly sourceRunId?: number;
  readonly retentionDays: number;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly authorizeCurrent: () => Promise<void>;
  readonly onUploadReceipt?: (receipt: SessionUploadReceipt) => void;
  readonly uploader?: SessionArtifactUploader;
  readonly fetchArchive?: typeof fetch;
}
export interface PreparedSessionArtifacts {
  readonly binding: SessionBinding;
  readonly current: SessionRunIdentity;
  readonly source?: SessionRunIdentity;
  readonly checkpoint?: SessionCheckpoint;
  readonly generation: number;
  readonly selection: "created" | "resumed";
  readonly claimArtifactId: number;
  readonly options: PrepareSessionArtifactsOptions;
}

function budget(options: {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}): AbortSignal {
  const remaining = options.deadlineMs - Date.now();
  if (remaining <= 0) denied("Session artifact task budget is exhausted");
  return AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(30_000, remaining))]);
}
function args(binding: SessionBinding, signal: AbortSignal) {
  return { owner: binding.repository.owner, repo: binding.repository.repo, request: { signal } };
}

async function runArtifacts(
  client: GitHubClient,
  binding: SessionBinding,
  runId: number,
  signal: AbortSignal,
): Promise<ArtifactMetadata[]> {
  const found: ArtifactMetadata[] = [];
  const seen = new Set<number>();
  for (let page = 1; page <= 10; page++) {
    const response = await client.rest.actions.listWorkflowRunArtifacts({
      ...args(binding, signal),
      run_id: runId,
      per_page: 100,
      page,
    });
    if (response.data.total_count > 1000)
      denied("Session run artifacts exceed the verification bound");
    for (const artifact of response.data.artifacts) {
      if (seen.has(artifact.id)) denied("Session run artifact listing was unstable or duplicated");
      seen.add(artifact.id);
      found.push(artifact);
    }
    if (found.length === response.data.total_count) return found;
  }
  return denied("Session run artifact listing was incomplete");
}

async function verifyRun(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  runId: number,
  successful: boolean,
  signal: AbortSignal,
): Promise<VerifiedSessionWorkflowRun> {
  return verifySessionWorkflowRun({
    client: options.client,
    repository: binding.repository,
    workflowPath: binding.workflow.path,
    jobId: binding.workflow.jobId,
    runId,
    successful,
    signal,
    ...(options.mode === "auto" ? { automaticKeyHash: binding.keyHash } : {}),
    ...(!successful
      ? {
          runAttempt: options.currentRun.runAttempt,
          workflowSha: options.currentRun.workflowSha,
          expectedActorLogin: options.currentRun.actorLogin,
        }
      : {}),
  });
}

/** Run names retain evidence of a logical key when its short-lived artifacts expire. */
async function automaticHistorySource(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  current: VerifiedSessionWorkflowRun,
  signal: AbortSignal,
): Promise<number | undefined> {
  if (current.sessionTitle === undefined || !Number.isFinite(Date.parse(current.runCreatedAt)))
    denied("Automatic Session history has unknown current run identity");
  const seen = new Set<number>();
  let complete = false;
  let currentFound = false;
  let previous:
    { id: number; updated: number; status: string | null; conclusion: string | null } | undefined;
  for (let page = 1; page <= 10; page++) {
    const response = await options.client.rest.actions.listWorkflowRuns({
      ...args(binding, signal),
      workflow_id: binding.workflow.path,
      per_page: 100,
      page,
    });
    if (response.data.total_count > 1000)
      denied(
        "Automatic Session history is unknown: workflow runs exceed the complete-history bound",
      );
    for (const run of response.data.workflow_runs) {
      if (!Number.isSafeInteger(run.id) || run.id < 1 || typeof run.display_title !== "string")
        denied("Automatic Session history is unknown: run identity or title is missing");
      if (seen.has(run.id))
        denied("Automatic Session history is unknown: unstable or duplicate run listing");
      seen.add(run.id);
      if (run.id === current.runId) {
        currentFound = run.display_title.toLowerCase() === current.sessionTitle;
        continue;
      }
      if (
        run.id < current.runId &&
        !/^dsh-session-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(run.display_title)
      )
        denied(
          "Automatic Session history is unknown: an earlier workflow run has no verifiable key; adopt a new workflow path and new key",
        );
      if (run.display_title.toLowerCase() !== current.sessionTitle) continue;
      if (run.id > current.runId) {
        if (!["queued", "waiting", "pending", "requested"].includes(run.status ?? ""))
          denied(
            "Automatic Session history has a stale or concurrent same-key conflict: a newer request already started or finished",
          );
        continue;
      }
      const updated = Date.parse(run.updated_at);
      if (!Number.isFinite(updated) || run.path !== binding.workflow.path)
        denied("Automatic Session history has unknown or inconsistent run provenance");
      if (
        previous === undefined ||
        updated > previous.updated ||
        (updated === previous.updated && run.id > previous.id)
      )
        previous = { id: run.id, updated, status: run.status, conclusion: run.conclusion };
    }
    if (seen.size === response.data.total_count) {
      complete = true;
      break;
    }
  }
  if (!complete || !currentFound)
    denied(
      "Automatic Session history is unknown: complete workflow run listing could not be verified",
    );
  if (previous === undefined) return undefined;
  if (previous.status !== "completed" || previous.conclusion === null)
    denied(
      "Automatic Session history is unknown: a previous same-key run is unfinished or uncertain; inspect effects and choose a new key",
    );
  if (previous.conclusion !== "success")
    denied(
      "Automatic Session history failed: the latest same-key run did not succeed; inspect effects and choose a new key",
    );
  return previous.id;
}

async function latestGeneration(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  signal: AbortSignal,
): Promise<number> {
  const candidates: ArtifactMetadata[] = [];
  const seen = new Set<number>();
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const response = await options.client.rest.actions.listArtifactsForRepo({
      ...args(binding, signal),
      per_page: 100,
      page,
    });
    if (response.data.total_count > 1000)
      denied("Repository artifacts exceed the bound needed to prove the latest Session generation");
    for (const artifact of response.data.artifacts) {
      if (seen.has(artifact.id)) denied("Repository artifact listing was unstable or duplicated");
      seen.add(artifact.id);
    }
    if (
      options.mode === "auto" &&
      response.data.artifacts.some(
        (item) =>
          item.name.startsWith(`dsh-session-${binding.keyHash}-`) &&
          !item.name.endsWith("-claim") &&
          !item.name.startsWith(sessionArtifactPrefix(binding)),
      )
    )
      denied(
        "Automatic Session history is incompatible with the current workflow, task or runtime binding; choose a new key",
      );
    candidates.push(
      ...response.data.artifacts.filter(
        (item) => item.name.startsWith(sessionArtifactPrefix(binding)) && !item.expired,
      ),
    );
    if (candidates.length > 20)
      denied("Session checkpoint candidates exceed the provenance verification bound");
    if (seen.size === response.data.total_count) {
      complete = true;
      break;
    }
  }
  if (!complete)
    denied("Repository artifact listing could not prove the latest Session generation");
  let latest = 0;
  const runs = new Map<number, VerifiedSessionWorkflowRun | null>();
  const generations = new Set<number>();
  for (const artifact of candidates) {
    const match = /^g([1-9][0-9]*)-a([1-9][0-9]*)$/u.exec(
      artifact.name.slice(sessionArtifactPrefix(binding).length),
    );
    if (match === null || artifact.workflow_run?.id === undefined)
      denied("Session checkpoint name or run provenance is invalid");
    const generation = Number(match[1]);
    const attempt = Number(match[2]);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      generation > 1_000_000 ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      attempt > 1000
    )
      denied("Session artifact generation or attempt is outside its bound");
    const runId = artifact.workflow_run.id;
    let run = runs.get(runId);
    if (run === undefined) {
      const status = await options.client.rest.actions.getWorkflowRun({
        ...args(binding, signal),
        run_id: runId,
      });
      if (status.data.status !== "completed" || status.data.conclusion !== "success") run = null;
      else run = await verifyRun(options, binding, runId, true, signal);
      runs.set(runId, run);
    }
    if (run?.runAttempt === attempt) {
      assertArtifactMetadata(artifact, binding, run);
      if (generations.has(generation))
        denied("Conflicting successful Session checkpoints share one generation");
      generations.add(generation);
      latest = Math.max(latest, generation);
    }
  }
  return latest;
}

function assertArtifactMetadata(
  artifact: ArtifactMetadata,
  binding: SessionBinding,
  source: VerifiedSessionWorkflowRun,
  currentUpload = false,
): void {
  if (
    !Number.isSafeInteger(artifact.id) ||
    artifact.id <= 0 ||
    artifact.expired ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes < 1 ||
    artifact.size_in_bytes > MAX_SESSION_ARCHIVE_BYTES ||
    artifact.workflow_run?.id !== source.runId ||
    artifact.workflow_run.repository_id !== binding.repository.id ||
    artifact.workflow_run.head_repository_id !== binding.repository.id ||
    artifact.workflow_run.head_sha !== source.sourceSha ||
    artifact.created_at === null ||
    !Number.isFinite(Date.parse(artifact.created_at)) ||
    Date.parse(artifact.created_at) < Date.parse(source.createdAt) - 60_000 ||
    Date.parse(artifact.created_at) >
      (currentUpload ? Date.now() : Date.parse(source.updatedAt)) + 60_000 ||
    artifact.expires_at === null ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    Date.parse(artifact.expires_at) <= Date.now() ||
    !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest ?? "")
  )
    denied("Session artifact server provenance, retention, digest or size is invalid");
}

async function downloadCheckpoint(
  options: PrepareSessionArtifactsOptions,
  binding: SessionBinding,
  source: VerifiedSessionWorkflowRun,
  artifact: ArtifactMetadata,
  signal: AbortSignal,
): Promise<SessionCheckpoint> {
  assertArtifactMetadata(artifact, binding, source);
  let location: string | undefined;
  try {
    const response = await options.client.rest.actions.downloadArtifact({
      ...args(binding, signal),
      artifact_id: artifact.id,
      archive_format: "zip",
      request: { signal, redirect: "manual" },
    });
    location = response.headers.location;
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("status" in error) ||
      error.status !== 302 ||
      !("response" in error)
    )
      throw error;
    const redirect = record(record(error.response).headers).location;
    location = typeof redirect === "string" ? redirect : undefined;
  }
  if (location === undefined) denied("GitHub did not provide an artifact archive redirect");
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !(
      url.hostname.endsWith(".blob.core.windows.net") ||
      url.hostname.endsWith(".githubusercontent.com") ||
      url.hostname === "githubusercontent.com"
    )
  )
    denied("Artifact archive redirect has an unsupported HTTPS origin");
  // The Controller token is used only by the official REST request, never sent to the signed blob host.
  const response = await (options.fetchArchive ?? fetch)(url, { signal, redirect: "error" });
  if (response.status !== 200 || response.body === null)
    denied("Session archive could not be downloaded");
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_SESSION_ARCHIVE_BYTES)
    denied("Session archive response exceeds its byte bound");
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > MAX_SESSION_ARCHIVE_BYTES)
        denied("Session archive stream exceeds its byte bound");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== artifact.size_in_bytes || `sha256:${digest(bytes)}` !== artifact.digest)
    denied("Downloaded Session archive does not match its server size or SHA256");
  const checkpoint = decodeSessionArchive(bytes);
  validateSessionManifestBinding(checkpoint.manifest, binding, source);
  if (
    artifact.created_at === null ||
    Math.abs(Date.parse(artifact.created_at) - Date.parse(checkpoint.manifest.createdAt)) >
      30 * 60 * 1000 ||
    Date.parse(checkpoint.manifest.expiresAt) > Date.parse(artifact.expires_at ?? "") + 60_000
  )
    denied("Session manifest timestamp or retention differs from the server artifact");
  return checkpoint;
}

async function upload(
  options: PrepareSessionArtifactsOptions,
  name: string,
  files: Readonly<Record<string, Uint8Array>>,
  signal: AbortSignal,
  verification: {
    readonly kind: "claim" | "checkpoint";
    readonly binding: SessionBinding;
    readonly current: VerifiedSessionWorkflowRun;
    readonly expiresAt?: string;
  },
): Promise<{ id: number; size: number; digest: string }> {
  signal.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), "dsh-session-artifact-"));
  let started = false;
  let acknowledged = false;
  try {
    const paths: string[] = [];
    for (const [file, bytes] of Object.entries(files)) {
      const path = join(root, file);
      await writeFile(path, bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
    }
    await options.authorizeCurrent();
    signal.throwIfAborted();
    started = true;
    const pending = (options.uploader ?? new DefaultArtifactClient()).uploadArtifact(
      name,
      paths,
      root,
      { retentionDays: options.retentionDays, compressionLevel: 0 },
    );
    const result = await new Promise<Awaited<typeof pending>>((resolve, reject) => {
      const abort = (): void =>
        reject(
          new PolicyDeniedError(
            "Session upload exceeded its budget; artifact outcome is unknown and the run must not replay",
          ),
        );
      signal.addEventListener("abort", abort, { once: true });
      pending
        .then(resolve, reject)
        .finally(() => signal.removeEventListener("abort", abort))
        .catch(() => undefined);
      if (signal.aborted) abort();
    });
    if (result.id === undefined || !Number.isSafeInteger(result.id) || result.id < 1)
      denied("Session artifact upload has no valid bounded server receipt");
    acknowledged = true;
    options.onUploadReceipt?.({
      kind: verification.kind,
      id: result.id,
      name,
      ...(result.digest !== undefined && /^[a-f0-9]{64}$/u.test(result.digest)
        ? { sha256: result.digest }
        : {}),
    });
    if (
      result.digest === undefined ||
      !/^[a-f0-9]{64}$/u.test(result.digest) ||
      result.size === undefined ||
      !Number.isSafeInteger(result.size) ||
      result.size < 1 ||
      result.size > MAX_SESSION_ARCHIVE_BYTES
    )
      denied("Confirmed Session upload has an incomplete or invalid size/digest receipt");
    const response = await options.client.rest.actions.getArtifact({
      ...args(verification.binding, signal),
      artifact_id: result.id,
    });
    const artifact = response.data;
    assertArtifactMetadata(artifact, verification.binding, verification.current, true);
    if (
      artifact.id !== result.id ||
      artifact.name !== name ||
      artifact.size_in_bytes !== result.size ||
      artifact.digest !== `sha256:${result.digest}`
    )
      denied("Confirmed Session upload differs from its fresh GitHub artifact receipt");
    const serverExpires = Date.parse(artifact.expires_at ?? "");
    if (
      serverExpires + 60_000 <
        Date.parse(artifact.created_at ?? "") + options.retentionDays * 86400_000 ||
      (verification.expiresAt !== undefined &&
        Date.parse(verification.expiresAt) > serverExpires + 60_000)
    )
      denied(
        "Confirmed Session artifact retention is shorter than requested; use retention within repository limits",
      );
    return { id: result.id, size: result.size, digest: result.digest };
  } catch (error) {
    if (!started || acknowledged) throw error;
    return denied(
      "Session artifact upload failed or is uncertain; duplicate advances and automatic write retries are forbidden",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function prepareSessionArtifacts(
  options: PrepareSessionArtifactsOptions,
): Promise<PreparedSessionArtifacts> {
  if (
    !Number.isInteger(options.retentionDays) ||
    options.retentionDays < 1 ||
    options.retentionDays > 7
  )
    denied("Session retention must be 1-7 days");
  if (options.mode === "auto" && options.sourceRunId !== undefined)
    denied(
      "Automatic Session selects its own source; session-source-run-id is only for explicit resume",
    );
  const signal = budget(options);
  const current = await verifyRun(
    options,
    options.binding,
    options.currentRun.runId,
    false,
    signal,
  );
  const binding = {
    ...options.binding,
    workflow: { ...options.binding.workflow, jobName: current.jobName },
  };
  const artifacts = await runArtifacts(options.client, binding, current.runId, signal);
  if (
    artifacts.some(
      (item) =>
        item.name === sessionClaimName(binding.keyHash, current.runAttempt) ||
        (item.name.startsWith(sessionArtifactPrefix(binding)) &&
          item.name.endsWith(`-a${String(current.runAttempt)}`)),
    )
  )
    denied("This run attempt already claimed or saved the Session; it cannot advance twice");
  const selectedRunId =
    options.mode === "auto"
      ? await automaticHistorySource(options, binding, current, signal)
      : options.sourceRunId;
  const latest = await latestGeneration(options, binding, signal);
  if (latest >= 1_000_000)
    denied("Session generation limit has been reached; choose a new explicit Session key");
  let checkpoint: SessionCheckpoint | undefined;
  let source: VerifiedSessionWorkflowRun | undefined;
  if (options.mode === "resume" || (options.mode === "auto" && selectedRunId !== undefined)) {
    if (selectedRunId === undefined || selectedRunId === current.runId)
      denied("Resume requires an explicit distinct source run ID");
    const producer = await verifyRun(options, binding, selectedRunId, true, signal);
    source = producer;
    if (source.jobName !== binding.workflow.jobName)
      denied("Session producer job name differs from the current trusted workflow");
    const candidates = (await runArtifacts(options.client, binding, source.runId, signal)).filter(
      (item) =>
        item.name.startsWith(sessionArtifactPrefix(binding)) &&
        item.name.endsWith(`-a${String(producer.runAttempt)}`),
    );
    if (options.mode === "auto" && candidates.length === 0)
      denied(
        "Automatic Session history checkpoint is missing; inspect the previous run and choose a new key",
      );
    if (
      options.mode === "auto" &&
      candidates.some((item) => item.expired || Date.parse(item.expires_at ?? "") <= Date.now())
    )
      denied("Automatic Session history checkpoint is expired; choose a new key");
    if (candidates.length !== 1 || candidates[0] === undefined)
      denied("Source run must contain exactly one checkpoint for this Session binding and attempt");
    checkpoint = await downloadCheckpoint(options, binding, source, candidates[0], signal);
    if (
      checkpoint.manifest.session.generation !== latest ||
      candidates[0].name !== sessionArtifactName(binding, source.runAttempt, latest)
    )
      denied("Resume parent is stale or its generation is inconsistent");
  } else if (latest !== 0)
    denied(
      options.mode === "auto"
        ? "Automatic Session history is unknown: checkpoints exist without matching run-name history; choose a new key"
        : "A successful Session checkpoint already exists; select resume with its exact source run instead of starting a fork",
    );
  const generation = latest + 1;
  const claim = {
    schemaVersion: 1,
    repositoryId: binding.repository.id,
    runId: current.runId,
    runAttempt: current.runAttempt,
    keyHash: binding.keyHash,
    generation,
    createdAt: new Date().toISOString(),
  };
  const receipt = await upload(
    options,
    sessionClaimName(binding.keyHash, current.runAttempt),
    { "claim.json": Buffer.from(JSON.stringify(claim)) },
    signal,
    { kind: "claim", binding, current },
  );
  return {
    binding,
    current,
    generation,
    claimArtifactId: receipt.id,
    selection: checkpoint === undefined ? "created" : "resumed",
    options,
    ...(source === undefined ? {} : { source }),
    ...(checkpoint === undefined ? {} : { checkpoint }),
  };
}

export async function saveSessionArtifact(options: {
  readonly prepared: PreparedSessionArtifacts;
  readonly checkpoint: SessionCheckpoint;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}): Promise<{ id: number; name: string; generation: number; size?: number; sha256?: string }> {
  const { prepared, checkpoint } = options;
  const signal = budget(options);
  const current = await verifyRun(
    prepared.options,
    prepared.binding,
    prepared.current.runId,
    false,
    signal,
  );
  validateSessionManifestBinding(
    parseSessionManifest(checkpoint.manifest),
    prepared.binding,
    current,
  );
  if (
    checkpoint.manifest.session.generation !== prepared.generation ||
    checkpoint.payload.length !== checkpoint.manifest.payload.bytes ||
    digest(checkpoint.payload) !== checkpoint.manifest.payload.sha256
  )
    denied("Session checkpoint generation or payload changed before save");
  if (
    prepared.options.mode === "auto" &&
    (await automaticHistorySource(prepared.options, prepared.binding, current, signal)) !==
      prepared.source?.runId
  )
    denied(
      "Automatic Session parent history changed before save; conflicting advances are forbidden",
    );
  if (
    (await latestGeneration(prepared.options, prepared.binding, signal)) !==
    prepared.generation - 1
  )
    denied("Session parent generation changed before save");
  const name = sessionArtifactName(prepared.binding, current.runAttempt, prepared.generation);
  const artifacts = await runArtifacts(
    prepared.options.client,
    prepared.binding,
    current.runId,
    signal,
  );
  const claims = artifacts.filter(
    (item) => item.name === sessionClaimName(prepared.binding.keyHash, current.runAttempt),
  );
  if (
    claims.length !== 1 ||
    claims[0]?.id !== prepared.claimArtifactId ||
    artifacts.some((item) => item.name === name)
  )
    denied("Session claim is missing or checkpoint was already saved");
  const manifest = Buffer.from(JSON.stringify(checkpoint.manifest));
  if (manifest.length > MAX_SESSION_MANIFEST_BYTES)
    denied("Session manifest exceeds its byte bound");
  const receipt = await upload(
    prepared.options,
    name,
    { [SESSION_MANIFEST_FILE]: manifest, [SESSION_PAYLOAD_FILE]: checkpoint.payload },
    signal,
    {
      kind: "checkpoint",
      binding: prepared.binding,
      current,
      expiresAt: checkpoint.manifest.expiresAt,
    },
  );
  return {
    id: receipt.id,
    name,
    generation: prepared.generation,
    size: receipt.size,
    sha256: receipt.digest,
  };
}
