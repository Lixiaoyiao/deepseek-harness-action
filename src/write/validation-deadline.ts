import { settleWithin } from "../lifecycle/deadline.js";
import { ValidationFailureError } from "./validate.js";

export interface ValidationDeadline {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/** Stable timeout used when Controller-side validation exhausts its phase budget. */
export function validationDeadlineError(): ValidationFailureError {
  return new ValidationFailureError({
    argv: ["controller-validation"],
    result: {
      exitCode: 1,
      stdout: "",
      stderr: "Controller validation exceeded its independent phase timeout.",
      timedOut: true,
      outputTruncated: false,
    },
  });
}

/** Recompute, rather than snapshot, the remaining shared validation budget. */
export function remainingValidationMs(
  budget: ValidationDeadline,
  now: () => number = Date.now,
): number {
  if (!Number.isSafeInteger(budget.deadlineMs)) throw validationDeadlineError();
  const remaining = budget.deadlineMs - now();
  if (remaining <= 0) throw validationDeadlineError();
  return remaining;
}

/** Hard-bound one pre-mutation validation/revalidation read by the shared deadline. */
export async function withinValidationDeadline<T>(
  start: () => Promise<T>,
  budget: ValidationDeadline,
): Promise<T> {
  const timeoutMs = remainingValidationMs(budget);
  const bounded = await settleWithin(start(), timeoutMs, budget.signal);
  if (!bounded.settled) throw validationDeadlineError();
  return bounded.value;
}
