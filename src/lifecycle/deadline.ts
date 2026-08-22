export const PHASE_TIMEOUTS = {
  runtimeCreateMs: 30_000,
  runtimeInstallMs: 5 * 60_000,
  extensionInstallMs: 5 * 60_000,
  setupMs: 60_000,
  agentTurnMs: 10 * 60_000,
  validationMs: 10 * 60_000,
  cleanupMs: 5_000,
  cancellationFinalizationMs: 5_000,
} as const;

/** Bound one phase by both its audited cap and the immutable run deadline. */
export function phaseTimeoutMs(
  deadlineMs: number,
  capMs: number,
  now: () => number = Date.now,
): number {
  if (!Number.isSafeInteger(deadlineMs) || !Number.isSafeInteger(capMs) || capMs <= 0) {
    throw new Error("Deadline and phase timeout cap must be positive safe integers");
  }
  return Math.max(0, Math.min(capMs, deadlineMs - now()));
}

export async function settleWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    // Callers intentionally start cleanup/setup work before consulting the
    // shared budget. Observe a rejection even when no race can be installed,
    // otherwise an exhausted budget can turn best-effort work into an
    // unhandled rejection after the primary outcome has already returned.
    void promise.catch(() => undefined);
    return { settled: false };
  }
  const abortReason = (): Error =>
    signal?.reason instanceof Error ? signal.reason : new Error("Operation was cancelled");
  if (signal?.aborted === true) {
    void promise.catch(() => undefined);
    throw abortReason();
  }
  return await new Promise((resolve, reject) => {
    let finished = false;
    const finish = (
      outcome:
        | {
            readonly kind: "resolve";
            readonly value:
              { readonly settled: true; readonly value: T } | { readonly settled: false };
          }
        | { readonly kind: "reject"; readonly error: unknown },
    ): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (outcome.kind === "resolve") resolve(outcome.value);
      else {
        reject(
          outcome.error instanceof Error
            ? outcome.error
            : new Error("Operation failed with a non-Error value", { cause: outcome.error }),
        );
      }
    };
    const abort = (): void => finish({ kind: "reject", error: abortReason() });
    const timer = setTimeout(
      () => finish({ kind: "resolve", value: { settled: false } }),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
    promise.then(
      (value) => finish({ kind: "resolve", value: { settled: true, value } }),
      (error: unknown) => finish({ kind: "reject", error }),
    );
  });
}
