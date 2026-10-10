import * as core from "@actions/core";
import { AgentDeadlineError } from "../agent/loop-errors.js";
import { finishDiagnosis } from "../commands/diagnose.js";
import { finishReview } from "../commands/review.js";
import { publishTaskAnswer } from "../commands/task.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs } from "../lifecycle/deadline.js";
import { ReviewPublicationQuotaError } from "../review/publisher.js";
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
import { executeWrite, type WriteOutcome } from "./write.js";
import type { DshRunResult } from "../dsh/runner.js";
import type { AgentPhaseOptions } from "./agent-phase.js";

export type FinalizedOperation =
  | { readonly kind: "review"; readonly publication: Awaited<ReturnType<typeof finishReview>> }
  | { readonly kind: "diagnose" }
  | {
      readonly kind: "answer";
      readonly noChanges?: boolean;
      readonly commentId?: number;
    }
  | { readonly kind: "blocked" }
  | { readonly kind: "write"; readonly write: WriteOutcome };

/** Controller validation and operation-specific publication at the persistent-effect seam. */
export async function finalizeAgentOperation(
  options: AgentPhaseOptions,
  agentResult: DshRunResult,
  remainingMs: number,
): Promise<FinalizedOperation> {
  const { state, authorized, workspace, execution, inputs, signal, deadlineMs } = options;
  const { context, client, command, currentRunUrl, snapshot, policy, issueNumber } = authorized;
  const { snapshot: workspaceCopy, boundWriteSha } = workspace;
  const { operationIdentity, githubAuthority, githubValidation } = execution;

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
    await authorized.revalidateAuthority();
    let publication: Awaited<ReturnType<typeof finishReview>>;
    try {
      publication = await finishReview(
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
    } catch (error) {
      if (error instanceof ReviewPublicationQuotaError) {
        state.partialPublication = error.publication;
      }
      throw error;
    }
    return { kind: "review", publication };
  }
  if (command.operation === "diagnose") {
    state.phase = "publication";
    await state.progress?.update(
      "finalizing",
      "Structured output passed validation. Publishing the bounded CI diagnosis.",
    );
    if (issueNumber !== undefined) {
      await authorized.revalidateAuthority();
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
  if (changes !== undefined && workspaceCopy !== undefined && command.requestedAccess === "write") {
    state.phase = "validation";
    state.validationPassed = false;
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
      const warningKey = JSON.stringify(integrity.changes.map(({ path, risk }) => [path, risk]));
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
      await authorized.revalidateAuthority();
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
  const write = await executeWrite({
    authorized,
    inputs,
    workspaceCopy,
    boundWriteSha,
    agentResult,
    validationDeadlineMs: controllerValidationBudget().deadlineMs,
    taskIdentity: operationIdentity,
    onPhase: (phase) => {
      state.phase = phase;
    },
    onValidationPassed: () => {
      state.validationPassed = true;
    },
    signal,
  });
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
  return { kind: "write", write };
}
