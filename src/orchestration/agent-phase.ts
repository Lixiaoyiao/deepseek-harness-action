import * as core from "@actions/core";
import { runAgentLoop, type AgentLoopStats } from "../agent/loop.js";
import type { DshFailureTelemetry } from "../dsh/errors.js";
import { publishTaskAnswer } from "../commands/task.js";
import type { ActionInputs } from "../inputs.js";
import { buildDshToolPolicyAudit } from "../permissions/profile.js";
import { DshAgentEngine } from "../review/run.js";
import type { RunOutcome, AgentRunSummary } from "../result.js";
import type { PreparedExecution } from "./execution.js";
import { outcomeContext, successfulValidation, type RunState } from "./lifecycle.js";
import type { AuthorizedRun } from "./prepare.js";
import type { PreparedWorkspace } from "./workspace.js";
import { prepareControllerSession } from "../session/controller.js";
import { finalizeAgentOperation, type FinalizedOperation } from "./operation-finalizer.js";

export interface AgentPhaseOptions {
  readonly state: RunState;
  readonly startedAt: number;
  readonly authorized: AuthorizedRun;
  readonly workspace: PreparedWorkspace;
  readonly execution: PreparedExecution;
  readonly inputs: ActionInputs;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}

/** Project Controller and DSH evidence without mixing their receipt planes. */
function agentSummary(evidence: DshFailureTelemetry, stats: AgentLoopStats): AgentRunSummary {
  return {
    durationMs: evidence.durationMs,
    isolation: evidence.isolationReport,
    turns: stats.turns,
    toolCalls: stats.toolCalls,
    validationRetries: stats.validationRetries,
    toolReceipts: stats.toolReceipts,
    ...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
    ...(evidence.toolReceipts === undefined ? {} : { dshToolReceipts: evidence.toolReceipts }),
    ...(evidence.extensionAudit === undefined ? {} : { extensionAudit: evidence.extensionAudit }),
  };
}

