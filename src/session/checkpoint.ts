import { isRecord, record as objectRecord } from "../security/record.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";

import { PolicyDeniedError } from "../errors.js";
import {
  MAX_SESSION_PAYLOAD_BYTES,
  parseSessionManifest,
  SESSION_PAYLOAD_FILE,
  type SessionBinding,
  type SessionCheckpoint,
  type SessionManifest,
  type SessionManifestWithoutPayload,
  type SessionRunIdentity,
  validateSessionManifestBinding,
} from "./contracts.js";

export const SESSION_CHECKPOINT_LIMITS = Object.freeze({
  payloadBytes: MAX_SESSION_PAYLOAD_BYTES,
  rowBytes: 1024 * 1024,
  rows: 20_000,
  depth: 40,
  nodes: 200_000,
  arrayItems: 20_000,
  knownSecrets: 256,
});
export const SESSION_LOG_FILE = "session.v4.jsonl";

export interface SessionPayloadInspection {
  readonly sessionId: string;
  readonly eventCount: number;
  readonly bytes: number;
  readonly sha256: string;
}

interface PayloadOptions {
  readonly payload: Uint8Array;
  readonly sessionId: string;
  /** Exact stable worker cwd; supplied by the Controller, never the artifact. */
  readonly workspacePath: string;
  /** Controller credentials, actual extension secrets and the worker proxy credential. */
  readonly knownSecrets: readonly string[];
}

interface ExportOptions {
  /** Dedicated persistence root after worker shutdown and durability flush. */
  readonly persistenceRoot: string;
  readonly manifest: SessionManifestWithoutPayload;
  readonly workspacePath: string;
  readonly knownSecrets: readonly string[];
  readonly now?: number;
}

interface StoredOptions {
  readonly persistenceRoot: string;
  readonly sessionId: string;
  readonly workspacePath: string;
  readonly knownSecrets: readonly string[];
}

interface ImportOptions {
  readonly persistenceRoot: string;
  readonly checkpoint: SessionCheckpoint;
  readonly binding: SessionBinding;
  readonly source: SessionRunIdentity;
  readonly workspacePath: string;
  readonly knownSecrets: readonly string[];
  readonly now?: number;
}

function denied(message: string): never {
  throw new PolicyDeniedError(`Session checkpoint ${message}`);
}

function safeSessionId(value: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value) ||
    value.endsWith(".")
  ) {
    denied("has an unsafe Session identifier");
  }
}

/** Published JSONL backend project encoding; callers supply the cwd, not stored paths. */
function projectName(workspacePath: string): string {
  if (!isAbsolute(workspacePath) || workspacePath.includes("\0")) {
    denied("requires an absolute compatible worker directory");
  }
  let readable = workspacePath.replace(/[/\\:]+/gu, "-");
  readable = readable.replace(/[^A-Za-z0-9._-]/gu, (char) =>
    Array.from(
      { length: char.length },
      (_, index) => `~${char.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`,
    ).join(""),
  );
  readable = readable.replace(/^-+/u, "") || "root";
  // Published backend truncates the readable segment, not the worker cwd identity.
  return `--${readable.slice(0, 251)}--`;
}

function secretValues(secrets: readonly string[]): readonly string[] {
  if (secrets.length > SESSION_CHECKPOINT_LIMITS.knownSecrets) {
    denied("has too many credential values to inspect safely");
  }
  const values = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (Buffer.byteLength(secret, "utf8") > SESSION_CHECKPOINT_LIMITS.payloadBytes) {
      denied("has an oversized credential value");
    }
    values.add(secret);
    values.add(Buffer.from(secret, "utf8").toString("base64"));
    values.add(encodeURIComponent(secret));
  }
  return [...values];
}

const credentialKey =
  /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth(?:entication|orization)?|auth[-_]?token|token|bearer|password|passwd|secret|client[-_]?secret|private[-_]?key|cookie|credentials?|(?:github|gh|deepseek|openai)[_-](?:api[-_]?key|token))$/iu;
const credentialValue =
  /(?:\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bnpm_[A-Za-z0-9]{20,}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----)/u;

function inspectString(value: string, secrets: readonly string[]): void {
  if (credentialValue.test(value) || secrets.some((secret) => value.includes(secret))) {
    denied("contains credential material; lossless export/import was refused");
  }
}

