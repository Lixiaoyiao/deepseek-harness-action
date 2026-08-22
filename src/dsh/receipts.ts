import { open, readFile, stat } from "node:fs/promises";

import type { DshPolicyRule } from "../extensions/profile.js";
import { DshConfigurationError } from "./errors.js";

export const MAX_DSH_RECEIPT_LOG_BYTES = 16 * 1024 * 1024;
export const MAX_DSH_INVOCATION_STATE_BYTES = 1024 * 1024;

export interface DshToolReceipt {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: string;
  /** Whether the policy charged this invocation against tool and owner limits. */
  readonly counted: boolean;
  /** False only when the worker stopped after durable admission but before final observation. */
  readonly completed: boolean;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code?: string;
}

export interface DshInvocationCounts {
  readonly tools: Readonly<Record<string, number>>;
  readonly groups: Readonly<Record<string, number>>;
}

interface RawDshToolReceipt {
  readonly schemaVersion: 1;
  readonly phase: "started" | "completed";
  readonly callId: string;
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: "builtin" | "mcp" | "plugin" | "denied";
  readonly counted: boolean;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code?: string;
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function parseRawToolReceipt(line: string): RawDshToolReceipt {
  let value: Partial<RawDshToolReceipt> & Readonly<Record<string, unknown>>;
  try {
    value = JSON.parse(line) as Partial<RawDshToolReceipt> & Readonly<Record<string, unknown>>;
  } catch {
    throw new DshConfigurationError("DSH emitted a malformed tool receipt");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "phase",
    "callId",
    "id",
    "runtimeName",
    "provider",
    "counted",
    "ok",
    "durationMs",
    "code",
  ]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    value.schemaVersion !== 1 ||
    (value.phase !== "started" && value.phase !== "completed") ||
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    value.callId.length > 256 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    typeof value.runtimeName !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(value.runtimeName) ||
    !["builtin", "mcp", "plugin", "denied"].includes(value.provider ?? "") ||
    typeof value.counted !== "boolean" ||
    typeof value.ok !== "boolean" ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs ?? -1) < 0 ||
    (value.code !== undefined &&
      (typeof value.code !== "string" || value.code.length === 0 || value.code.length > 128))
  ) {
    throw new DshConfigurationError("DSH emitted a malformed tool receipt");
  }
  if (
    value.phase === "started" &&
    (!value.counted ||
      value.ok ||
      value.durationMs !== 0 ||
      value.code !== "ACTION_TOOL_INCOMPLETE")
  ) {
    throw new DshConfigurationError("DSH emitted a malformed tool admission receipt");
  }
  return value as RawDshToolReceipt;
}

