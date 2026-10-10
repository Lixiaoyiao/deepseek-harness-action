import type { DshRuntime } from "../dsh/runner.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs, settleWithin } from "../lifecycle/deadline.js";
import { AgentDeadlineError } from "./loop-errors.js";
import type { AgentLoopHooks } from "./loop-contracts.js";
import type { AgentEngine, AgentTurnRequest, AgentTurnResponse } from "./contracts.js";
import type { DshOutput } from "../dsh/schema.js";
import type { DshTurnMetadata } from "../review/run.js";

export async function createRuntimeWithinDeadline(
  createRuntime: () => Promise<DshRuntime>,
  disposeRuntime: (runtime: DshRuntime) => Promise<void>,
  hooks: Pick<AgentLoopHooks<unknown>, "deadlineMs" | "signal">,
  now: () => number,
): Promise<DshRuntime> {
  throwIfCancelled(hooks.signal);
  const timeoutMs = phaseTimeoutMs(hooks.deadlineMs, PHASE_TIMEOUTS.runtimeCreateMs, now);
  if (timeoutMs <= 0) throw new AgentDeadlineError();
  const creation = createRuntime();
  let result: { readonly settled: true; readonly value: DshRuntime } | { readonly settled: false };
  try {
    result = await settleWithin(creation, timeoutMs, hooks.signal);
  } catch (error: unknown) {
    void creation.then(disposeRuntime).catch(() => undefined);
    throw error;
  }
  if (result.settled) return result.value;
  void creation.then(disposeRuntime).catch(() => undefined);
  throw new AgentDeadlineError("Agent runtime initialization exceeded its phase timeout");
}

export async function runLifecycleHookWithinDeadline(
  label: "turn progress" | "validation retry progress" | "Session restoration",
  hook: () => void | Promise<void>,
  hooks: Pick<AgentLoopHooks<unknown>, "deadlineMs" | "signal">,
  now: () => number,
): Promise<void> {
  throwIfCancelled(hooks.signal);
  const timeoutMs = phaseTimeoutMs(hooks.deadlineMs, PHASE_TIMEOUTS.setupMs, now);
  if (timeoutMs <= 0) throw new AgentDeadlineError();
  const result = await settleWithin(Promise.resolve().then(hook), timeoutMs, hooks.signal);
  if (!result.settled) {
    throw new AgentDeadlineError(`Agent ${label} hook exceeded its phase timeout`);
  }
}

/** The Controller owns the deadline even when an engine does not settle on abort. */
export async function runEngineTurnWithinDeadline(
  engine: AgentEngine<DshOutput, DshTurnMetadata>,
  request: AgentTurnRequest,
  now: () => number = Date.now,
): Promise<AgentTurnResponse<DshOutput, DshTurnMetadata>> {
  throwIfCancelled(request.signal);
  const remainingMs = request.deadlineMs - now();
  if (!Number.isSafeInteger(remainingMs) || remainingMs <= 0) throw new AgentDeadlineError();
  const controller = new AbortController();
  const signal =
    request.signal === undefined
      ? controller.signal
      : AbortSignal.any([request.signal, controller.signal]);
  try {
    const result = await settleWithin(engine.runTurn({ ...request, signal }), remainingMs, signal);
    if (!result.settled) throw new AgentDeadlineError("Agent execution exceeded the run deadline");
    return result.value;
  } catch (error: unknown) {
    controller.abort(error);
    throw error;
  }
}

/** Every disposer gets an attempt within one shared grace period. */
export async function disposeAgentLoop(
  disposers: readonly {
    readonly component: "tool-provider" | "engine" | "runtime";
    readonly dispose: (() => Promise<void>) | undefined;
  }[],
  report: AgentLoopHooks<unknown>["onCleanupError"],
): Promise<void> {
  const deadlineMs = Date.now() + PHASE_TIMEOUTS.cleanupMs;
  let engineDisposal: Promise<void> | undefined;
  for (const { component, dispose } of disposers) {
    if (dispose === undefined) continue;
    // Runtime files remain borrowed by an active engine even after its cleanup
    // acknowledgement exceeds our grace. Schedule late removal after actual
    // quiescence; a race timeout is not proof that the worker stopped.
    const disposal =
      component === "runtime" && engineDisposal !== undefined
        ? engineDisposal.catch(() => undefined).then(dispose)
        : Promise.resolve().then(dispose);
    if (component === "engine") engineDisposal = disposal;
    try {
      const result = await settleWithin(disposal, Math.max(0, deadlineMs - Date.now()));
      if (!result.settled) throw new Error(`Agent ${component} cleanup exceeded its phase timeout`);
    } catch (error: unknown) {
      try {
        await settleWithin(
          Promise.resolve().then(() => report?.(component, error)),
          Math.max(0, deadlineMs - Date.now()),
        );
      } catch {
        // Cleanup reporting must never replace the primary loop outcome.
      }
    }
  }
}