/** Reject excessive depth and duplicate object keys before JSON.parse can erase evidence. */
function preflightJson(text: string, secrets: readonly string[], scope: string): void {
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === "\\") end += 1;
        end += 1;
      }
      if (end >= text.length) denied(`contains malformed JSON (${scope})`);
      let value: unknown;
      try {
        value = JSON.parse(text.slice(index, end + 1)) as unknown;
      } catch {
        denied(`contains malformed JSON (${scope})`);
      }
      if (typeof value !== "string") denied(`contains malformed JSON (${scope})`);
      inspectString(value, secrets);
      const current = stack.at(-1);
      if (current?.expectingKey) {
        if (current.keys.has(value)) denied(`contains duplicate JSON keys (${scope})`);
        current.keys.add(value);
        current.expectingKey = false;
      }
      index = end;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? { keys: new Set(), expectingKey: true } : null);
      if (stack.length > SESSION_CHECKPOINT_LIMITS.depth)
        denied(`exceeds JSON depth limit (${scope})`);
    } else if (char === "}" || char === "]") {
      stack.pop();
    } else if (char === ",") {
      const current = stack.at(-1);
      if (current !== undefined && current !== null) current.expectingKey = true;
    }
  }
}

/** Recognize complete JSON without building an AST; the caller bounds input bytes. */
function completeJsonDepth(text: string): number | undefined {
  // Array: first value/end, value, comma/end. Object: first key/end,
  // key, colon, value, comma/end. Numeric frames keep deep invalid prose bounded.
  const frames: number[] = [];
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/uy;
  let offset = 0;
  let depth = 0;
  let rootRead = false;
  const string = (): boolean => {
    if (text[offset] !== '"') return false;
    offset += 1;
    for (; offset < text.length; offset += 1) {
      const char = text[offset];
      if (char === '"') {
        offset += 1;
        return true;
      }
      if (text.charCodeAt(offset) < 0x20) return false;
      if (char === "\\") {
        offset += 1;
        if ('"\\/bfnrt'.includes(text[offset] ?? "\0")) continue;
        if (text[offset] !== "u" || !/^[a-f0-9]{4}$/iu.test(text.slice(offset + 1, offset + 5)))
          return false;
        offset += 4;
      }
    }
    return false;
  };
  for (;;) {
    while (/[ \t\r\n]/u.test(text[offset] ?? "")) offset += 1;
    const state = frames.at(-1);
    const char = text[offset];
    if (state === undefined) {
      if (rootRead) return offset === text.length ? depth : undefined;
      rootRead = true;
    } else if (state === 0 || state === 1) {
      if (state === 0 && char === "]") {
        frames.pop();
        offset += 1;
        continue;
      }
      frames[frames.length - 1] = 2;
    } else if (state === 2 || state === 7) {
      if (char === ",") {
        frames[frames.length - 1] = state === 2 ? 1 : 4;
        offset += 1;
        continue;
      }
      if (char !== (state === 2 ? "]" : "}")) return undefined;
      frames.pop();
      offset += 1;
      continue;
    } else if (state === 3 || state === 4) {
      if (state === 3 && char === "}") {
        frames.pop();
        offset += 1;
        continue;
      }
      if (!string()) return undefined;
      frames[frames.length - 1] = 5;
      continue;
    } else if (state === 5) {
      if (char !== ":") return undefined;
      frames[frames.length - 1] = 6;
      offset += 1;
      continue;
    } else {
      frames[frames.length - 1] = 7;
    }
    if (char === "{" || char === "[") {
      frames.push(char === "{" ? 3 : 0);
      depth = Math.max(depth, frames.length);
      offset += 1;
    } else if (char === '"') {
      if (!string()) return undefined;
    } else if (["true", "false", "null"].some((literal) => text.startsWith(literal, offset))) {
      offset += text.startsWith("false", offset) ? 5 : 4;
    } else {
      number.lastIndex = offset;
      if (number.exec(text) === null) return undefined;
      offset = number.lastIndex;
    }
  }
}

