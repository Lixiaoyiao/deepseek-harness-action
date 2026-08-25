import * as core from "@actions/core";

import { AgentDeadlineError, runAgentLoop } from "../agent/loop.js";
import { finishDiagnosis } from "../commands/diagnose.js";
import { finishReview } from "../commands/review.js";
import { publishTaskAnswer } from "../commands/task.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import { buildDshToolPolicyAudit } from "../permissions/profile.js";
import { DshAgentEngine } from "../review/run.js";
import type { RunOutcome } from "../result.js";
import { PolicyDeniedError } from "../errors.js";
import { revalidatePullRequestHead } from "../write/pr.js";
import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
  ValidationIntegrityError,
} from "../write/validation-integrity.js";
import {
  remainingValidationMs as remainingSharedValidationMs,
  withinValidationDeadline as withinSharedValidationDeadline,
  type ValidationDeadline,
} from "../write/validation-deadline.js";
import { inspectWorkspaceChanges } from "../write/workspace.js";
import type { PreparedExecution } from "./execution.js";
import { outcomeContext, successfulValidation, type RunState } from "./lifecycle.js";
import type { AuthorizedRun } from "./prepare.js";
import { executeWrite, type WriteOutcome } from "./write.js";
import type { PreparedWorkspace } from "./workspace.js";

type FinalizedOperation =
  | { readonly kind: "review"; readonly publication: Awaited<ReturnType<typeof finishReview>> }
  | { readonly kind: "diagnose" }
  | {
      readonly kind: "answer";
      readonly noChanges?: boolean;
      readonly commentId?: number;
    }
  | { readonly kind: "blocked" }
  | { readonly kind: "write"; readonly write: WriteOutcome };

