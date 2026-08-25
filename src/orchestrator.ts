/*
 * Lifecycle adapted from anthropics/claude-code-action/src/entrypoints/run.ts.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import * as core from "@actions/core";

import { DshAbortedError } from "./dsh/errors.js";
import { selectDshComposition } from "./dsh/select-composition.js";
import { loadInputs, type ActionInputs } from "./inputs.js";
import { throwIfCancelled } from "./lifecycle/cancellation.js";
import {
  describeActionFailure,
  describeCancellationFailure,
  type RunOutcome,
  type ValidationSummary,
} from "./result.js";
import { buildAuthorityAudit } from "./security/authority.js";
import { ValidationIntegrityError } from "./write/validation-integrity.js";
import { runAgentPhase } from "./orchestration/agent-phase.js";
import { prepareExecution } from "./orchestration/execution.js";
import {
  createRunDeadline,
  failureFromSignal,
  finishProgressFailure,
  isCancellationError,
  outcomeContext,
  startProgressFailure,
  type RunDeadline,
  type RunState,
} from "./orchestration/lifecycle.js";
import { prepareAuthorizedRun } from "./orchestration/prepare.js";
import {
  disposeWorkspace,
  prepareWorkspace,
  type PreparedWorkspace,
} from "./orchestration/workspace.js";

export {
  assertOperationContext,
  boundedText,
  deferProgressUntilWriteValidation,
} from "./orchestration/context.js";

export interface RunActionOptions {
  readonly signal?: AbortSignal;
}

/** Prepare -> authorize/context -> capabilities -> Agent -> validate/finalize -> result. */
async function runActionInternal(
  state: RunState,
  startedAt: number,
  inputs: ActionInputs,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<RunOutcome> {
  const preparation = await prepareAuthorizedRun({ state, startedAt, inputs, signal });
  if (preparation.kind === "complete") return preparation.outcome;

  state.phase = "context";
  let workspace: PreparedWorkspace | undefined;
  try {
    workspace = await prepareWorkspace({
      client: preparation.run.client,
      context: preparation.run.context,
      ...(preparation.run.snapshot === undefined ? {} : { snapshot: preparation.run.snapshot }),
      ...(preparation.run.baseBranch === undefined
        ? {}
        : { baseBranch: preparation.run.baseBranch }),
      inputs,
      policy: preparation.run.policy,
      signal,
      onFailureBeforeCleanup: (error) => {
        startProgressFailure(
          state,
          error,
          isCancellationError(error) ? describeCancellationFailure(state.phase) : undefined,
        );
      },
    });
    const execution = await prepareExecution({
      state,
      authorized: preparation.run,
      workspace,
      inputs,
      deadlineMs,
      signal,
    });
    return await runAgentPhase({
      state,
      startedAt,
      authorized: preparation.run,
      workspace,
      execution,
      inputs,
      signal,
      deadlineMs,
    });
  } catch (error: unknown) {
    if (error instanceof ValidationIntegrityError) state.validationIntegrity = error.audit;
    // Start terminal publication before bounded temporary-workspace cleanup.
    startProgressFailure(
      state,
      error,
      isCancellationError(error) ? describeCancellationFailure(state.phase) : undefined,
    );
    throw error;
  } finally {
    if (workspace !== undefined) await disposeWorkspace(workspace);
  }
}

export async function runAction(options: RunActionOptions = {}): Promise<RunOutcome> {
  const startedAt = Date.now();
  const state: RunState = { phase: "configuration" };
  let deadline: RunDeadline | undefined;
  const beginCancellationFinalization = (): void => {
    if (state.progress === undefined || state.phase === "publication" || state.phase === "write") {
      return;
    }
    // A cancellation signal is routing information, not public failure identity.
    startProgressFailure(state, new DshAbortedError(), describeCancellationFailure(state.phase));
  };
  options.signal?.addEventListener("abort", beginCancellationFinalization, { once: true });
  if (options.signal?.aborted === true) beginCancellationFinalization();
  try {
    throwIfCancelled(options.signal);
    const inputs = loadInputs();
    const compositionSelection = selectDshComposition(inputs.dshMode);
    const composition = compositionSelection.create();
    state.composition = composition;
    state.dsh = { mode: compositionSelection.mode, composition: composition.id };
    core.info(`DSH mode ${compositionSelection.mode}; composition ${composition.id}`);
    state.authority = buildAuthorityAudit();
    deadline = createRunDeadline(startedAt, inputs.timeoutMinutes, options.signal);
    return await runActionInternal(state, startedAt, inputs, deadline.signal, deadline.deadlineMs);
  } catch (error: unknown) {
    // Preserve an independent validation/security/write failure if cancellation races it.
    const effectiveError = failureFromSignal(error, deadline?.signal);
    const failure = isCancellationError(effectiveError)
      ? describeCancellationFailure(state.phase)
      : describeActionFailure(effectiveError, state.phase);
    await finishProgressFailure(state, effectiveError, failure);
    const validation: ValidationSummary | undefined =
      failure.phase === "validation" || state.validationIntegrity !== undefined
        ? {
            status:
              failure.phase === "validation" || state.validationPassed !== true
                ? "failed"
                : "passed",
            commandCount: state.validationCommandCount ?? 0,
            ...(state.validationIntegrity === undefined
              ? {}
              : { integrity: state.validationIntegrity }),
          }
        : undefined;
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "failure",
      ...(state.operation === undefined ? {} : { operation: state.operation }),
      summary: failure.title,
      findingsCount: 0,
      ...(validation === undefined ? {} : { validation }),
      ...(state.partialWrite ?? {}),
      error: failure,
    };
  } finally {
    deadline?.dispose();
    options.signal?.removeEventListener("abort", beginCancellationFinalization);
  }
}

export function reportFailure(error: unknown): string {
  return describeActionFailure(error, "agent").message;
}
