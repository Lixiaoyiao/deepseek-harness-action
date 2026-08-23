/*
 * Lifecycle adapted from anthropics/claude-code-action/src/entrypoints/run.ts.
 * Copyright (c) 2025 Anthropic, PBC. MIT licensed; see THIRD_PARTY_NOTICES.md.
 */
import * as core from "@actions/core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { finalizeWorkflowRunRoute, routeCommand, type RoutedCommand } from "./commands/router.js";
import { finishDiagnosis } from "./commands/diagnose.js";
import { finishReview } from "./commands/review.js";
import { publishTaskAnswer } from "./commands/task.js";
import { AgentDeadlineError, runAgentLoop, type AgentToolReceipt } from "./agent/loop.js";
import { DshAbortedError } from "./dsh/errors.js";
import { PolicyDeniedError } from "./errors.js";
import { createGitHubClient } from "./github/client.js";
import { fetchEntitySnapshot, type EntitySnapshot } from "./github/fetch.js";
import { parseGitHubContext } from "./github/context.js";
import { isFailedWorkflowRun, readEventPayload } from "./github/payload.js";
import { checkActorPermissions } from "./github/permissions.js";
import { StickyProgressReporter } from "./github/progress.js";
import { revalidatePullRequestHead } from "./write/pr.js";
import { materializeRepositoryAtSha } from "./github/repository.js";
import {
  createWorkspaceSnapshot,
  fingerprintWorkspace,
  type WorkspaceSnapshot,
} from "./write/workspace.js";
import { inspectWorkspaceChanges } from "./write/workspace.js";
import { evaluatePolicy, type SecurityPolicy } from "./security/policy.js";
import { redactKnownSecrets } from "./security/env.js";
import { configuredExtensionSecrets, resolveExtensionPlan } from "./extensions/plan.js";
import { buildPermissionAudit, type PermissionAudit } from "./permissions/profile.js";
import { CommandToolProvider, resolveEffectiveTools } from "./tools/registry.js";
import {
  GitHubToolFlushError,
  GitHubToolProvider,
  type GitHubToolBinding,
  type GitHubToolFlushReceipt,
} from "./tools/github.js";
import { ToolRouter } from "./tools/router.js";
import { loadInputs, type ActionInputs } from "./inputs.js";
import { throwIfCancelled } from "./lifecycle/cancellation.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs, settleWithin } from "./lifecycle/deadline.js";
import {
  describeActionFailure,
  type ActionFailure,
  type ActionPhase,
  type AgentRunSummary,
  type RunOutcome,
  type ValidationSummary,
} from "./result.js";
import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
  ValidationIntegrityError,
  type ValidationIntegritySummary,
} from "./write/validation-integrity.js";
import {
  remainingValidationMs as remainingSharedValidationMs,
  withinValidationDeadline as withinSharedValidationDeadline,
  type ValidationDeadline,
} from "./write/validation-deadline.js";
import {
  assertOperationContext,
  buildContextPacket,
  deferProgressUntilWriteValidation,
  requireWorkspace,
  resolveBaseBranch,
  resolvePullRequest,
  runUrl,
  taskIdentity,
} from "./orchestration/context.js";
import { executeWrite, type WriteOutcome } from "./orchestration/write.js";
import {
  assertValidationSucceeded,
  assertWriteValidationConfigured,
  runValidationCommandsInDocker,
} from "./write/validate.js";

export {
  assertOperationContext,
  boundedText,
  deferProgressUntilWriteValidation,
} from "./orchestration/context.js";

interface RunState {
  phase: ActionPhase;
  operation?: RoutedCommand["operation"];
  policy?: SecurityPolicy;
  progress?: StickyProgressReporter;
  runUrl?: string;
  agent?: AgentRunSummary;
  validationCommandCount?: number;
  permission?: PermissionAudit;
  validationIntegrity?: ValidationIntegritySummary;
  validationIntegrityWarning?: string;
  validationPassed?: boolean;
  progressFailure?: ProgressFailureFinalization;
  partialWrite?: WriteOutcome;
}

