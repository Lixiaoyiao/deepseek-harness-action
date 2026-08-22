import { createHash } from "node:crypto";

import {
  AGENT_PROTOCOL_VERSION,
  type AgentEngine,
  type AgentToolResult,
  type ToolProvider,
} from "./contracts.js";
import {
  createDshRuntime,
  disposeDshRuntime,
  type DshRunResult,
  type DshRuntime,
  type DshToolReceipt,
} from "../dsh/runner.js";
import { DshError, DshMalformedOutputError, type DshFailureTelemetry } from "../dsh/errors.js";
import { ClassifiedActionError } from "../errors.js";
import { parseDshOutput, type DshOutput } from "../dsh/schema.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs, settleWithin } from "../lifecycle/deadline.js";
import { DshAgentEngine, type AgentTask, type DshTurnMetadata } from "../review/run.js";
import { ValidationFailureError } from "../write/validate.js";
import { fingerprintWorkspace } from "../write/workspace.js";

export class AgentLoopLimitError extends ClassifiedActionError<"AGENT_TURN_LIMIT"> {
  public constructor(maxTurns: number, options?: ErrorOptions) {
    super(
      `Agent did not reach a final result within ${String(maxTurns)} turns`,
      { code: "AGENT_TURN_LIMIT", category: "domain", retryable: false },
      options,
    );
  }
}

export class AgentDeadlineError extends ClassifiedActionError<"AGENT_TIMEOUT"> {
  public constructor(message = "The controller-owned agent loop exceeded its overall timeout") {
    super(message, { code: "AGENT_TIMEOUT", category: "runtime", retryable: true });
  }
}

export class AgentNoProgressError extends ClassifiedActionError<"AGENT_NO_PROGRESS"> {
  public constructor(options?: ErrorOptions) {
    super(
      "Validation failed twice with the same workspace revision and error",
      { code: "AGENT_NO_PROGRESS", category: "domain", retryable: false },
      options,
    );
  }
}

interface LoopFeedback {
  readonly kind: "tool" | "validation";
  readonly turn: number;
  readonly data: unknown;
}

export interface AgentLoopStats {
  readonly turns: number;
  readonly toolCalls: number;
  readonly validationRetries: number;
  readonly toolReceipts: readonly AgentToolReceipt[];
}

export interface AgentToolReceipt {
  readonly callId: string;
  readonly id: string;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly timedOut?: boolean;
  readonly error?: boolean;
  readonly effect?: "read" | "scheduled" | "created" | "updated" | "unchanged";
  readonly target?: string;
  readonly attempts?: number;
  readonly reconciled?: boolean;
}

export interface AgentLoopResult<TFinal = undefined> {
  readonly agent: DshRunResult;
  readonly stats: AgentLoopStats;
  readonly finalization: TFinal;
}

export interface AgentLoopHooks<TFinal> {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
  readonly toolProvider?: ToolProvider;
  readonly blocked: (result: DshRunResult, remainingMs: number) => Promise<TFinal>;
  readonly finalize: (result: DshRunResult, remainingMs: number) => Promise<TFinal>;
  readonly onTurn?: (turn: number, maxTurns: number) => void | Promise<void>;
  readonly onValidationRetry?: (
    turn: number,
    error: ValidationFailureError,
  ) => void | Promise<void>;
  readonly onState?: (agent: DshRunResult, stats: AgentLoopStats) => void | Promise<void>;
  readonly onEngineFailure?: (
    failure: DshFailureTelemetry,
    stats: AgentLoopStats,
  ) => void | Promise<void>;
  readonly onCleanupError?: (
    component: "tool-provider" | "engine" | "runtime",
    error: unknown,
  ) => void | Promise<void>;
  readonly redact?: (value: string) => string;
}

export interface AgentLoopDependencies {
  readonly now?: () => number;
  readonly createRuntime?: () => Promise<DshRuntime>;
  readonly disposeRuntime?: (runtime: DshRuntime) => Promise<void>;
  readonly createEngine?: (
    runtime: DshRuntime,
  ) => AgentEngine<DshOutput, DshTurnMetadata> | Promise<AgentEngine<DshOutput, DshTurnMetadata>>;
  readonly workspaceFingerprint?: (root: string) => Promise<string>;
}