function inspectJson(
  value: unknown,
  secrets: readonly string[],
  counter: { nodes: number },
  scope = "manifest",
): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    counter.nodes += 1;
    if (counter.nodes > SESSION_CHECKPOINT_LIMITS.nodes) denied("exceeds JSON complexity limit");
    if (typeof current === "number") {
      if (
        !Number.isFinite(current) ||
        (Number.isInteger(current) && !Number.isSafeInteger(current))
      ) {
        denied("contains an unsafe JSON number");
      }
    } else if (typeof current === "string") {
      inspectString(current, secrets);
      // Tool arguments and opaque plugin metadata can themselves contain JSON.
      // Inspect valid embedded objects without treating arbitrary prose as JSON.
      if (current.trimStart().startsWith("{") || current.trimStart().startsWith("[")) {
        const depth = completeJsonDepth(current);
        if (depth !== undefined) {
          const embeddedScope = `${scope}, embedded JSON string`;
          if (depth > SESSION_CHECKPOINT_LIMITS.depth)
            denied(`exceeds JSON depth limit (${embeddedScope})`);
          preflightJson(current, secrets, embeddedScope);
          let nested: unknown;
          try {
            nested = JSON.parse(current) as unknown;
          } catch {
            denied(`contains malformed JSON (${embeddedScope})`);
          }
          pending.push(nested);
        }
      }
    } else if (Array.isArray(current)) {
      if (current.length > SESSION_CHECKPOINT_LIMITS.arrayItems) denied("exceeds JSON array limit");
      pending.push(...(current as unknown[]));
    } else if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (key === "__proto__" || key === "prototype" || key === "constructor") {
          denied("contains unsafe JSON property names");
        }
        if (credentialKey.test(key) && typeof child === "string" && child.length > 0) {
          denied("contains a credential field; lossless export/import was refused");
        }
        pending.push(child);
      }
    }
  }
}

type RestoredArtifact = ReturnType<ReturnType<typeof sessionFormatCatalog.createRestore>["finish"]>;

/** Published image/file blocks reference worker-local attachment bytes outside the raw log. */
function assertPortableTextHistory(artifact: RestoredArtifact): void {
  const record = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});
  const content = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const block of value) {
      const type = record(block).type;
      if (type === "image" || type === "file") {
        denied(
          "contains nonportable image or file attachment content; portable checkpoints require text history",
        );
      }
    }
  };
  const message = (value: unknown): void => content(record(value).content);
  // These are the released Session/LLM content slots. Tool-private meta, opaque
  // plugin records and JSON inside text blocks are business data, not content.
  for (const event of artifact.events) {
    const data = record(event.data);
    switch (event.type) {
      case "user/message":
        message(data);
        break;
      case "system/message":
      case "developer/message":
      case "tool/result":
        message(data.message);
        break;
      case "assistant/message":
      case "assistant/attempt":
        if (event.type === "assistant/message") message(data.message);
        // Assistant attempts also persist completed stream blocks outside the surface.
        if (Array.isArray(data.stream)) {
          for (const entry of data.stream) {
            const timed = record(entry);
            const chunk = record(timed.chunk);
            if (timed.type === "chunk" && chunk.type === "block-end") content([chunk.block]);
          }
        }
        break;
      case "compaction/summary":
        content(data.summary);
        content(data.rawOutput);
        break;
      case "tool/ptc-dispatch":
        content(data.content);
        break;
      case "agent/inbox/spliced":
      case "session/title-llm-request": {
        const messages = event.type === "agent/inbox/spliced" ? data.inserted : data.messages;
        if (Array.isArray(messages)) messages.forEach(message);
        break;
      }
      default:
        break;
    }
  }
}

