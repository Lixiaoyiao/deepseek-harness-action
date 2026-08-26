import type { AgentToolReceipt } from "../agent/loop.js";
import type { AgentToolResult } from "../agent/contracts.js";

export interface GitHubToolFlushReceipt {
  readonly result: AgentToolResult;
  readonly durationMs: number;
}

export function githubFlushHasExternalEffect(receipts: readonly GitHubToolFlushReceipt[]): boolean {
  return receipts.some(({ result }) => {
    if (typeof result.output !== "object" || result.output === null) return false;
    const output = result.output as Record<string, unknown>;
    return (
      output.effect === "created" ||
      output.effect === "updated" ||
      output.externalEffect === "possible" ||
      output.externalEffect === "confirmed"
    );
  });
}

/** Replace deferred scheduling receipts with their bounded final Gateway receipts. */
export function mergeGitHubFlushReceipts(
  receipts: readonly AgentToolReceipt[],
  flushes: readonly GitHubToolFlushReceipt[],
): readonly AgentToolReceipt[] {
  const byCallId = new Map(flushes.map((flush) => [flush.result.callId, flush]));
  return receipts.map((receipt) => {
    const flush = byCallId.get(receipt.callId);
    if (flush === undefined) return receipt;
    const output =
      typeof flush.result.output === "object" && flush.result.output !== null
        ? (flush.result.output as Record<string, unknown>)
        : {};
    const effect = output.effect;
    return {
      ...receipt,
      ok: flush.result.ok,
      durationMs: receipt.durationMs + flush.durationMs,
      ...(effect === "created" ||
      effect === "updated" ||
      effect === "unchanged" ||
      effect === "read" ||
      effect === "scheduled"
        ? { effect }
        : {}),
      ...(!flush.result.ok ? { error: true } : {}),
      ...(typeof output.target === "string" && Buffer.byteLength(output.target, "utf8") <= 160
        ? { target: output.target }
        : {}),
      ...(typeof output.attempts === "number" &&
      Number.isInteger(output.attempts) &&
      output.attempts >= 0 &&
      output.attempts <= 2
        ? { attempts: output.attempts }
        : {}),
      ...(typeof output.reconciled === "boolean" ? { reconciled: output.reconciled } : {}),
      ...(output.externalEffect === "possible" || output.externalEffect === "confirmed"
        ? { externalEffect: output.externalEffect }
        : {}),
    };
  });
}

export class GitHubToolFlushError extends Error {
  public readonly receipts: readonly GitHubToolFlushReceipt[];
  public readonly hasExternalEffect: boolean;

  public constructor(receipts: readonly GitHubToolFlushReceipt[], options?: ErrorOptions) {
    super("A deferred GitHub tool mutation failed during Controller finalization", options);
    this.name = "GitHubToolFlushError";
    this.receipts = receipts;
    this.hasExternalEffect = githubFlushHasExternalEffect(receipts);
  }
}