export async function runAgentPhase(options: AgentPhaseOptions): Promise<RunOutcome> {
  const { state, startedAt, authorized, workspace, execution, inputs, signal, deadlineMs } =
    options;
  const { context, client, command, currentRunUrl, policy, issueNumber, deferWriteProgress } =
    authorized;
  const { agentWorkspace } = workspace;
  const {
    contextPacket,
    tools,
    toolProvider,
    extensions,
    githubAuthority,
    hasGitHubMutationTools,
    selectedComposition,
    redact,
  } = execution;

  const session = await prepareControllerSession({
    inputs,
    authorized,
    state,
    composition: selectedComposition,
    extensions,
    deadlineMs,
    signal,
  });
  state.phase = "agent";
  const loop = await runAgentLoop<FinalizedOperation>(
    {
      operation: command.operation,
      requestedAccess: command.requestedAccess,
      policy,
      contextPacket,
      instructions: command.instructions,
      workspacePath: agentWorkspace,
      tools,
    },
    inputs,
    {
      deadlineMs,
      signal,
      ...(toolProvider === undefined ? {} : { toolProvider }),
      redact,
      ...(session === undefined
        ? {}
        : {
            onRuntimeReady: (runtime) => session.restore(runtime),
            onRuntimeCompleted: async (runtime, completed) => {
              // Preserve already confirmed effects if checkpoint publication fails.
              const finalized = completed.finalization;
              if (finalized.kind === "write")
                state.partialWrite = { ...finalized.write, writeStatus: "partial-success" };
              if (finalized.kind === "review") state.partialPublication = finalized.publication;
              if (finalized.kind === "answer" && finalized.commentId !== undefined)
                state.finalizedCommentId = finalized.commentId;
              if (state.agent !== undefined)
                state.agent = {
                  ...state.agent,
                  toolReceipts:
                    githubAuthority?.reconcileAgentReceipts(completed.stats.toolReceipts) ??
                    completed.stats.toolReceipts,
                };
              state.phase = "publication";
              await session.save(runtime);
            },
          }),
      onTurn: async (turn, maxTurns) => {
        state.phase = "agent";
        await state.progress?.update(
          "agent",
          `The isolated worker is running turn ${String(turn)} of ${String(maxTurns)}. Repository, event, and tool output remain untrusted data.`,
        );
      },
      onValidationRetry: async (turn) => {
        await state.progress?.update(
          "agent",
          `Configured validation failed after turn ${String(turn)}. The bounded error output is being returned to a fresh DSH turn for repair.`,
        );
      },
      onState: (agentResult, stats) => {
        if (agentResult.observedTools !== undefined) {
          state.toolPolicy = buildDshToolPolicyAudit(agentResult.observedTools);
        }
        state.agent = agentSummary(agentResult, stats);
      },
      onEngineFailure: (failure, stats) => {
        if (state.session !== undefined) state.session = { ...state.session, status: "failed" };
        if (failure.observedTools !== undefined) {
          state.toolPolicy = buildDshToolPolicyAudit(failure.observedTools);
        }
        state.agent = agentSummary(
          failure.extensionAudit === undefined &&
            (selectedComposition.actionManagedExtensionProfile ||
              extensions.audit.entries.length > 0)
            ? { ...failure, extensionAudit: extensions.audit }
            : failure,
          stats,
        );
      },
      onCleanupError: (component, error) => {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Agent ${component} cleanup failed: ${redact(message)}`);
      },
      blocked: async (agentResult): Promise<FinalizedOperation> => {
        if (state.session !== undefined) state.session = { ...state.session, status: "not_saved" };
        state.phase = "publication";
        if (
          command.operation === "task" &&
          issueNumber !== undefined &&
          state.progress === undefined &&
          !deferWriteProgress
        ) {
          await authorized.revalidateAuthority();
          await publishTaskAnswer(
            client,
            { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
            inputs.botUserId,
            agentResult,
            currentRunUrl,
          );
        }
        return { kind: "blocked" };
      },
      finalize: (agentResult, remainingMs) =>
        finalizeAgentOperation(options, agentResult, remainingMs),
    },
    {
      createEngine: (runtime) =>
        new DshAgentEngine(inputs, policy, runtime, extensions, selectedComposition),
    },
  );

  const agentResult = loop.agent;
  const taskOutput =
    command.operation === "task" && agentResult.output.taskOutput !== undefined
      ? { taskOutput: agentResult.output.taskOutput }
      : {};
  state.agent = agentSummary(agentResult, {
    ...loop.stats,
    toolReceipts:
      githubAuthority?.reconcileAgentReceipts(loop.stats.toolReceipts) ?? loop.stats.toolReceipts,
  });
  const finalized = loop.finalization;
  if (finalized.kind === "blocked") {
    await state.progress?.blocked(agentResult.output.summary);
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "neutral",
      operation: command.operation,
      summary: agentResult.output.summary,
      findingsCount: agentResult.output.findings.length,
      validation: { status: "not-applicable", commandCount: 0 },
      ...taskOutput,
    };
  }
  if (finalized.kind === "review") {
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "success",
      operation: command.operation,
      summary: agentResult.output.summary,
      findingsCount: finalized.publication.selected,
      publication: finalized.publication,
      validation: { status: "not-applicable", commandCount: 0 },
      ...taskOutput,
    };
  }
  if (finalized.kind === "diagnose" || finalized.kind === "answer") {
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "success",
      operation: command.operation,
      summary: agentResult.output.summary,
      findingsCount: agentResult.output.findings.length,
      validation:
        finalized.kind === "answer" && hasGitHubMutationTools
          ? successfulValidation(inputs, state.validationIntegrity)
          : {
              status: "not-applicable",
              commandCount: 0,
              ...(state.validationIntegrity === undefined
                ? {}
                : { integrity: state.validationIntegrity }),
            },
      ...(finalized.kind !== "answer" || !finalized.noChanges
        ? {}
        : { writeStatus: "no-changes" as const, changedPaths: [] }),
      ...(finalized.kind !== "answer" || finalized.commentId === undefined
        ? {}
        : { commentId: finalized.commentId }),
      ...taskOutput,
    };
  }

  const write = finalized.write;
  if (command.operation === "implement" || write.pullRequestUrl !== undefined) {
    await authorized
      .initializeProgress()
      ?.complete(`Task completed and pull request ${write.pullRequestUrl ?? "was created"}.`);
  } else if (write.writeStatus === "partial-success") {
    await state.progress?.complete(
      `Commit \`${write.commitSha ?? "unknown"}\` was pushed, but the detailed final status publication reported a partial success.`,
    );
  }
  return {
    ...outcomeContext(state, startedAt),
    conclusion: "success",
    operation: command.operation,
    summary: agentResult.output.summary,
    findingsCount: agentResult.output.findings.length,
    validation: successfulValidation(inputs, state.validationIntegrity),
    ...taskOutput,
    ...write,
  };
}
