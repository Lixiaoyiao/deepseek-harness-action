import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { settleWithin } from "../lifecycle/deadline.js";
import { DshTimeoutError } from "./errors.js";
import {
  PHASE_TIMEOUTS,
  phaseTimeoutMs,
  runBestEffortDshCleanup,
  type BestEffortCleanupTask,
} from "./timeouts.js";

/** One immutable execution deadline, cumulative setup budget and owned cleanup ledger. */
export class DshRunScope {
  private setupBudgetMs: number = PHASE_TIMEOUTS.setupMs;
  private readonly cleanups: BestEffortCleanupTask[] = [];
  public readonly startedAt: number;
  public readonly deadlineMs: number;
  private readonly timeoutMs: number;
  public readonly signal: AbortSignal | undefined;
  public readonly now: () => number;
  private readonly warning: (message: string) => void;

  public constructor(
    startedAt: number,
    deadlineMs: number,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    now: () => number,
    warning: (message: string) => void,
  ) {
    this.startedAt = startedAt;
    this.deadlineMs = deadlineMs;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.now = now;
    this.warning = warning;
  }

  public remaining(capMs: number): number {
    throwIfCancelled(this.signal);
    if (capMs <= 0) throw new DshTimeoutError(this.timeoutMs);
    const remaining = phaseTimeoutMs(this.deadlineMs, capMs, this.now);
    if (remaining <= 0) throw new DshTimeoutError(this.timeoutMs);
    return remaining;
  }

  public async phase<T>(
    run: () => Promise<T>,
    capMs: number,
    disposeLateValue?: (value: T) => Promise<void>,
  ): Promise<T> {
    const timeoutMs = this.remaining(capMs);
    const pending = Promise.resolve().then(run);
    const disposeLate = (): void => {
      if (disposeLateValue === undefined) return;
      // Late acquisitions get the same bounded cleanup treatment as values
      // acquired before the deadline. Their rejection cannot replace the outcome.
      void pending
        .then(async (value) =>
          runBestEffortDshCleanup(
            [{ label: "late acquisition", run: async () => disposeLateValue(value) }],
            PHASE_TIMEOUTS.cleanupMs,
            this.warning,
          ),
        )
        .catch(() => undefined);
    };
    try {
      const result = await settleWithin(pending, timeoutMs, this.signal);
      if (result.settled) return result.value;
    } catch (error: unknown) {
      disposeLate();
      throw error;
    }
    disposeLate();
    throw new DshTimeoutError(timeoutMs);
  }

  public async setup<T>(
    run: () => Promise<T>,
    disposeLateValue?: (value: T) => Promise<void>,
  ): Promise<T> {
    const startedAt = this.now();
    try {
      return await this.phase(run, this.setupBudgetMs, disposeLateValue);
    } finally {
      this.setupBudgetMs = Math.max(0, this.setupBudgetMs - Math.max(0, this.now() - startedAt));
    }
  }

  /** A cancelled transport does not prove that its remote side effect did not happen. */
  public async effect<T>(
    run: () => Promise<T>,
    capMs: number,
    cleanup: BestEffortCleanupTask,
  ): Promise<T> {
    this.remaining(capMs);
    this.own(cleanup.label, cleanup.run);
    let awaitingReceipt = true;
    const pending = Promise.resolve().then(run);
    const reconcileLate = async (): Promise<void> => {
      if (!awaitingReceipt) {
        await runBestEffortDshCleanup([cleanup], PHASE_TIMEOUTS.cleanupMs, this.warning);
      }
    };
    // Observe the actual adapter, including a late rejection: either outcome may
    // follow an installed resource whose acknowledgement was lost.
    void pending.then(reconcileLate, reconcileLate).catch(() => undefined);
    try {
      return await this.phase(async () => pending, capMs);
    } finally {
      awaitingReceipt = false;
    }
  }

  public own(label: string, dispose: () => Promise<unknown>): void {
    this.cleanups.push({ label, run: dispose });
  }

  public async close(): Promise<void> {
    await runBestEffortDshCleanup(
      this.cleanups.toReversed(),
      PHASE_TIMEOUTS.cleanupMs,
      this.warning,
    );
  }
}
