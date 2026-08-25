import * as core from "@actions/core";

import { AgentDeadlineError } from "../agent/loop.js";
import type { RoutedCommand } from "../commands/router.js";
import type { DshComposition, DshMode } from "../dsh/composition.js";
import { DshAbortedError } from "../dsh/errors.js";
import type { StickyProgressReporter } from "../github/progress.js";
import type { ActionInputs } from "../inputs.js";
import { PHASE_TIMEOUTS, settleWithin } from "../lifecycle/deadline.js";
import type { PermissionAudit, ToolPolicyAudit } from "../permissions/profile.js";
import {
  describeActionFailure,
  type ActionFailure,
  type ActionPhase,
  type AgentRunSummary,
  type ValidationSummary,
} from "../result.js";
import type { AuthorityAudit } from "../security/authority.js";
import type { SecurityPolicy } from "../security/policy.js";
import type { ValidationIntegritySummary } from "../write/validation-integrity.js";
import type { WriteOutcome } from "./write.js";

export interface RunState {
  phase: ActionPhase;
  operation?: RoutedCommand["operation"];
  policy?: SecurityPolicy;
  progress?: StickyProgressReporter;
  runUrl?: string;
  agent?: AgentRunSummary;
  validationCommandCount?: number;
  permission?: PermissionAudit;
  toolPolicy?: ToolPolicyAudit;
  authority?: AuthorityAudit;
  validationIntegrity?: ValidationIntegritySummary;
  validationIntegrityWarning?: string;
  validationPassed?: boolean;
  dsh?: { readonly mode: DshMode; readonly composition: string };
  composition?: DshComposition;
  progressFailure?: ProgressFailureFinalization;
  partialWrite?: WriteOutcome;
}

interface ProgressFailureFinalization {
  readonly failure: ActionFailure;
  readonly deadlineMs: number;
  status: "pending" | "succeeded" | "failed";
  promise: Promise<void>;
}

export interface RunDeadline {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createRunDeadline(
  startedAt: number,
  timeoutMinutes: number,
  parentSignal?: AbortSignal,
): RunDeadline {
  const deadlineMs = startedAt + timeoutMinutes * 60_000;
  const controller = new AbortController();
  const abort = (): void => controller.abort(new AgentDeadlineError());
  const remainingMs = deadlineMs - Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (remainingMs <= 0) abort();
  else {
    timer = setTimeout(abort, remainingMs);
    timer.unref();
  }
  return {
    deadlineMs,
    signal:
      parentSignal === undefined
        ? controller.signal
        : AbortSignal.any([parentSignal, controller.signal]),
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

export function failureFromSignal(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted !== true || !(signal.reason instanceof Error)) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current === signal.reason || current.name === "AbortError") return signal.reason;
    current = current.cause;
  }
  return error;
}

export function isCancellationError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (
      current instanceof DshAbortedError ||
      current.message === "DSH execution was aborted" ||
      ("code" in current && current.code === "DSH_ABORTED")
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function progressFailureStatus(
  attempt: ProgressFailureFinalization,
): ProgressFailureFinalization["status"] {
  // Promise callbacks mutate this field asynchronously. Keep the read behind a
  // function so TypeScript does not narrow the earlier pending observation.
  return attempt.status;
}

export function startProgressFailure(
  state: RunState,
  error: unknown,
  failureOverride?: ActionFailure,
): ProgressFailureFinalization | undefined {
  const progress = state.progress;
  if (progress === undefined) return undefined;
  const failure = failureOverride ?? describeActionFailure(error, state.phase);
  const existing = state.progressFailure;
  if (
    existing !== undefined &&
    (existing.failure.code !== "DSH_ABORTED" || failure.code === "DSH_ABORTED")
  ) {
    return existing;
  }
  const attempt: ProgressFailureFinalization = {
    failure,
    deadlineMs: Date.now() + PHASE_TIMEOUTS.cancellationFinalizationMs,
    status: "pending",
    promise: Promise.resolve(),
  };
  attempt.promise = Promise.resolve()
    .then(async () => progress.fail(attempt.failure))
    .then(
      () => {
        attempt.status = "succeeded";
      },
      () => {
        attempt.status = "failed";
      },
    );
  state.progressFailure = attempt;
  return attempt;
}

export async function finishProgressFailure(
  state: RunState,
  error: unknown,
  failureOverride?: ActionFailure,
): Promise<void> {
  const attempt = state.progressFailure ?? startProgressFailure(state, error, failureOverride);
  if (attempt === undefined || attempt.status === "succeeded") return;
  if (attempt.status === "failed") {
    core.warning(
      "The best-effort progress comment finalization failed; the primary action result was preserved.",
    );
    return;
  }
  const remainingMs = Math.max(0, attempt.deadlineMs - Date.now());
  if (remainingMs > 0) {
    const result = await settleWithin(attempt.promise, remainingMs);
    if (result.settled && progressFailureStatus(attempt) === "succeeded") return;
    if (result.settled && progressFailureStatus(attempt) === "failed") {
      core.warning(
        "The best-effort progress comment finalization failed; the primary action result was preserved.",
      );
      return;
    }
  }
  core.warning(
    "The best-effort progress comment finalization timed out; the primary action result was preserved.",
  );
}

export function outcomeContext(state: RunState, startedAt: number) {
  return {
    schemaVersion: 1 as const,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(state.runUrl === undefined ? {} : { runUrl: state.runUrl }),
    ...(state.policy === undefined ? {} : { policy: state.policy }),
    ...(state.agent === undefined ? {} : { agent: state.agent }),
    ...(state.permission === undefined ? {} : { permission: state.permission }),
    ...(state.toolPolicy === undefined ? {} : { toolPolicy: state.toolPolicy }),
    ...(state.dsh === undefined ? {} : { dsh: state.dsh }),
    ...(state.authority === undefined ? {} : { authority: state.authority }),
    ...(state.progress?.commentId === undefined ? {} : { commentId: state.progress.commentId }),
  };
}

export function successfulValidation(
  inputs: ActionInputs,
  integrity?: ValidationIntegritySummary,
): ValidationSummary {
  return {
    status: "passed",
    commandCount: inputs.testCommands.length,
    ...(integrity === undefined ? {} : { integrity }),
  };
}