/** Only settled history is portable; resume must not repair or consume old work. */
function assertSettled(artifact: RestoredArtifact): void {
  let openTurn = false;
  let openStep = false;
  const pending = new Set<string>();
  const tools = new Set<string>();
  const inbox: Record<"next-turn" | "next-step", string[]> = { "next-turn": [], "next-step": [] };
  const identity = (data: Record<string, unknown>, key: string): string => {
    const value = data[key];
    if (typeof value !== "string" || value.length === 0)
      denied("has invalid pending-operation metadata");
    return value;
  };
  const sequence = (data: Record<string, unknown>, key: string): string => {
    const value = data[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      denied("has invalid operation sequence metadata");
    return String(value);
  };
  const bracket = (key: string, opening: boolean): void => {
    if (opening ? pending.has(key) : !pending.has(key))
      denied("has invalid operation settlement metadata");
    if (opening) pending.add(key);
    else pending.delete(key);
  };
  for (const event of artifact.events) {
    const data = isRecord(event.data) ? event.data : {};
    switch (event.type) {
      case "turn/start":
        openTurn = true;
        break;
      case "turn/end":
        openTurn = false;
        break;
      case "step/start":
        openStep = true;
        break;
      case "step/end":
        openStep = false;
        break;
      case "assistant/message": {
        const message = objectRecord(data.message);
        if (!Array.isArray(message.content) || !message.content.every(isRecord))
          denied("has invalid assistant message content");
        const content = message.content;
        for (const block of content) {
          if (block.type === "tool-call") tools.add(identity(block, "id"));
        }
        break;
      }
      case "tool/call":
        tools.add(identity(data, "callId"));
        break;
      case "tool/result": {
        const message = objectRecord(data.message);
        tools.delete(identity(message, "toolCallId"));
        break;
      }
      case "compaction/start":
      case "compaction/end":
        bracket(`compaction:${identity(data, "compactionId")}`, event.type.endsWith("/start"));
        break;
      case "command/run":
      case "command/done":
        bracket(`command:${identity(data, "commandId")}`, event.type.endsWith("/run"));
        break;
      case "approval/asked":
      case "approval/decided":
        bracket(`approval:${identity(data, "id")}`, event.type.endsWith("/asked"));
        break;
      case "hook/invoked":
      case "hook/result":
        bracket(
          `hook:${sequence(data, "turn")}:${identity(data, "handlerId")}`,
          event.type.endsWith("/invoked"),
        );
        break;
      case "tool/ptc-dispatch-start":
      case "tool/ptc-dispatch":
        bracket(`ptc:${identity(data, "subCallId")}`, event.type.endsWith("-start"));
        break;
      case "tool-workflow/run-start":
      case "tool-workflow/run-end":
        bracket(`workflow:${identity(data, "runId")}`, event.type.endsWith("-start"));
        break;
      case "tool-workflow/agent-start":
      case "tool-workflow/agent-end":
        bracket(
          `workflow-agent:${identity(data, "runId")}:${sequence(data, "seq")}`,
          event.type.endsWith("-start"),
        );
        break;
      case "agent/inbox/spliced": {
        const target = data.target;
        const start = data.start;
        const removed = data.removedCount ?? 0;
        const inserted = data.inserted;
        if (
          (target !== "next-turn" && target !== "next-step") ||
          typeof start !== "number" ||
          !Number.isSafeInteger(start) ||
          start < 0 ||
          typeof removed !== "number" ||
          !Number.isSafeInteger(removed) ||
          removed < 0 ||
          !Array.isArray(inserted)
        ) {
          denied("has invalid persisted inbox metadata");
        }
        const queue = inbox[target];
        if (start > queue.length || start + removed > queue.length)
          denied("has invalid persisted inbox bounds");
        const ids = inserted.map((message: unknown) => {
          if (!isRecord(message)) denied("has invalid inbox input");
          return identity(message, "id");
        });
        inbox[target] = queue.toSpliced(start, removed, ...ids);
        const all = [...inbox["next-turn"], ...inbox["next-step"]];
        if (new Set(all).size !== all.length) denied("has duplicate pending inbox identities");
        break;
      }
      default:
        break;
    }
  }
  if (
    openTurn ||
    openStep ||
    tools.size > 0 ||
    pending.size > 0 ||
    inbox["next-turn"].length > 0 ||
    inbox["next-step"].length > 0
  ) {
    denied("is not settled; unfinished work or queued input cannot be resumed safely");
  }
}

/** Validate genuine persistence using the released public codec without rewriting any bytes. */
export function validateSessionPayload(options: PayloadOptions): SessionPayloadInspection {
  safeSessionId(options.sessionId);
  projectName(options.workspacePath);
  const bytes = options.payload.byteLength;
  if (bytes === 0 || bytes > SESSION_CHECKPOINT_LIMITS.payloadBytes) {
    denied("is empty or exceeds the 4 MiB payload limit");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(options.payload);
  } catch {
    denied("is not valid UTF-8");
  }
  if (!text.endsWith("\n")) denied("has an incomplete final JSONL record");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > SESSION_CHECKPOINT_LIMITS.rows) denied("exceeds JSONL record count limit");
  const secrets = secretValues(options.knownSecrets);
  inspectString(text, secrets);
  const counter = { nodes: 0 };
  const rows = lines.map((line, index): unknown => {
    const scope = `outer JSONL record ${String(index)}`;
    if (
      line.trim().length === 0 ||
      Buffer.byteLength(line, "utf8") > SESSION_CHECKPOINT_LIMITS.rowBytes
    ) {
      denied(`contains an empty or oversized JSONL record (${scope})`);
    }
    preflightJson(line, secrets, scope);
    let row: unknown;
    try {
      row = JSON.parse(line) as unknown;
    } catch {
      denied(`contains malformed JSON (${scope})`);
    }
    inspectJson(row, secrets, counter, scope);
    return row;
  });
  // A current physical row is one durable event. Bound encoded sequence ranges
  // before the public decoder expands them into logical arrays.
  let expandedReferences = 0;
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue;
    if (!isRecord(row)) denied("contains an invalid event row");
    const record = row;
    if (record.seq !== index - 1) denied("contains noncontiguous event sequence numbers");
    const references = record.sourceEventSeqs;
    if (references !== undefined) {
      if (!Array.isArray(references)) denied("contains invalid event references");
      for (const reference of references) {
        if (Array.isArray(reference)) {
          const [start, end] = reference as unknown[];
          if (
            reference.length !== 2 ||
            typeof start !== "number" ||
            typeof end !== "number" ||
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            end < start ||
            end >= index - 1
          ) {
            denied("contains invalid event reference ranges");
          }
          expandedReferences += end - start + 1;
        } else {
          if (
            typeof reference !== "number" ||
            !Number.isSafeInteger(reference) ||
            reference < 0 ||
            reference >= index - 1
          ) {
            denied("contains invalid event references");
          }
          expandedReferences += 1;
        }
        if (expandedReferences > SESSION_CHECKPOINT_LIMITS.nodes)
          denied("exceeds expanded event reference limit");
      }
    }
  }
  try {
    const header = sessionFormatCatalog.readHeader(rows[0]);
    if (
      header.status !== "current" ||
      header.storedVersion !== 4 ||
      sessionFormatCatalog.currentVersion !== 4
    ) {
      denied("has an unsupported or incompatible DSH persistence format");
    }
    if (
      header.header.id !== options.sessionId ||
      header.header.cwd !== options.workspacePath ||
      header.header.isSeeded ||
      header.header.parentSession !== undefined ||
      header.header.origin !== undefined ||
      header.header.agentPreset !== undefined ||
      header.header.delegationDepth !== 0
    ) {
      denied("has an incompatible Session identity, lineage, preset or worker directory");
    }
    const restore = sessionFormatCatalog.createRestore(rows[0], {
      recovery: "strict",
      validation: "current",
    });
    for (const row of rows.slice(1)) restore.decodeRow(row);
    const artifact = restore.finish();
    if (
      artifact.events.length > SESSION_CHECKPOINT_LIMITS.rows ||
      artifact.inheritedEventCount !== 0
    ) {
      denied("has an unsupported inherited or oversized event history");
    }
    assertSettled(artifact);
    assertPortableTextHistory(artifact);
    return {
      sessionId: artifact.header.id,
      eventCount: artifact.events.length,
      bytes,
      sha256: createHash("sha256").update(options.payload).digest("hex"),
    };
  } catch (error: unknown) {
    if (error instanceof PolicyDeniedError) throw error;
    // Codec errors may include log text. Do not retain their messages or causes.
    denied("has corrupt or incompatible persisted events");
  }
}