interface ProgressFailureFinalization {
  readonly failure: ActionFailure;
  readonly deadlineMs: number;
  status: "pending" | "succeeded" | "failed";
  promise: Promise<void>;
}

function githubToolBinding(
  context: ReturnType<typeof parseGitHubContext>,
  snapshot: EntitySnapshot | undefined,
): GitHubToolBinding | undefined {
  const repository = {
    repositoryId: context.repository.id,
    owner: context.repository.owner,
    repo: context.repository.repo,
  } as const;
  if (context.kind === "entity" && snapshot?.kind === "issue") {
    return {
      ...repository,
      target: "issue",
      entityNumber: snapshot.number,
      state: snapshot.state,
      updatedAt: snapshot.updatedAt,
      contentFingerprint: snapshot.contentFingerprint,
    };
  }
  if (context.kind === "entity" && snapshot?.kind === "pull_request") {
    if (snapshot.headRepositoryId === null) return undefined;
    return {
      ...repository,
      target: "pull_request",
      entityNumber: snapshot.number,
      headSha: snapshot.headSha,
      headRef: snapshot.headRef,
      headRepositoryId: snapshot.headRepositoryId,
      baseSha: snapshot.baseSha,
      baseRef: snapshot.baseRef,
      baseRepositoryId: snapshot.baseRepositoryId,
    };
  }
  if (context.kind === "automation" && context.workflowRun !== undefined) {
    return { ...repository, target: "workflow_run", headSha: context.workflowRun.headSha };
  }
  return undefined;
}

function mergeGitHubFlushReceipts(
  receipts: readonly AgentToolReceipt[],
  flushes: readonly GitHubToolFlushReceipt[],
): readonly AgentToolReceipt[] {
  const byCallId = new Map(flushes.map((flush) => [flush.result.callId, flush]));
  return receipts.map((receipt) => {
    const flush = byCallId.get(receipt.callId);
    if (flush === undefined) return receipt;
    const output =
      typeof flush.result.output === "object" && flush.result.output !== null
        ? (flush.result.output as Record<string, unknown>)
        : {};
    const effect = output.effect;
    return {
      ...receipt,
      ok: flush.result.ok,
      durationMs: receipt.durationMs + flush.durationMs,
      ...(effect === "created" ||
      effect === "updated" ||
      effect === "unchanged" ||
      effect === "read" ||
      effect === "scheduled"
        ? { effect }
        : {}),
      ...(!flush.result.ok ? { error: true } : {}),
      ...(typeof output.target === "string" && Buffer.byteLength(output.target, "utf8") <= 160
        ? { target: output.target }
        : {}),
      ...(typeof output.attempts === "number" &&
      Number.isInteger(output.attempts) &&
      output.attempts >= 0 &&
      output.attempts <= 2
        ? { attempts: output.attempts }
        : {}),
      ...(typeof output.reconciled === "boolean" ? { reconciled: output.reconciled } : {}),
      ...(output.externalEffect === "possible" || output.externalEffect === "confirmed"
        ? { externalEffect: output.externalEffect }
        : {}),
    };
  });
}

function githubFlushHasExternalEffect(receipts: readonly GitHubToolFlushReceipt[]): boolean {
  return receipts.some(({ result }) => {
    if (typeof result.output !== "object" || result.output === null) return false;
    const output = result.output as Record<string, unknown>;
    return (
      output.effect === "created" ||
      output.effect === "updated" ||
      output.externalEffect === "possible" ||
      output.externalEffect === "confirmed"
    );
  });
}

function progressFailureStatus(
  attempt: ProgressFailureFinalization,
): ProgressFailureFinalization["status"] {
  // The promise callbacks mutate this field asynchronously. Reading it through
  // a function prevents control-flow narrowing from treating the earlier
  // "pending" observation as immutable across the await below.
  return attempt.status;
}

export interface RunActionOptions {
  readonly signal?: AbortSignal;
}

