import { join } from "node:path";
import * as core from "@actions/core";

import { AgentDeadlineError } from "../agent/loop-errors.js";
import type { Operation } from "../commands/parse.js";
import type { DshRuntime } from "../dsh/runtime.js";
import { isClassifiedActionError, PolicyDeniedError } from "../errors.js";
import { configuredSessionExtensionSecrets } from "../extensions/credentials.js";
import type { GitHubClient } from "../github/client.js";
import type { GitHubContext } from "../github/context.js";
import { GitHubQuotaError } from "../github/request-policy.js";
import type { ActionInputs } from "../inputs.js";
import type { SessionRunSummary } from "../result.js";
import { collectControllerSecrets } from "../security/env.js";
import type { SecurityPolicy } from "../security/policy.js";
import {
  prepareSessionArtifacts,
  saveSessionArtifact,
  type PreparedSessionArtifacts,
} from "./artifact-store.js";
import {
  exportSessionCheckpoint,
  importSessionCheckpoint,
  SESSION_CHECKPOINT_LIMITS,
} from "./checkpoint.js";
import { sessionBindingHash, sessionKeyHash } from "./contracts.js";
import { SessionCheckpointError } from "./errors.js";

export interface ControllerSession {
  /** Prepare once, retaining confirmed receipts even when preparation rejects. */
  prepare(): Promise<void>;
  restore(runtime: DshRuntime): Promise<void>;
  save(runtime: DshRuntime): Promise<void>;
  /** Finish the surrounding run without discarding a saved checkpoint. */
  finish(status: "failed" | "not_saved"): void;
  snapshot(): SessionRunSummary;
}

type SessionInputs = Pick<
  ActionInputs,
  | "sessionMode"
  | "sessionKey"
  | "sessionSourceRunId"
  | "sessionRetentionDays"
  | "deepseekApiKey"
  | "githubToken"
  | "maxTurns"
  | "isolation"
  | "dshMode"
  | "containerImage"
  | "mcpConfig"
  | "pluginConfig"
>;

type SessionContext = Pick<GitHubContext, "repository" | "runId" | "actor"> &
  (
    | { readonly kind: "entity"; readonly entityNumber: number; readonly isPullRequest: boolean }
    | { readonly kind: "automation" }
  );

export interface ControllerSessionOptions {
  readonly inputs: SessionInputs;
  readonly client: GitHubClient;
  readonly context: SessionContext;
  readonly operation: Operation;
  readonly authority: Pick<SecurityPolicy, "trust" | "allowed"> & {
    readonly revalidate: () => Promise<void>;
  };
  readonly compositionId: string;
  readonly extensionDigest: string;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
  readonly environment?: NodeJS.ProcessEnv;
}