/** Run the isolated Agent, execute Controller validation, and finalize the public result. */
export async function runAgentPhase(options: {
  readonly state: RunState;
  readonly startedAt: number;
  readonly authorized: AuthorizedRun;
  readonly workspace: PreparedWorkspace;
  readonly execution: PreparedExecution;
  readonly inputs: ActionInputs;
  readonly signal: AbortSignal;
  readonly deadlineMs: number;
}): Promise<RunOutcome> {
  const { state, startedAt, authorized, workspace, execution, inputs, signal, deadlineMs } =
    options;
  const {
    context,
    client,
    command,
    currentRunUrl,
    snapshot,
    policy,
    issueNumber,
    deferWriteProgress,
  } = authorized;
  const { agentWorkspace, snapshot: workspaceCopy, boundWriteSha } = workspace;
  const {
    contextPacket,
    tools,
    toolProvider,
    extensions,
    operationIdentity,
    githubAuthority,
    githubValidation,
    hasGitHubMutationTools,
    selectedComposition,
    redact,
  } = execution;

  state.phase = "agent";
  const loop = await runAgentLoop(
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
        state.agent = {
          durationMs: agentResult.durationMs,
          isolation: agentResult.isolationReport,
          turns: stats.turns,
          toolCalls: stats.toolCalls,
          validationRetries: stats.validationRetries,
          toolReceipts: stats.toolReceipts,
          ...(agentResult.toolReceipts === undefined
            ? {}
            : { dshToolReceipts: agentResult.toolReceipts }),
          ...(agentResult.extensionAudit === undefined
            ? {}
            : { extensionAudit: agentResult.extensionAudit }),
        };
      },
      onEngineFailure: (failure, stats) => {
        if (failure.observedTools !== undefined) {
          state.toolPolicy = buildDshToolPolicyAudit(failure.observedTools);
        }
        state.agent = {
          durationMs: failure.durationMs,
          isolation: failure.isolationReport,
          turns: stats.turns,
          toolCalls: stats.toolCalls,
          validationRetries: stats.validationRetries,
          toolReceipts: stats.toolReceipts,
          ...(failure.toolReceipts === undefined ? {} : { dshToolReceipts: failure.toolReceipts }),
          ...(failure.extensionAudit === undefined
            ? selectedComposition.actionManagedExtensionProfile ||
              extensions.audit.entries.length > 0
              ? { extensionAudit: extensions.audit }
              : {}
            : { extensionAudit: failure.extensionAudit }),
        };
      },
      onCleanupError: (component, error) => {
        const message = error instanceof Error ? error.message : String(error);
        core.warning(`Agent ${component} cleanup failed: ${redact(message)}`);
      },
      blocked: async (agentResult): Promise<FinalizedOperation> => {
        state.phase = "publication";
        if (
          command.operation === "task" &&
          issueNumber !== undefined &&
          state.progress === undefined &&
          !deferWriteProgress
        ) {
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
      finalize: async (agentResult, remainingMs): Promise<FinalizedOperation> => {
        let validationBudget: ValidationDeadline | undefined;
        const remainingControllerMs = (): number => {
          throwIfCancelled(signal);
          const remaining = Math.min(remainingMs, deadlineMs - Date.now());
          if (remaining <= 0) throw new AgentDeadlineError();
          return remaining;
        };
        const controllerValidationBudget = (): ValidationDeadline => {
          throwIfCancelled(signal);
          if (validationBudget === undefined) {
            const phaseMs = Math.min(
              remainingControllerMs(),
              phaseTimeoutMs(deadlineMs, PHASE_TIMEOUTS.validationMs, Date.now),
            );
            validationBudget = { deadlineMs: Date.now() + phaseMs, signal };
          }
          return validationBudget;
        };
        const remainingValidationMs = (): number => {
          remainingControllerMs();
          return remainingSharedValidationMs(controllerValidationBudget());
        };
        const withinValidationDeadline = async <T>(start: () => Promise<T>): Promise<T> => {
          remainingControllerMs();
          return await withinSharedValidationDeadline(start, controllerValidationBudget());
        };

        if (command.operation === "review" && snapshot?.kind === "pull_request") {
          state.phase = "publication";
          await state.progress?.update(
            "finalizing",
            "Structured output passed validation. Mapping findings to the current diff and publishing.",
          );
          await revalidatePullRequestHead(
            client,
            context.repository.owner,
            context.repository.repo,
            snapshot.number,
            snapshot.headSha,
          );
          const publication = await finishReview(
            client,
            {
              owner: context.repository.owner,
              repo: context.repository.repo,
              pullNumber: snapshot.number,
              expectedAuthorId: inputs.botUserId,
              runUrl: currentRunUrl,
            },
            snapshot,
            agentResult,
            inputs.maxFindings,
          );
          return { kind: "review", publication };
        }
        if (command.operation === "diagnose") {
          state.phase = "publication";
          await state.progress?.update(
            "finalizing",
            "Structured output passed validation. Publishing the bounded CI diagnosis.",
          );
          if (issueNumber !== undefined) {
            await finishDiagnosis(
              client,
              { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
              inputs.botUserId,
              agentResult,
              currentRunUrl,
            );
          }
          return { kind: "diagnose" };
        }

        const changes =
          workspaceCopy === undefined ? undefined : await inspectWorkspaceChanges(workspaceCopy);
        if (
          changes !== undefined &&
          workspaceCopy !== undefined &&
          command.requestedAccess === "write"
        ) {
          state.phase = "validation";
          remainingControllerMs();
          const validationWorkspace = workspaceCopy;
          const integrity = await withinValidationDeadline(async () =>
            inspectValidationIntegrity({
              snapshot: validationWorkspace,
              changes,
              commands: inputs.testCommands,
              mode: inputs.validationIntegrity,
            }),
          );
          state.validationIntegrity = integrity;
          if (integrity.status === "warned") {
            const warningKey = JSON.stringify(
              integrity.changes.map(({ path, risk }) => [path, risk]),
            );
            if (state.validationIntegrityWarning !== warningKey) {
              state.validationIntegrityWarning = warningKey;
              core.warning(
                `Validation definitions changed in ${String(integrity.changeCount)} path(s); validation-integrity=warn records the changes without blocking them.`,
              );
            }
          }
        }

        if (command.operation === "task") {
          if ((changes?.all.length ?? 0) === 0) {
            remainingControllerMs();
            await githubAuthority?.flush(remainingControllerMs());
            state.phase = "publication";
            const commentId =
              issueNumber === undefined
                ? undefined
                : await publishTaskAnswer(
                    client,
                    { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
                    inputs.botUserId,
                    agentResult,
                    currentRunUrl,
                  );
            return {
              kind: "answer",
              ...(command.requestedAccess === "write" ? { noChanges: true } : {}),
              ...(commentId === undefined ? {} : { commentId }),
            };
          }
          if (!policy.capabilities.modifyWorkspace) {
            throw new PolicyDeniedError(
              "A read-only task produced workspace changes; refusing publication",
            );
          }
        }

        if (workspaceCopy === undefined || boundWriteSha === undefined) {
          throw new Error("Write operation requires a trusted checked-out workspace");
        }
        state.phase = "validation";
        await state.progress?.update(
          "finalizing",
          "The structured change is ready. Running configured validation before any GitHub write.",
        );
        if (state.validationIntegrity !== undefined) {
          const integrityAudit = state.validationIntegrity;
          const validationWorkspace = workspaceCopy;
          try {
            state.validationIntegrity = await withinValidationDeadline(async () =>
              enforceValidationIntegrity({
                snapshot: validationWorkspace,
                commands: inputs.testCommands,
                audit: integrityAudit,
                baselineReplay: {
                  containerImage: inputs.containerImage,
                  timeoutMs: remainingValidationMs(),
                  signal,
                },
              }),
            );
          } catch (error: unknown) {
            if (error instanceof ValidationIntegrityError) state.validationIntegrity = error.audit;
            throw error;
          }
        }
        const write = await executeWrite(
          client,
          context,
          command,
          inputs,
          policy,
          snapshot,
          workspaceCopy,
          boundWriteSha,
          agentResult,
          controllerValidationBudget().deadlineMs,
          operationIdentity,
          (phase) => {
            state.phase = phase;
          },
          signal,
        );
        state.partialWrite = { ...write, writeStatus: "partial-success" };
        if (
          snapshot?.kind === "pull_request" &&
          write.commitSha !== undefined &&
          githubAuthority !== undefined
        ) {
          githubAuthority.advanceValidatedPullHead(write.commitSha, snapshot.headRef);
        }
        await githubValidation?.acceptValidatedWorkspaceRevision();
        await githubAuthority?.flush(remainingControllerMs());
        delete state.partialWrite;
        return { kind: "write", write };
      },
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
  state.agent = {
    durationMs: agentResult.durationMs,
    isolation: agentResult.isolationReport,
    turns: loop.stats.turns,
    toolCalls: loop.stats.toolCalls,
    validationRetries: loop.stats.validationRetries,
    toolReceipts:
      githubAuthority?.reconcileAgentReceipts(loop.stats.toolReceipts) ?? loop.stats.toolReceipts,
    ...(agentResult.toolReceipts === undefined
      ? {}
      : { dshToolReceipts: agentResult.toolReceipts }),
    ...(agentResult.extensionAudit === undefined
      ? {}
      : { extensionAudit: agentResult.extensionAudit }),
  };
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