async function checkedRoot(root: string): Promise<string> {
  const absolute = resolve(root);
  const filesystemRoot = parse(absolute).root;
  let current = filesystemRoot;
  for (const component of absolute.slice(filesystemRoot.length).split(sep)) {
    if (component.length === 0) continue;
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory())
      denied("storage path is not a regular directory");
  }
  const physical = await realpath(absolute);
  const comparable = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  if (comparable(physical) !== comparable(absolute))
    denied("storage path contains a redirected directory");
  return physical;
}

async function exactEntries(
  directory: string,
  allowed: readonly string[],
  required: readonly string[],
): Promise<Set<string>> {
  const entries = new Set<string>();
  for await (const entry of await opendir(directory, { bufferSize: 4 })) {
    if (!allowed.includes(entry.name) || entries.size >= allowed.length) {
      denied("storage contains additional or incompatible Session files");
    }
    if (entry.isSymbolicLink()) denied("storage contains a symbolic link");
    entries.add(entry.name);
  }
  if (required.some((name) => !entries.has(name)))
    denied("storage is missing required Session files");
  return entries;
}

async function readLog(path: string): Promise<Buffer> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > SESSION_CHECKPOINT_LIMITS.payloadBytes
  ) {
    denied("log is not a bounded regular file");
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size ||
      !opened.isFile()
    ) {
      denied("log changed while being opened");
    }
    const payload = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < payload.length) {
      const read = await handle.read(payload, offset, payload.length - offset, offset);
      if (read.bytesRead === 0) denied("log changed while being read");
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      current.ino !== opened.ino ||
      current.dev !== opened.dev ||
      current.isSymbolicLink()
    ) {
      denied("log changed while being read");
    }
    return payload;
  } finally {
    await handle.close();
  }
}

