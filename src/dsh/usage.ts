import { z } from "zod";

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tokenUsageSchema = z
  .object({
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    totalTokens: tokenCount.optional(),
    cacheReadTokens: tokenCount.optional(),
    cacheWriteTokens: tokenCount.optional(),
    reasoningTokens: tokenCount.optional(),
  })
  .refine((usage) => {
    if (usage.reasoningTokens !== undefined && usage.reasoningTokens > usage.outputTokens)
      return false;
    const knownPrompt =
      usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (!Number.isSafeInteger(knownPrompt)) return false;
    if (usage.totalTokens === undefined) return true;
    const exactPrompt = usage.totalTokens - usage.outputTokens;
    if (exactPrompt < knownPrompt) return false;
    return (
      usage.cacheReadTokens === undefined ||
      usage.cacheWriteTokens === undefined ||
      exactPrompt === knownPrompt
    );
  });

/** DSH rc.2 reports disjoint input/cache buckets; reasoning is part of output. */
export type TokenUsage = z.infer<typeof tokenUsageSchema>;
export interface ModelUsage {
  readonly source: "headless-worker";
  readonly completeness: "complete" | "partial";
  readonly reportedSteps: number;
  readonly observedSteps: number;
  /** Subtotal of the valid reported steps, never an invoice or inferred run total. */
  readonly tokens?: TokenUsage;
}

/** Missing or invalid metadata remains unknown rather than becoming zero usage. */
export function stepModelUsage(value: unknown): ModelUsage {
  const parsed = tokenUsageSchema.safeParse(value);
  return {
    source: "headless-worker",
    completeness: parsed.success ? "complete" : "partial",
    reportedSteps: parsed.success ? 1 : 0,
    observedSteps: 1,
    ...(parsed.success ? { tokens: parsed.data } : {}),
  };
}

/** Optional buckets are summed only when every reported contribution has them. */
export function mergeModelUsage(previous: ModelUsage, next: ModelUsage): ModelUsage {
  const a = previous.tokens;
  const b = next.tokens;
  // A reported subtotal with no representable core counters has already
  // overflowed. Later samples cannot turn that unknown subtotal into a total.
  let overflow =
    (a === undefined && previous.reportedSteps > 0) || (b === undefined && next.reportedSteps > 0);
  let tokens = overflow ? undefined : (a ?? b);
  let optionalOverflow = false;
  if (!overflow && a !== undefined && b !== undefined) {
    const inputTokens = a.inputTokens + b.inputTokens;
    const outputTokens = a.outputTokens + b.outputTokens;
    const optional: Record<string, number> = {};
    for (const key of [
      "totalTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "reasoningTokens",
    ] as const) {
      const left = a[key];
      const right = b[key];
      if (left === undefined || right === undefined) continue;
      const sum = left + right;
      if (!Number.isSafeInteger(sum)) optionalOverflow = true;
      else optional[key] = sum;
    }
    overflow ||= !Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens);
    tokens = overflow ? undefined : { inputTokens, outputTokens, ...optional };
  }
  return {
    source: "headless-worker",
    completeness:
      !overflow &&
      !optionalOverflow &&
      previous.completeness === "complete" &&
      next.completeness === "complete"
        ? "complete"
        : "partial",
    reportedSteps: previous.reportedSteps + next.reportedSteps,
    observedSteps: previous.observedSteps + next.observedSteps,
    ...(tokens === undefined ? {} : { tokens }),
  };
}