function bounded(value: string, maximumBytes = 12 * 1024): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maximumBytes) return value;
  const marker = Buffer.from("\n[truncated by dsh-action]", "utf8");
  let prefix = buffer.subarray(0, maximumBytes - marker.byteLength).toString("utf8");
  while (
    prefix.endsWith("\uFFFD") ||
    Buffer.byteLength(prefix, "utf8") + marker.byteLength > maximumBytes
  ) {
    prefix = prefix.slice(0, -1);
  }
  return prefix + marker.toString("utf8");
}

function boundedHeadTail(value: string, maximumBytes = 6 * 1024): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maximumBytes) return value;
  const marker = Buffer.from("\n[...truncated by dsh-action...]\n", "utf8");
  const available = maximumBytes - marker.byteLength;
  const headBytes = Math.floor(available / 3);
  const tailBytes = available - headBytes;
  let head = buffer.subarray(0, headBytes).toString("utf8");
  let tail = buffer.subarray(buffer.byteLength - tailBytes).toString("utf8");
  while (head.endsWith("\uFFFD")) head = head.slice(0, -1);
  while (tail.startsWith("\uFFFD")) tail = tail.slice(1);
  let result = head + marker.toString("utf8") + tail;
  while (Buffer.byteLength(result, "utf8") > maximumBytes && tail.length > 0) {
    tail = tail.slice(1);
    result = head + marker.toString("utf8") + tail;
  }
  return result;
}