async function readReceiptRange(path: string, offset: number): Promise<Buffer> {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new DshConfigurationError("DSH tool receipt offset is invalid");
  }
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }
  try {
    const size = (await handle.stat()).size;
    if (offset > size) {
      throw new DshConfigurationError("DSH tool receipt log was truncated during a turn");
    }
    const length = size - offset;
    if (size > MAX_DSH_RECEIPT_LOG_BYTES || length > MAX_DSH_RECEIPT_LOG_BYTES) {
      throw new DshConfigurationError("DSH tool receipt log exceeded the Controller limit");
    }
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const result = await handle.read(buffer, read, length - read, offset + read);
      if (result.bytesRead === 0) {
        throw new DshConfigurationError("DSH tool receipt log was truncated during a turn");
      }
      read += result.bytesRead;
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

/** Read only the bytes appended by the current turn and reconcile its receipt events. */
export async function readToolReceipts(
  path: string,
  offset: number,
): Promise<readonly DshToolReceipt[]> {
  const text = (await readReceiptRange(path, offset)).toString("utf8").trim();
  if (text === "") return [];
  const events = text.split("\n").map((line) => parseRawToolReceipt(line));
  const started = new Map<string, RawDshToolReceipt>();
  const completed = new Map<string, RawDshToolReceipt>();
  const order: string[] = [];
  const orderedCallIds = new Set<string>();
  for (const event of events) {
    const target = event.phase === "started" ? started : completed;
    if (target.has(event.callId)) {
      throw new DshConfigurationError(`DSH emitted duplicate ${event.phase} tool receipts`);
    }
    target.set(event.callId, event);
    if (!orderedCallIds.has(event.callId)) {
      orderedCallIds.add(event.callId);
      order.push(event.callId);
    }
  }
  return order.map((callId) => {
    const admission = started.get(callId);
    const result = completed.get(callId);
    if (result !== undefined) {
      if (result.counted) {
        if (
          admission?.id !== result.id ||
          admission.runtimeName !== result.runtimeName ||
          admission.provider !== result.provider
        ) {
          throw new DshConfigurationError(
            "DSH emitted a completed counted receipt without a matching admission",
          );
        }
      } else if (admission !== undefined) {
        throw new DshConfigurationError("DSH changed whether a tool invocation was counted");
      }
      return {
        schemaVersion: 1,
        callId: result.callId,
        id: result.id,
        runtimeName: result.runtimeName,
        provider: result.provider,
        counted: result.counted,
        completed: true,
        ok: result.ok,
        durationMs: result.durationMs,
        ...(result.code === undefined ? {} : { code: result.code }),
      };
    }
    if (admission === undefined) {
      throw new DshConfigurationError("DSH tool receipt sequence is malformed");
    }
    return {
      schemaVersion: 1,
      callId: admission.callId,
      id: admission.id,
      runtimeName: admission.runtimeName,
      provider: admission.provider,
      counted: true,
      completed: false,
      ok: false,
      durationMs: 0,
      code: "ACTION_TOOL_INCOMPLETE",
    };
  });
}

export function emptyInvocationCounts(): DshInvocationCounts {
  return { tools: {}, groups: {} };
}

function parseInvocationRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DshConfigurationError(`DSH invocation ${label} state is malformed`);
  }
  const parsed: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!allowedKeys.has(key) || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new DshConfigurationError(`DSH invocation ${label} state is malformed`);
    }
    parsed[key] = count as number;
  }
  return parsed;
}

export async function readInvocationCounts(
  path: string,
  rules: readonly DshPolicyRule[],
): Promise<DshInvocationCounts> {
  let text: string;
  try {
    const details = await stat(path);
    if (details.size > MAX_DSH_INVOCATION_STATE_BYTES) {
      throw new DshConfigurationError("DSH invocation state exceeded the Controller limit");
    }
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyInvocationCounts();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DshConfigurationError("DSH invocation state is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DshConfigurationError("DSH invocation state is malformed");
  }
  const state = value as Readonly<Record<string, unknown>>;
  if (
    state.schemaVersion !== 1 ||
    Object.keys(state).some((key) => !["schemaVersion", "tools", "groups"].includes(key))
  ) {
    throw new DshConfigurationError("DSH invocation state is malformed");
  }
  return {
    tools: parseInvocationRecord(state.tools, new Set(rules.map((rule) => rule.id)), "tool"),
    groups: parseInvocationRecord(
      state.groups,
      new Set(rules.map((rule) => rule.groupId)),
      "group",
    ),
  };
}

function invocationDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (!Number.isSafeInteger(delta) || delta < 0 || !Number.isSafeInteger(total + delta)) {
      throw new DshConfigurationError("DSH invocation counters moved backwards or overflowed");
    }
    total += delta;
  }
  return total;
}

export function reconcileToolAudit(
  before: DshInvocationCounts,
  after: DshInvocationCounts,
  receipts: readonly DshToolReceipt[],
  requireCompleted: boolean,
): void {
  const toolDelta = invocationDelta(before.tools, after.tools);
  const groupDelta = invocationDelta(before.groups, after.groups);
  const counted = receipts.filter((receipt) => receipt.counted).length;
  if (toolDelta !== groupDelta || toolDelta !== counted) {
    throw new DshConfigurationError(
      "DSH invocation counters and durable tool receipts do not reconcile",
    );
  }
  if (requireCompleted && receipts.some((receipt) => receipt.counted && !receipt.completed)) {
    throw new DshConfigurationError("DSH completed with an unfinished tool receipt");
  }
}
