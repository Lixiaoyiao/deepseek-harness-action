import { settleWithin } from "../lifecycle/deadline.js";

export { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";

export interface BestEffortCleanupTask {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

function warnBestEffort(warning: (message: string) => void, message: string): void {
  try {
    warning(message);
  } catch {
    // Observability must never turn cleanup into the primary failure.
  }
}

async function settleCleanupTask(
  task: BestEffortCleanupTask,
  timeoutMs: number,
  warning: (message: string) => void,
): Promise<void> {
  try {
    const result = await settleWithin(Promise.resolve().then(task.run), timeoutMs);
    if (!result.settled) {
      warnBestEffort(
        warning,
        `DSH ${task.label} cleanup did not complete; the primary result was preserved.`,
      );
    }
  } catch {
    warnBestEffort(
      warning,
      `DSH ${task.label} cleanup did not complete; the primary result was preserved.`,
    );
  }
}

/**
 * Run independent cleanup actions concurrently under one short cap. Every
 * rejection/timeout is observed and reduced to a bounded warning.
 */
export async function runBestEffortDshCleanup(
  tasks: readonly BestEffortCleanupTask[],
  timeoutMs: number,
  warning: (message: string) => void,
): Promise<void> {
  await Promise.all(tasks.map(async (task) => settleCleanupTask(task, timeoutMs, warning)));
}