function boundedFeedbackData(value: unknown): unknown {
  let candidate = value;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const output = record.output;
    if (typeof output === "object" && output !== null) {
      const processOutput = output as Record<string, unknown>;
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

function validationFeedback(
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

function feedbackFingerprint(value: unknown): string {
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
        Object.entries(candidate as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}

interface TaskContextAnchor {
  readonly sha256: string;
  readonly byteLength: number;
  readonly jsonPrefix: string;
}

async function createRuntimeWithinDeadline(
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

async function runLifecycleHookWithinDeadline(
  label: "turn progress" | "validation retry progress",
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

function turnContext(
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

/**
 * Controller-owned outer loop. DSH receives only the resolved native runtime
 * tools; controller command tools and mandatory validation remain trusted callbacks.
 */
export async function runAgentLoop<TFinal>(
  task: AgentTask,
  inputs: ActionInputs,
  hooks: AgentLoopHooks<TFinal>,
  dependencies: AgentLoopDependencies = {},
): Promise<AgentLoopResult<TFinal>> {
  const now = dependencies.now ?? Date.now;
  const createRuntime = dependencies.createRuntime ?? (() => createDshRuntime());
  const disposeRuntime = dependencies.disposeRuntime ?? disposeDshRuntime;
  const workspaceFingerprint = dependencies.workspaceFingerprint ?? fingerprintWorkspace;
  const redact = hooks.redact ?? ((value: string) => value);
  const runtime = await createRuntimeWithinDeadline(createRuntime, disposeRuntime, hooks, now);
  let engine: AgentEngine<DshOutput, DshTurnMetadata> | undefined;
  const feedback: LoopFeedback[] = [];
  const toolReceipts: AgentToolReceipt[] = [];
  const taskScopeFingerprint = feedbackFingerprint({
    operation: task.operation,
    requestedAccess: task.requestedAccess,
    instructions: task.instructions,
    context: task.contextPacket,
    tools: task.tools.manifests.map(({ id }) => id).sort(),
  });
  const serializedTaskContext = JSON.stringify(task.contextPacket);
  const taskContextAnchor: TaskContextAnchor = {
    sha256: feedbackFingerprint(task.contextPacket),
    byteLength: Buffer.byteLength(serializedTaskContext, "utf8"),
    jsonPrefix: bounded(serializedTaskContext, 4 * 1024),
  };
  let totalDurationMs = 0;
  const dshToolReceipts: DshToolReceipt[] = [];
  let toolCalls = 0;
  let validationRetries = 0;
  let lastValidationFingerprint: string | undefined;
  let pendingValidationFailure: ValidationFailureError | undefined;
  const stats = (turns: number): AgentLoopStats => ({
    turns,
    toolCalls,
    validationRetries,
    toolReceipts: [...toolReceipts],
  });
  try {
    engine =
      (await dependencies.createEngine?.(runtime)) ??
      new DshAgentEngine(inputs, task.policy, runtime, task.tools.extensions);
    for (let turn = 1; turn <= inputs.maxTurns; turn += 1) {
      throwIfCancelled(hooks.signal);
      if (hooks.deadlineMs - now() <= 0) throw new AgentDeadlineError();
      const onTurn = hooks.onTurn;
      if (onTurn !== undefined) {
        await runLifecycleHookWithinDeadline(
          "turn progress",
          async () => onTurn(turn, inputs.maxTurns),
          hooks,
          now,
        );
      }
      const remainingBeforeTurn = phaseTimeoutMs(hooks.deadlineMs, PHASE_TIMEOUTS.agentTurnMs, now);
      if (remainingBeforeTurn <= 0) throw new AgentDeadlineError();
      let response;
      try {
        response = await engine.runTurn({
          schemaVersion: AGENT_PROTOCOL_VERSION,
          operation: task.operation,
          requestedAccess: task.requestedAccess,
          instructions: task.instructions,
          context: turnContext(task.contextPacket, taskContextAnchor, turn, feedback),
          tools: task.tools.manifests,
          workspacePath: task.workspacePath,
          deadlineMs: hooks.deadlineMs,
          timeoutMs: remainingBeforeTurn,
          ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
        });
      } catch (error: unknown) {
        if (error instanceof DshError && error.telemetry !== undefined) {
          totalDurationMs += error.telemetry.durationMs;
          dshToolReceipts.push(...(error.telemetry.toolReceipts ?? []));
          const aggregateFailure: DshFailureTelemetry = {
            ...error.telemetry,
            durationMs: totalDurationMs,
            ...(dshToolReceipts.length === 0 ? {} : { toolReceipts: [...dshToolReceipts] }),
          };
          error.attachTelemetry(aggregateFailure);
          await hooks.onEngineFailure?.(aggregateFailure, stats(turn));
        }
        if (pendingValidationFailure !== undefined && error instanceof DshMalformedOutputError) {
          throw pendingValidationFailure;
        }
        throw error;
      }
      const validatedOutput = parseDshOutput(
        JSON.stringify(response.output),
        task.operation,
        task.operation === "task" ? inputs.taskOutputSchema : undefined,
      );
      dshToolReceipts.push(...(response.metadata.toolReceipts ?? []));
      const result: DshRunResult = {
        output: validatedOutput,
        durationMs: response.durationMs,
        isolationReport: response.metadata.isolationReport,
        ...(response.metadata.rawStdout === undefined
          ? {}
          : { rawStdout: response.metadata.rawStdout }),
        ...(response.metadata.extensionAudit === undefined
          ? {}
          : { extensionAudit: response.metadata.extensionAudit }),
        ...(dshToolReceipts.length === 0 ? {} : { toolReceipts: [...dshToolReceipts] }),
      };
      totalDurationMs += result.durationMs;
      const aggregate = { ...result, durationMs: totalDurationMs };
      await hooks.onState?.(aggregate, stats(turn));
      const request = result.output.toolRequest;
      if (request !== undefined) {
        throwIfCancelled(hooks.signal);
        if (hooks.toolProvider === undefined) {
          throw new Error(`Agent requested unavailable tool: ${request.id}`);
        }
        const remainingBeforeTool = hooks.deadlineMs - now();
        if (remainingBeforeTool <= 0) throw new AgentDeadlineError();
        const input = request.input ?? {};
        const callId = `call-${feedbackFingerprint({
          taskScopeFingerprint,
          turn,
          id: request.id,
          input,
        }).slice(0, 40)}`;
        const toolStartedAt = now();
        let toolResult: AgentToolResult;
        try {
          toolResult = await hooks.toolProvider.invoke(
            { callId, id: request.id, input },
            {
              workspacePath: task.workspacePath,
              timeoutMs: remainingBeforeTool,
              ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
            },
          );
        } catch (error: unknown) {
          toolCalls += 1;
          toolReceipts.push({
            callId,
            id: request.id,
            ok: false,
            error: true,
            durationMs: Math.max(0, now() - toolStartedAt),
          });
          await hooks.onState?.(aggregate, stats(turn));
          throw error;
        }
        toolCalls += 1;
        const toolOutput =
          typeof toolResult.output === "object" && toolResult.output !== null
            ? (toolResult.output as Record<string, unknown>)
            : undefined;
        toolReceipts.push({
          callId: toolResult.callId,
          id: toolResult.id,
          ok: toolResult.ok,
          durationMs: Math.max(0, now() - toolStartedAt),
          ...(typeof toolOutput?.timedOut === "boolean" ? { timedOut: toolOutput.timedOut } : {}),
          ...(toolOutput?.effect === "read" ||
          toolOutput?.effect === "scheduled" ||
          toolOutput?.effect === "created" ||
          toolOutput?.effect === "updated" ||
          toolOutput?.effect === "unchanged"
            ? { effect: toolOutput.effect }
            : {}),
          ...(typeof toolOutput?.target === "string" &&
          Buffer.byteLength(toolOutput.target, "utf8") <= 160
            ? { target: toolOutput.target }
            : {}),
          ...(typeof toolOutput?.attempts === "number" &&
          Number.isInteger(toolOutput.attempts) &&
          toolOutput.attempts >= 0 &&
          toolOutput.attempts <= 2
            ? { attempts: toolOutput.attempts }
            : {}),
          ...(typeof toolOutput?.reconciled === "boolean"
            ? { reconciled: toolOutput.reconciled }
            : {}),
        });
        await hooks.onState?.(aggregate, stats(turn));
        feedback.push({ kind: "tool", turn, data: boundedFeedbackData(toolResult) });
        continue;
      }

      if (result.output.state === "blocked") {
        throwIfCancelled(hooks.signal);
        if (pendingValidationFailure !== undefined) throw pendingValidationFailure;
        const remainingBeforeBlocked = hooks.deadlineMs - now();
        if (remainingBeforeBlocked <= 0) throw new AgentDeadlineError();
        const finalization = await hooks.blocked(aggregate, remainingBeforeBlocked);
        return {
          agent: aggregate,
          stats: stats(turn),
          finalization,
        };
      }

      const remainingBeforeFinalize = hooks.deadlineMs - now();
      if (remainingBeforeFinalize <= 0) throw new AgentDeadlineError();
      throwIfCancelled(hooks.signal);
      try {
        const finalization = await hooks.finalize(aggregate, remainingBeforeFinalize);
        return {
          agent: aggregate,
          stats: stats(turn),
          finalization,
        };
      } catch (error: unknown) {
        if (!(error instanceof ValidationFailureError)) throw error;
        pendingValidationFailure = error;
        validationRetries += 1;
        await hooks.onState?.(aggregate, stats(turn));
        const onValidationRetry = hooks.onValidationRetry;
        if (onValidationRetry !== undefined) {
          await runLifecycleHookWithinDeadline(
            "validation retry progress",
            async () => onValidationRetry(turn, error),
            hooks,
            now,
          );
        }
        const data = validationFeedback(error, redact);
        const fingerprint = feedbackFingerprint({
          argv: error.argv,
          exitCode: error.exitCode,
          timedOut: error.timedOut,
          workspace: await workspaceFingerprint(task.workspacePath),
        });
        if (fingerprint === lastValidationFingerprint) {
          throw new AgentNoProgressError({ cause: error });
        }
        lastValidationFingerprint = fingerprint;
        feedback.push({ kind: "validation", turn, data });
        if (turn === inputs.maxTurns) throw error;
      }
    }
    throw pendingValidationFailure ?? new AgentLoopLimitError(inputs.maxTurns);
  } finally {
    const cleanupDeadlineMs = Date.now() + PHASE_TIMEOUTS.cleanupMs;
    const cleanup = async (
      component: "tool-provider" | "engine" | "runtime",
      dispose: (() => Promise<void>) | undefined,
    ): Promise<void> => {
      if (dispose === undefined) return;
      try {
        const cleanupTimeoutMs = Math.max(0, cleanupDeadlineMs - Date.now());
        const result = await settleWithin(Promise.resolve().then(dispose), cleanupTimeoutMs);
        if (!result.settled) {
          throw new Error(`Agent ${component} cleanup exceeded its phase timeout`);
        }
      } catch (error: unknown) {
        try {
          await hooks.onCleanupError?.(component, error);
        } catch {
          // Cleanup reporting must never replace the primary loop outcome.
        }
      }
    };
    await cleanup("tool-provider", hooks.toolProvider?.dispose?.bind(hooks.toolProvider));
    await cleanup("engine", engine?.dispose?.bind(engine));
    await cleanup("runtime", () => disposeRuntime(runtime));
  }
}