/** Own Session evidence before transport starts; DSH owns only Session replay. */
export function createControllerSession(
  options: ControllerSessionOptions,
): ControllerSession | undefined {
  const { inputs, client, context, operation, authority, deadlineMs, signal } = options;
  if (inputs.sessionMode === "off") return undefined;
  const mode = inputs.sessionMode;
  const logicalKey = mode === "auto" ? inputs.sessionKey.toLowerCase() : inputs.sessionKey;
  const sourceRunId =
    inputs.sessionSourceRunId === "" ? undefined : Number(inputs.sessionSourceRunId);
  let summary: SessionRunSummary = {
    mode,
    status: "preparing",
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
  };
  const failed = (error: unknown): never => {
    summary = { ...summary, status: "failed" };
    if (error instanceof GitHubQuotaError || error instanceof AgentDeadlineError || signal.aborted)
      throw error;
    throw new SessionCheckpointError(
      error instanceof Error ? error.message : "Session checkpoint failed",
      isClassifiedActionError(error) ? error.category : "runtime",
      { cause: error },
    );
  };
  const environment = options.environment ?? process.env;
  const secrets = new Set([
    inputs.deepseekApiKey,
    inputs.githubToken,
    ...collectControllerSecrets(environment, 1),
    ...configuredSessionExtensionSecrets(inputs.mcpConfig, inputs.pluginConfig),
  ]);
  const prepare = async (): Promise<PreparedSessionArtifacts> => {
    try {
      if (secrets.size + inputs.maxTurns > SESSION_CHECKPOINT_LIMITS.knownSecrets) {
        throw new PolicyDeniedError(
          "Session credential inspection exceeds its bounded value budget before worker startup",
        );
      }
      if (authority.trust === "untrusted" || !authority.allowed || inputs.isolation !== "docker") {
        throw new PolicyDeniedError(
          "Session requires current trusted repository authority and Docker isolation",
        );
      }
      const prefix = `${context.repository.fullName}/`;
      const workflowRef = environment.GITHUB_WORKFLOW_REF ?? "";
      const separator = workflowRef.lastIndexOf("@");
      const workflowPath =
        workflowRef.startsWith(prefix) && separator > prefix.length
          ? workflowRef.slice(prefix.length, separator)
          : "";
      const workflowSha = environment.GITHUB_WORKFLOW_SHA ?? "";
      const jobId = environment.GITHUB_JOB ?? "";
      const runId = Number(context.runId);
      const runAttempt = Number(environment.GITHUB_RUN_ATTEMPT);
      if (
        !/^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u.test(workflowPath) ||
        !/^[a-f0-9]{40}$/u.test(workflowSha) ||
        !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/u.test(jobId) ||
        !Number.isSafeInteger(runId) ||
        runId < 1 ||
        !Number.isSafeInteger(runAttempt) ||
        runAttempt < 1 ||
        runAttempt > 1000
      ) {
        throw new PolicyDeniedError(
          "Session requires complete verified Actions workflow, job, run and attempt identity",
        );
      }
      const prepared = await prepareSessionArtifacts({
        client,
        mode,
        binding: {
          repository: {
            id: context.repository.id,
            owner: context.repository.owner,
            repo: context.repository.repo,
          },
          workflow: { path: workflowPath, jobId, jobName: jobId },
          task:
            context.kind === "entity"
              ? {
                  kind: context.isPullRequest ? "pull_request" : "issue",
                  identity: `${operation}:${String(context.entityNumber)}`,
                }
              : {
                  kind: "automation",
                  identity: `${operation}:${logicalKey}`,
                },
          runtime: {
            dshVersion: "0.2.1-rc.2",
            mode: inputs.dshMode,
            compositionId: options.compositionId,
            containerImage: inputs.containerImage,
            extensionDigest: options.extensionDigest,
          },
          keyHash: sessionKeyHash(logicalKey),
        },
        currentRun: { runId, runAttempt, workflowSha, actorLogin: context.actor },
        ...(sourceRunId === undefined ? {} : { sourceRunId }),
        retentionDays: inputs.sessionRetentionDays,
        deadlineMs,
        signal,
        onWorkflowWarning: (message) => core.warning(message),
        onUploadReceipt: (receipt) => {
          summary = {
            ...summary,
            ...(receipt.kind === "claim"
              ? { claimArtifactId: receipt.id }
              : {
                  artifactId: receipt.id,
                  artifactName: receipt.name,
                  ...(receipt.sha256 === undefined ? {} : { archiveSha256: receipt.sha256 }),
                }),
          };
        },
        authorizeCurrent: async () => {
          signal.throwIfAborted();
          await authority.revalidate();
        },
      });
      summary = {
        ...summary,
        status: "claimed",
        generation: prepared.generation,
        selection: prepared.selection,
        ...(prepared.source === undefined ? {} : { sourceRunId: prepared.source.runId }),
        claimArtifactId: prepared.claimArtifactId,
      };
      return prepared;
    } catch (error: unknown) {
      return failed(error);
    }
  };
  let preparation: Promise<PreparedSessionArtifacts> | undefined;
  const preparedArtifacts = (): Promise<PreparedSessionArtifacts> => (preparation ??= prepare());
  return {
    prepare: async () => {
      await preparedArtifacts();
    },
    snapshot: () => Object.freeze({ ...summary }),
    finish: (status) => {
      if (summary.status !== "saved" && (status === "failed" || summary.status !== "failed")) {
        summary = { ...summary, status };
      }
    },
    restore: async (runtime) => {
      try {
        const prepared = await preparedArtifacts();
        signal.throwIfAborted();
        runtime.session = {
          bindingDigest: sessionBindingHash(prepared.binding),
          knownSecrets: new Set(secrets),
        };
        if (prepared.checkpoint !== undefined) {
          if (prepared.source === undefined)
            throw new PolicyDeniedError("Session checkpoint has no verified source run");
          const inspection = await importSessionCheckpoint({
            persistenceRoot: join(runtime.dshHome, "sessions"),
            checkpoint: prepared.checkpoint,
            binding: prepared.binding,
            source: prepared.source,
            workspacePath: "/workspace",
            knownSecrets: [...secrets],
          });
          runtime.session.sessionId = inspection.sessionId;
          runtime.session.checkpointEventCount = inspection.eventCount;
          summary = {
            ...summary,
            status: "restored",
            sessionId: inspection.sessionId,
          };
        }
      } catch (error: unknown) {
        failed(error);
      }
    },
    save: async (runtime) => {
      try {
        const prepared = await preparedArtifacts();
        signal.throwIfAborted();
        const session = runtime.session;
        if (session?.sessionId === undefined)
          throw new PolicyDeniedError("Successful worker did not produce an admitted Session");
        const createdAt = new Date();
        const expiresAt = new Date(
          createdAt.getTime() + inputs.sessionRetentionDays * 24 * 60 * 60 * 1000,
        ).toISOString();
        const checkpoint = await exportSessionCheckpoint({
          persistenceRoot: join(runtime.dshHome, "sessions"),
          workspacePath: "/workspace",
          knownSecrets: [...session.knownSecrets],
          manifest: {
            schemaVersion: 1,
            repository: prepared.binding.repository,
            workflow: {
              ...prepared.binding.workflow,
              sourceSha: prepared.current.sourceSha,
              runId: prepared.current.runId,
              runAttempt: prepared.current.runAttempt,
            },
            task: prepared.binding.task,
            runtime: prepared.binding.runtime,
            issuer: {
              actorId: prepared.current.actorId,
              actorLogin: prepared.current.actorLogin,
              jobRunId: prepared.current.jobRunId,
            },
            session: {
              keyHash: prepared.binding.keyHash,
              sessionId: session.sessionId,
              generation: prepared.generation,
            },
            createdAt: createdAt.toISOString(),
            expiresAt,
          },
        });
        summary = {
          ...summary,
          sessionId: session.sessionId,
          payloadSha256: checkpoint.manifest.payload.sha256,
          expiresAt,
        };
        const receipt = await saveSessionArtifact({ prepared, checkpoint, deadlineMs, signal });
        summary = {
          ...summary,
          status: "saved",
          sessionId: session.sessionId,
          artifactId: receipt.id,
          artifactName: receipt.name,
          payloadSha256: checkpoint.manifest.payload.sha256,
          ...(receipt.sha256 === undefined ? {} : { archiveSha256: receipt.sha256 }),
          expiresAt,
        };
      } catch (error: unknown) {
        failed(error);
      }
    },
  };
}