async function readStoredSession(
  options: StoredOptions,
): Promise<{ payload: Buffer; inspection: SessionPayloadInspection }> {
  safeSessionId(options.sessionId);
  const root = await checkedRoot(options.persistenceRoot);
  const project = projectName(options.workspacePath);
  await exactEntries(root, [project], [project]);
  const projectPath = join(root, project);
  await checkedRoot(projectPath);
  const sessionId = options.sessionId;
  await exactEntries(projectPath, [sessionId], [sessionId]);
  const sessionPath = join(projectPath, sessionId);
  await checkedRoot(sessionPath);
  const entries = await exactEntries(
    sessionPath,
    [SESSION_LOG_FILE, "session.lock"],
    [SESSION_LOG_FILE],
  );
  if (entries.has("session.lock")) {
    const lease = await lstat(join(sessionPath, "session.lock"));
    if (!lease.isFile() || lease.isSymbolicLink() || lease.nlink !== 1 || lease.size !== 0) {
      denied("contains an incompatible lease file");
    }
  }
  const payload = await readLog(join(sessionPath, SESSION_LOG_FILE));
  const inspection = validateSessionPayload({ ...options, payload, sessionId });
  return { payload, inspection };
}

/** Inspect terminated current-run workers through the same bounded physical reader. */
export async function inspectStoredSession(
  options: StoredOptions,
): Promise<SessionPayloadInspection> {
  try {
    return (await readStoredSession(options)).inspection;
  } catch (error: unknown) {
    if (error instanceof PolicyDeniedError) throw error;
    denied("could not read its dedicated storage; check files and permissions");
  }
}

/** Export only one canonical raw generation after the worker has terminated. */
export async function exportSessionCheckpoint(options: ExportOptions): Promise<SessionCheckpoint> {
  try {
    const { payload, inspection } = await readStoredSession({
      ...options,
      sessionId: options.manifest.session.sessionId,
    });
    const manifest = parseSessionManifest(
      {
        ...options.manifest,
        payload: { file: SESSION_PAYLOAD_FILE, bytes: inspection.bytes, sha256: inspection.sha256 },
      },
      options.now,
    );
    // A manifest may contain maintained labels. Scan it too; never export known credentials.
    inspectJson(manifest, secretValues(options.knownSecrets), { nodes: 0 });
    return { manifest, payload };
  } catch (error: unknown) {
    if (error instanceof PolicyDeniedError) throw error;
    denied("could not read its dedicated storage; check files and permissions");
  }
}

/** Fresh import does not restore Controller authorization or execute any event. */
export async function importSessionCheckpoint(
  options: ImportOptions,
): Promise<SessionPayloadInspection> {
  const manifest = parseSessionManifest(options.checkpoint.manifest, options.now);
  validateSessionManifestBinding(manifest, options.binding, options.source);
  if (options.checkpoint.payload.byteLength > SESSION_CHECKPOINT_LIMITS.payloadBytes)
    denied("exceeds the 4 MiB payload limit");
  const payload = Buffer.from(options.checkpoint.payload);
  const inspection = validateSessionPayload({
    ...options,
    payload,
    sessionId: manifest.session.sessionId,
  });
  if (
    manifest.payload.bytes !== inspection.bytes ||
    manifest.payload.sha256 !== inspection.sha256
  ) {
    denied("payload integrity does not match its manifest");
  }
  inspectJson(manifest, secretValues(options.knownSecrets), { nodes: 0 });
  try {
    const root = await checkedRoot(options.persistenceRoot);
    await exactEntries(root, [], []);
    const projectPath = join(root, projectName(options.workspacePath));
    await mkdir(projectPath, { mode: 0o700 });
    await checkedRoot(projectPath);
    const sessionPath = join(projectPath, manifest.session.sessionId);
    await mkdir(sessionPath, { mode: 0o700 });
    await checkedRoot(sessionPath);
    const path = join(sessionPath, SESSION_LOG_FILE);
    if (dirname(path) !== sessionPath) denied("has an unsafe destination");
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
      0o600,
    );
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return inspection;
  } catch (error: unknown) {
    if (error instanceof PolicyDeniedError) throw error;
    denied("could not create fresh dedicated storage; refusing overwrite or reuse");
  }
}

export function sessionPayloadMatchesManifest(
  payload: Uint8Array,
  manifest: SessionManifest,
): boolean {
  return (
    payload.byteLength === manifest.payload.bytes &&
    createHash("sha256").update(payload).digest("hex") === manifest.payload.sha256
  );
}
