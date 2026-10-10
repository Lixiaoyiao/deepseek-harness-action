import { z } from "zod";

import { DshMalformedOutputError } from "./errors.js";
import { assertNoSecretOutput } from "../security/env.js";
import { stepModelUsage, mergeModelUsage, type ModelUsage } from "./usage.js";

const truncated = { truncated: z.literal(true).optional() };
const count = z.number().int().nonnegative();
const eventSchema = z.union([
  z.strictObject({
    type: z.literal("session"),
    sessionId: z.string().min(1),
    cwd: z.string(),
    ...truncated,
  }),
  z.strictObject({
    type: z.literal("status"),
    phase: z.enum(["turn_start", "step_start", "step_end", "turn_end"]),
    turn: count,
    step: count.optional(),
    reason: z.json().optional(),
    usage: z.json().optional(),
    ...truncated,
  }),
  z.strictObject({ type: z.enum(["thinking", "text"]), text: z.string(), ...truncated }),
  z.strictObject({
    type: z.literal("tool_call"),
    callId: z.string(),
    tool: z.string(),
    input: z.json().optional(),
    ...truncated,
  }),
  z.strictObject({
    type: z.literal("tool_result"),
    callId: z.string(),
    status: z.enum(["error", "completed"]),
    result: z.string(),
    ...truncated,
  }),
  // The official projection may discard every field except type/truncated
  // when its per-event budget is exceeded. This is telemetry, never authority.
  z.strictObject({
    type: z.enum(["session", "status", "thinking", "text", "tool_call", "tool_result"]),
    truncated: z.literal(true),
  }),
  z.strictObject({ type: z.literal("final"), text: z.string() }),
]);

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedHeadlessEvents(stdout: string, secrets: readonly string[]): readonly unknown[] {
  assertNoSecretOutput("stdout", stdout, secrets);
  const parsed: unknown[] = stdout
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    });
  // Escaped credentials in discarded telemetry still constitute a worker leak.
  for (const entry of parsed) {
    if (entry !== undefined) assertNoSecretOutput("stdout", JSON.stringify(entry), secrets);
  }
  return parsed;
}

function modelUsageFromEvents(
  events: readonly unknown[],
  terminalConfirmed: boolean,
): ModelUsage | undefined {
  let usage: ModelUsage | undefined;
  let incomplete = !terminalConfirmed;
  const steps = new Set<string>();
  for (const entry of events) {
    const event = eventSchema.safeParse(entry);
    if (!event.success) {
      incomplete = true;
      continue;
    }
    const data = event.data;
    if (data.type !== "status") continue;
    if (data.truncated === true || !("phase" in data)) incomplete = true;
    if (!("phase" in data) || data.phase !== "step_end") continue;
    if (data.step === undefined) incomplete = true;
    const key = `${String(data.turn)}:${String(data.step)}`;
    if (steps.has(key)) {
      incomplete = true;
      continue;
    }
    steps.add(key);
    const sample = stepModelUsage(data.usage);
    usage = usage === undefined ? sample : mergeModelUsage(usage, sample);
  }
  return usage === undefined
    ? undefined
    : incomplete
      ? { ...usage, completeness: "partial" }
      : usage;
}

/** Preserve known samples from a failed/incomplete stream without admitting its business result. */
export function headlessModelUsage(
  stdout: string,
  secrets: readonly string[] = [],
): ModelUsage | undefined {
  return modelUsageFromEvents(parsedHeadlessEvents(stdout, secrets), false);
}

/**
 * Decode the published headless transport, independently of the business
 * schema. Retain the official text output contract for custom host launchers.
 * Never interpret projected tool calls/results as Controller requests/receipts.
 * Protocol failures must be caught outside the tool-free business repair path.
 */
export function decodeHeadlessResult(
  stdout: string,
  secrets: readonly string[] = [],
): { readonly text: string; readonly usage?: ModelUsage } {
  const parsed = parsedHeadlessEvents(stdout, secrets);
  const projected = parsed.some((entry) => object(entry) && Object.hasOwn(entry, "type"));
  if (!projected) return { text: stdout };

  let final: string | undefined;
  for (const [index, entry] of parsed.entries()) {
    const event = eventSchema.safeParse(entry);
    if (!event.success) {
      throw new DshMalformedOutputError("DSH headless stream contains an invalid or error event");
    }
    const data = event.data;
    if (index === 0 && data.type !== "session") {
      throw new DshMalformedOutputError("DSH headless stream must begin with one session event");
    }
    if (index > 0 && data.type === "session") {
      throw new DshMalformedOutputError("DSH headless stream contains multiple sessions");
    }
    if (final !== undefined) {
      throw new DshMalformedOutputError("DSH headless stream contains data after its final event");
    }
    if (data.type === "final") final = data.text;
  }
  if (final === undefined) {
    throw new DshMalformedOutputError("DSH headless stream has no final event");
  }
  const usage = modelUsageFromEvents(parsed, true);
  return { text: final, ...(usage === undefined ? {} : { usage }) };
}

/** Compatibility text interface; transport telemetry never becomes business authority. */
export function headlessResultText(stdout: string, secrets: readonly string[] = []): string {
  return decodeHeadlessResult(stdout, secrets).text;
}