interface RunDeadline {
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  dispose(): void;
}

function createRunDeadline(
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

function failureFromSignal(error: unknown, signal?: AbortSignal): unknown {
  if (signal?.aborted !== true || !(signal.reason instanceof Error)) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (current === signal.reason || current.name === "AbortError") return signal.reason;
    current = current.cause;
  }
  return error;
}

function startProgressFailure(
  state: RunState,
  error: unknown,
): ProgressFailureFinalization | undefined {
  const progress = state.progress;
  if (progress === undefined) return undefined;
  const failure = describeActionFailure(error, state.phase);
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

async function finishProgressFailure(state: RunState, error: unknown): Promise<void> {
  const attempt = state.progressFailure ?? startProgressFailure(state, error);
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

function outcomeContext(state: RunState, startedAt: number) {
  return {
    schemaVersion: 1 as const,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(state.runUrl === undefined ? {} : { runUrl: state.runUrl }),
    ...(state.policy === undefined ? {} : { policy: state.policy }),
    ...(state.agent === undefined ? {} : { agent: state.agent }),
    ...(state.permission === undefined ? {} : { permission: state.permission }),
    ...(state.progress?.commentId === undefined ? {} : { commentId: state.progress.commentId }),
  };
}

function successfulValidation(
  inputs: ActionInputs,
  integrity?: ValidationIntegritySummary,
): ValidationSummary {
  return {
    status: "passed",
    commandCount: inputs.testCommands.length,
    ...(integrity === undefined ? {} : { integrity }),
  };
}

/** Claude Action-style prepare -> route -> authorize -> run -> finalize orchestration. */
async function runActionInternal(
  state: RunState,
  startedAt: number,
  inputs: ActionInputs,
  signal: AbortSignal,
  deadlineMs: number,
): Promise<RunOutcome> {
  throwIfCancelled(signal);
  state.validationCommandCount = inputs.testCommands.length;
  core.setSecret(inputs.githubToken);
  core.setSecret(inputs.deepseekApiKey);
  for (const secret of configuredExtensionSecrets(inputs.mcpConfig, inputs.pluginConfig)) {
    core.setSecret(secret);
  }

  state.phase = "routing";
  const payload = await readEventPayload(process.env.GITHUB_EVENT_PATH);
  const context = parseGitHubContext(process.env, payload);
  const baseBranch = resolveBaseBranch(context, inputs.baseBranch);
  const currentRunUrl = runUrl(context);
  state.runUrl = currentRunUrl;
  let command = routeCommand(context, inputs);
  if (command !== null) state.operation = command.operation;
  if (
    command === null ||
    (context.rawEventName === "workflow_run" &&
      command.source === "automatic-event" &&
      !isFailedWorkflowRun(payload))
  ) {
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "neutral",
      summary:
        inputs.triggerPhrase === "@dsh"
          ? "No matching @dsh command or automatic event"
          : "No matching configured command or automatic event",
      findingsCount: 0,
    };
  }
  if (
    command.source === "automatic-event" &&
    context.kind === "entity" &&
    context.pullRequest?.draft === true
  ) {
    return {
      ...outcomeContext(state, startedAt),
      conclusion: "neutral",
      operation: command.operation,
      summary: "Draft pull requests are not reviewed automatically",
      findingsCount: 0,
    };
  }

  const client = createGitHubClient(inputs.githubToken, signal);
  throwIfCancelled(signal);
  state.phase = "authorization";
  const permissions = await checkActorPermissions(client, context, inputs.allowedBots);
  throwIfCancelled(signal);
  state.phase = "context";
  const commentActorFilter = {
    include: inputs.includeCommentsByActor,
    exclude: inputs.excludeCommentsByActor,
  };
  const pullRequest = await resolvePullRequest(client, context, commentActorFilter);
  throwIfCancelled(signal);
  command = finalizeWorkflowRunRoute(context, command, pullRequest !== undefined);
  state.operation = command.operation;
  let snapshot: EntitySnapshot | undefined = pullRequest;
  if (snapshot === undefined && context.kind === "entity") {
    snapshot = await fetchEntitySnapshot(
      client,
      context,
      context.entityNumber,
      context.isPullRequest,
      commentActorFilter,
    );
    throwIfCancelled(signal);
  }
  assertOperationContext(command, context, snapshot, baseBranch);

  state.phase = "authorization";
  const policy = evaluatePolicy({
    context,
    operation: command.operation,
    allowWrite: inputs.allowWrite,
    permissions,
    requestedAccess: command.requestedAccess,
    commandSource: command.source,
    allowWorkflowRunWrite:
      context.rawEventName === "workflow_run" &&
      command.operation === "fix" &&
      pullRequest !== undefined,
    ...(pullRequest === undefined ? {} : { resolvedPullRequest: { isFork: pullRequest.isFork } }),
  });
  state.policy = policy;
  if (!policy.allowed) throw new PolicyDeniedError(policy.reason);

  const issueNumber = snapshot?.number ?? pullRequest?.number;
  const deferWriteProgress = deferProgressUntilWriteValidation(command);
  const initializeProgress = (): StickyProgressReporter | undefined => {
    if (!inputs.progressComment || issueNumber === undefined) return undefined;
    state.progress ??= new StickyProgressReporter({
      // Terminal publication deliberately receives its own short signal after
      // SIGTERM. Do not bind this dedicated Controller client to the already
      // aborted run signal; the reporter supplies a bounded signal and an
      // abort race for every non-terminal and terminal request.
      client: createGitHubClient(inputs.githubToken),
      target: { owner: context.repository.owner, repo: context.repository.repo, issueNumber },
      expectedAuthorId: inputs.botUserId,
      operation: command.operation,
      policy,
      runUrl: currentRunUrl,
      signal,
    });
    return state.progress;
  };
  if (!deferWriteProgress) {
    await initializeProgress()?.update(
      "context",
      "Permission checks passed. Preparing a bounded, immutable context snapshot.",
    );
    throwIfCancelled(signal);
  }

  state.phase = "context";
  const workspace = requireWorkspace();
  let tempRoot: string | undefined;
  let workspaceCopy: WorkspaceSnapshot | undefined;
  let boundWriteSha: string | undefined;
  try {
    let agentWorkspace = workspace;
    if (
      policy.trust === "trusted-write" ||
      (policy.trust === "trusted-read" && inputs.isolation === "docker")
    ) {
      tempRoot = await mkdtemp(join(tmpdir(), "dsh-action-workspace-"));
      const immutableSource = join(tempRoot, "source");
      const baseSha = await (async (): Promise<string> => {
        // Pull-request review/fix always stays bound to the immutable PR head.
        if (snapshot?.kind === "pull_request") return snapshot.headSha;
        if (baseBranch === undefined) {
          throw new PolicyDeniedError("Cannot bind repository content without a base branch");
        }
        return await import("./write/github.js").then(({ getBranchHead }) =>
          getBranchHead(client, context.repository.owner, context.repository.repo, baseBranch),
        );
      })();
      throwIfCancelled(signal);
      boundWriteSha = baseSha;
      await materializeRepositoryAtSha(
        client,
        context.repository.owner,
        context.repository.repo,
        baseSha,
        immutableSource,
      );
      throwIfCancelled(signal);
      agentWorkspace = join(tempRoot, "repository");
      workspaceCopy = await createWorkspaceSnapshot(
        { kind: "materialized-tree", root: immutableSource },
        agentWorkspace,
      );
      throwIfCancelled(signal);
    } else {
      tempRoot = await mkdtemp(join(tmpdir(), "dsh-action-empty-"));
      agentWorkspace = tempRoot;
    }
    const packet = await buildContextPacket(client, context, command, snapshot, inputs);
    throwIfCancelled(signal);
    const trustedGitHubBinding = githubToolBinding(context, snapshot);
    const resolvedTools = resolveEffectiveTools(inputs.allowedTools, inputs.toolConfig, policy, {
      permissionProfile: inputs.permissionProfile,
      disallowedTools: inputs.disallowedTools,
      isolation: inputs.isolation,
      ...(trustedGitHubBinding === undefined ? {} : { githubBinding: trustedGitHubBinding }),
      allowWrite: inputs.allowWrite,
    });
    const deniedTools = new Set(resolvedTools.permission.disallowedTools);
    const extensionAllowedTools = resolvedTools.permission.requestedTools.filter(
      (id) => !deniedTools.has(id),
    );
    const extensions = resolveExtensionPlan({
      allowedTools: extensionAllowedTools,
      mcp: inputs.mcpConfig,
      plugins: inputs.pluginConfig,
      allowPluginInstall: inputs.allowPluginInstall,
      policy,
    });
    const tools = {
      ...resolvedTools,
      extensions,
      manifests: [...resolvedTools.manifests, ...extensions.manifests],
    };
    if (extensions.network && tools.native.includes("native.bash")) {
      throw new PolicyDeniedError(
        "native.bash cannot share a worker with a bridge-networked extension; use mediated web-search or remove Bash",
      );
    }
    if (command.requestedAccess === "write" && !tools.workspace.includes("workspace.edit")) {
      throw new PolicyDeniedError(
        "Write tasks require effective workspace.edit permission; select standard or allow it in custom after all trust gates pass",
      );
    }
    const redact = (value: string): string =>
      redactKnownSecrets(value, [inputs.deepseekApiKey, inputs.githubToken]);
    const commandToolProvider =
      tools.commands.length === 0
        ? undefined
        : new CommandToolProvider({
            definitions: tools.commands,
            workspacePath: agentWorkspace,
            containerImage: inputs.containerImage,
            redact,
          });
    const githubToolProvider =
      tools.github.length === 0 || trustedGitHubBinding === undefined
        ? undefined
        : new GitHubToolProvider({
            ids: tools.github,
            binding: trustedGitHubBinding,
            policy,
            allowWrite: inputs.allowWrite,
            expectedAuthorId: inputs.botUserId,
            client,
          });
    const controllerProviders = [commandToolProvider, githubToolProvider].filter(
      (provider): provider is CommandToolProvider | GitHubToolProvider => provider !== undefined,
    );
    const toolProvider =
      controllerProviders.length === 0 ? undefined : new ToolRouter(controllerProviders);
    const agentTools = {
      ...tools,
      manifests: [
        ...tools.manifests.filter(
          ({ provider }) => provider !== "command" && provider !== "github",
        ),
        ...(toolProvider?.manifest() ?? []),
      ],
    };
    const permission = buildPermissionAudit({
      resolution: resolvedTools.permission,
      manifests: agentTools.manifests,
      additionalDenials: resolvedTools.permissionDenials,
      extensions: extensions.audit,
    });
    state.permission = permission;
    const operationIdentity = taskIdentity(command, inputs, extensions.digest, permission.digest);
    const githubMutationTools = tools.github.filter((id) => id !== "github.checks.read");
    let githubValidationFingerprint: string | undefined;
    let githubValidationBudget: ValidationDeadline | undefined;
    const ensureGitHubMutationValidation = async (): Promise<void> => {
      if (githubMutationTools.length === 0) return;
      if (workspaceCopy === undefined) {
        throw new PolicyDeniedError(
          "GitHub mutation tools require an immutable Controller workspace snapshot",
        );
      }
      const validationWorkspace = workspaceCopy;
      assertWriteValidationConfigured(inputs.runTests, inputs.testCommands);
      const before = await fingerprintWorkspace(validationWorkspace.workerRoot);
      if (before === githubValidationFingerprint) return;
      state.phase = "validation";
      if (githubValidationBudget === undefined) {
        const phaseMs = phaseTimeoutMs(deadlineMs, PHASE_TIMEOUTS.validationMs, Date.now);
        if (phaseMs <= 0) throw new AgentDeadlineError();
        githubValidationBudget = {
          deadlineMs: Date.now() + phaseMs,
          signal,
        };
      }
      const validationBudget = githubValidationBudget;
      const changes = await withinSharedValidationDeadline(
        async () => inspectWorkspaceChanges(validationWorkspace),
        validationBudget,
      );
      let integrity = await withinSharedValidationDeadline(
        async () =>
          inspectValidationIntegrity({
            snapshot: validationWorkspace,
            changes,
            commands: inputs.testCommands,
            mode: inputs.validationIntegrity,
          }),
        validationBudget,
      );
      integrity = await withinSharedValidationDeadline(
        async () =>
          enforceValidationIntegrity({
            snapshot: validationWorkspace,
            commands: inputs.testCommands,
            audit: integrity,
            baselineReplay: {
              containerImage: inputs.containerImage,
              timeoutMs: remainingSharedValidationMs(validationBudget),
              signal,
            },
          }),
        validationBudget,
      );
      state.validationIntegrity = integrity;
      const validationResults = await withinSharedValidationDeadline(
        async () =>
          runValidationCommandsInDocker(
            validationWorkspace.workerRoot,
            inputs.testCommands,
            inputs.containerImage,
            remainingSharedValidationMs(validationBudget),
            undefined,
            signal,
          ),
        validationBudget,
      );
      assertValidationSucceeded(validationResults);
      state.validationPassed = true;
      const after = await fingerprintWorkspace(validationWorkspace.workerRoot);
      if (after !== before) {
        throw new PolicyDeniedError(
          "Workspace changed while validating deferred GitHub mutations; refusing mutation",
        );
      }
      githubValidationFingerprint = after;
    };
    const githubFlushReceipts: GitHubToolFlushReceipt[] = [];
    const recordGitHubFlushReceipts = (receipts: readonly GitHubToolFlushReceipt[]): void => {
      githubFlushReceipts.push(...receipts);
      if (githubFlushHasExternalEffect(receipts)) {
        state.partialWrite ??= { writeStatus: "partial-success" };
      }
      if (state.agent?.toolReceipts !== undefined) {
        state.agent = {
          ...state.agent,
          toolReceipts: mergeGitHubFlushReceipts(state.agent.toolReceipts, githubFlushReceipts),
        };
      }
    };
    const flushGitHubMutations = async (remainingMs: number): Promise<void> => {
      if (githubToolProvider?.hasPendingMutations() !== true) return;
      await ensureGitHubMutationValidation();
      state.phase = "write";
      try {
        recordGitHubFlushReceipts(
          await githubToolProvider.flush({
            workspacePath: agentWorkspace,
            timeoutMs: Math.min(remainingMs, deadlineMs - Date.now()),
            signal,
          }),
        );
      } catch (error: unknown) {
        if (error instanceof GitHubToolFlushError) {
          recordGitHubFlushReceipts(error.receipts);
        }
        throw error;
      }
    };

    // Mutation requests are deferred until finalization, but validate the exact
    // immutable baseline before the first Agent turn so no model-controlled
    // path can introduce a pre-validation GitHub side effect.
    if (githubMutationTools.length > 0) await ensureGitHubMutationValidation();

    state.phase = "agent";
    const loop = await runAgentLoop(
      {
        operation: command.operation,
        requestedAccess: command.requestedAccess,
        policy,
        contextPacket: packet,
        instructions: command.instructions,
        workspacePath: agentWorkspace,
        tools: agentTools,
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
          state.agent = {
            durationMs: failure.durationMs,
            isolation: failure.isolationReport,
            turns: stats.turns,
            toolCalls: stats.toolCalls,
            validationRetries: stats.validationRetries,
            toolReceipts: stats.toolReceipts,
            ...(failure.toolReceipts === undefined
              ? {}
              : { dshToolReceipts: failure.toolReceipts }),
            ...(failure.extensionAudit === undefined
              ? { extensionAudit: extensions.audit }
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
              validationBudget = {
                deadlineMs: Date.now() + phaseMs,
                signal,
              };
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
              await flushGitHubMutations(remainingControllerMs());
              state.phase = "publication";
              const commentId =
                issueNumber === undefined
                  ? undefined
                  : await publishTaskAnswer(
                      client,
                      {
                        owner: context.repository.owner,
                        repo: context.repository.repo,
                        issueNumber,
                      },
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
              if (error instanceof ValidationIntegrityError) {
                state.validationIntegrity = error.audit;
              }
              throw error;
            }
          }
          const writeValidationDeadlineMs = controllerValidationBudget().deadlineMs;
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
            writeValidationDeadlineMs,
            operationIdentity,
            (phase) => {
              state.phase = phase;
            },
            signal,
          );
          state.partialWrite = { ...write, writeStatus: "partial-success" };
          // executeWrite has completed the existing Controller validation and
          // Validation Integrity gates for this exact workspace revision.
          if (
            snapshot?.kind === "pull_request" &&
            write.commitSha !== undefined &&
            githubToolProvider !== undefined
          ) {
            githubToolProvider.advancePullHead(write.commitSha, snapshot.headRef);
          }
          githubValidationFingerprint = await fingerprintWorkspace(agentWorkspace);
          await flushGitHubMutations(remainingControllerMs());
          delete state.partialWrite;
          return { kind: "write", write };
        },
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
      toolReceipts: mergeGitHubFlushReceipts(loop.stats.toolReceipts, githubFlushReceipts),
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
          finalized.kind === "answer" && githubMutationTools.length > 0
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
      // Write operations deliberately create no lifecycle comment before the
      // Controller validation gate. Only after the validated write returns may
      // the final result be published to its Issue or pull request.
      await initializeProgress()?.complete(
        `Task completed and pull request ${write.pullRequestUrl ?? "was created"}.`,
      );
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
  } catch (error: unknown) {
    if (error instanceof ValidationIntegrityError) state.validationIntegrity = error.audit;
    // Begin terminal publication before temporary-directory cleanup. For
    // signal-driven Agent cancellation an even earlier abort listener starts
    // the same idempotent attempt while nested runtime cleanup is still active.
    startProgressFailure(state, error);
    throw error;
  } finally {
    if (tempRoot !== undefined) {
      try {
        const cleanup = await settleWithin(
          rm(tempRoot, { recursive: true, force: true }),
          PHASE_TIMEOUTS.cleanupMs,
        );
        if (!cleanup.settled) {
          core.warning("The temporary DeepSeek Harness workspace cleanup timed out.");
        }
      } catch {
        // Cleanup is secondary. It must not turn an already-published review or
        // completed remote write into a failed run that may be retried.
        core.warning("The temporary DeepSeek Harness workspace could not be removed.");
      }
    }
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
    // A cancellation signal is routing information, not an authority to pick
    // the public failure identity. Construct the stable local error here so a
    // foreign-realm or composed AbortSignal reason cannot become an
    // ACTION_RUNTIME_FAILED provisional terminal state.
    startProgressFailure(state, new DshAbortedError());
  };
  options.signal?.addEventListener("abort", beginCancellationFinalization, { once: true });
  if (options.signal?.aborted === true) beginCancellationFinalization();
  try {
    throwIfCancelled(options.signal);
    const inputs = loadInputs();
    deadline = createRunDeadline(startedAt, inputs.timeoutMinutes, options.signal);
    return await runActionInternal(state, startedAt, inputs, deadline.signal, deadline.deadlineMs);
  } catch (error: unknown) {
    // Abort-aware boundaries throw their own DshAbortedError. Never replace an
    // independent validation/security/write failure merely because a signal
    // happened to arrive before this catch ran.
    const effectiveError = failureFromSignal(error, deadline?.signal);
    const failure = describeActionFailure(effectiveError, state.phase);
    await finishProgressFailure(state, effectiveError);
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
