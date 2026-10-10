import { LoopTelemetry } from "./loop-telemetry.js";
import { invokeControllerTool } from "./tool-invocation.js";
import { AGENT_PROTOCOL_VERSION, type AgentEngine } from "./contracts.js";
import { createDshRuntime, disposeDshRuntime, type DshRunResult } from "../dsh/runner.js";
import { DshError, DshMalformedOutputError } from "../dsh/errors.js";
import { parseDshOutput, type DshOutput } from "../dsh/schema.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import { DshAgentEngine, type AgentTask, type DshTurnMetadata } from "../review/run.js";
import { ValidationFailureError } from "../write/validate.js";
import { fingerprintWorkspace } from "../write/workspace.js";
import { AgentDeadlineError, AgentLoopLimitError, AgentNoProgressError } from "./loop-errors.js";
import type { AgentLoopDependencies, AgentLoopHooks, AgentLoopResult } from "./loop-contracts.js";
import {
  bounded,
  boundedFeedbackData,
  feedbackFingerprint,
  validationFeedback,
  turnContext,
  type LoopFeedback,
  type TaskContextAnchor,
} from "./feedback.js";
import {
  createRuntimeWithinDeadline,
  runLifecycleHookWithinDeadline,
  runEngineTurnWithinDeadline,
  disposeAgentLoop,
} from "./loop-lifecycle.js";
export { AgentDeadlineError, AgentLoopLimitError, AgentNoProgressError } from "./loop-errors.js";
export type {
  AgentLoopDependencies,
  AgentLoopHooks,
  AgentLoopResult,
  AgentLoopStats,
  AgentToolReceipt,
} from "./loop-contracts.js";

/**
 * Controller-owned outer loop. Controlled DSH receives the resolved runtime
 * allowlist; native DSH owns its internal graph. Controller command tools and
 * mandatory validation remain trusted callbacks in both modes.
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
  const telemetry = new LoopTelemetry();
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
  let lastValidationFingerprint: string | undefined;
  let pendingValidationFailure: ValidationFailureError | undefined;
  const stats = (turns: number) => telemetry.stats(turns);
  try {
    const restore = hooks.onRuntimeReady;
    if (restore !== undefined)
      await runLifecycleHookWithinDeadline(
        "Session restoration",
        () => restore(runtime),
        hooks,
        now,
      );
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
        response = await runEngineTurnWithinDeadline(
          engine,
          {
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
          },
          now,
        );
      } catch (error: unknown) {
        if (error instanceof DshError && error.telemetry !== undefined) {
          const aggregateFailure = telemetry.observe(error.telemetry);
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
      const result: DshRunResult = {
        output: validatedOutput,
        durationMs: response.durationMs,
        isolationReport: response.metadata.isolationReport,
        ...(response.metadata.usage === undefined ? {} : { usage: response.metadata.usage }),
        ...(response.metadata.rawStdout === undefined
          ? {}
          : { rawStdout: response.metadata.rawStdout }),
        ...(response.metadata.extensionAudit === undefined
          ? {}
          : { extensionAudit: response.metadata.extensionAudit }),
        ...(response.metadata.toolReceipts === undefined
          ? {}
          : { toolReceipts: response.metadata.toolReceipts }),
        ...(response.metadata.observedTools === undefined
          ? {}
          : { observedTools: response.metadata.observedTools }),
      };
      const aggregate = telemetry.observe(result);
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
        let toolResult;
        try {
          toolResult = await invokeControllerTool(
            hooks.toolProvider,
            { callId, id: request.id, input },
            {
              workspacePath: task.workspacePath,
              timeoutMs: remainingBeforeTool,
              ...(hooks.signal === undefined ? {} : { signal: hooks.signal }),
            },
            (receipt) => telemetry.recordTool(receipt),
            now,
          );
        } catch (error: unknown) {
          await hooks.onState?.(aggregate, stats(turn));
          throw error;
        }
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
        const completed = {
          agent: aggregate,
          stats: stats(turn),
          finalization,
        };
        await hooks.onRuntimeCompleted?.(runtime, completed);
        return completed;
      } catch (error: unknown) {
        if (!(error instanceof ValidationFailureError)) throw error;
        pendingValidationFailure = error;
        telemetry.recordValidationRetry();
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
    await disposeAgentLoop(
      [
        {
          component: "tool-provider",
          dispose: hooks.toolProvider?.dispose?.bind(hooks.toolProvider),
        },
        { component: "engine", dispose: engine?.dispose?.bind(engine) },
        { component: "runtime", dispose: () => disposeRuntime(runtime) },
      ],
      hooks.onCleanupError,
    );
  }
}
