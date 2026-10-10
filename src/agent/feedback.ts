import { isRecord } from "../security/record.js";
import { createHash } from "node:crypto";
import { utf8Prefix, utf8Suffix } from "../security/utf8.js";
import type { ValidationFailureError } from "../write/validate.js";

export interface LoopFeedback {
  readonly kind: "tool" | "validation";
  readonly turn: number;
  readonly data: unknown;
}

export function bounded(value: string, maximumBytes = 12 * 1024): string {
  const cap = Math.max(0, Math.floor(maximumBytes));
  if (Buffer.byteLength(value, "utf8") <= cap) return value;
  const marker = "\n[truncated by dsh-action]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return markerBytes >= cap
    ? utf8Prefix(marker, cap)
    : utf8Prefix(value, cap - markerBytes) + marker;
}

function boundedHeadTail(value: string, maximumBytes = 6 * 1024): string {
  const cap = Math.max(0, Math.floor(maximumBytes));
  if (Buffer.byteLength(value, "utf8") <= cap) return value;
  const marker = "\n[...truncated by dsh-action...]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= cap) return utf8Prefix(marker, cap);
  const available = cap - markerBytes;
  const headBytes = Math.floor(available / 3);
  const tailBytes = available - headBytes;
  return utf8Prefix(value, headBytes) + marker + utf8Suffix(value, tailBytes);
}

export function boundedFeedbackData(value: unknown): unknown {
  let candidate = value;
  if (isRecord(value)) {
    const record = value;
    const output = record.output;
    if (isRecord(output)) {
      const processOutput = output;
      if (typeof processOutput.stdout === "string" && typeof processOutput.stderr === "string") {
        candidate = {
          ...record,
          output: {
            ...processOutput,
            stdout: boundedHeadTail(processOutput.stdout, 5 * 1024),
            stderr: boundedHeadTail(processOutput.stderr, 5 * 1024),
          },
        };
      }
    }
  }
  const serialized = JSON.stringify(candidate);
  const boundedValue = bounded(serialized);
  if (boundedValue === serialized) return candidate;
  return { untrusted: true, truncated: true, jsonPrefix: boundedValue };
}

export function validationFeedback(
  error: ValidationFailureError,
  redact: (value: string) => string,
): unknown {
  return {
    untrusted: true,
    argv: error.argv,
    exitCode: error.exitCode,
    timedOut: error.timedOut,
    truncated: error.outputTruncated,
    stdout: boundedHeadTail(redact(error.result.stdout)),
    stderr: boundedHeadTail(redact(error.result.stderr)),
  };
}

export function feedbackFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (Array.isArray(candidate)) return candidate.map((item) => normalize(item));
    if (typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}

export interface TaskContextAnchor {
  readonly sha256: string;
  readonly byteLength: number;
  readonly jsonPrefix: string;
}

export function turnContext(
  context: unknown,
  anchor: TaskContextAnchor,
  turn: number,
  feedback: readonly LoopFeedback[],
): unknown {
  return {
    controllerLoop: {
      protocolVersion: 1,
      turn,
      taskContextAnchor: anchor,
      // Newest repair evidence is serialized first so prompt truncation keeps it.
      feedback: feedback.slice(-6).reverse(),
    },
    taskContext: context,
  };
}
