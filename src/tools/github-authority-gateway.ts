import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  AgentToolCall,
  AgentToolManifest,
  AgentToolResult,
  ToolInvocationContext,
  ToolProvider,
} from "../agent/contracts.js";
import type { AgentToolReceipt } from "../agent/loop.js";
import { issueContentFingerprint } from "../github/issue-identity.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import type { SecurityPolicy } from "../security/policy.js";
import { validateCommitSha, validateRefName } from "../security/refs.js";
import { stripTrackingMarkers } from "../review/tracking.js";
import type {
  GitHubBackendRequestControl,
  GitHubChecksSnapshot,
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubPullSnapshot,
  GitHubToolBackend,
} from "./github-backend.js";
import {
  COMMENT_MARKER_PREFIX,
  MAX_COMMENT_BYTES,
  MAX_PULL_BODY_BYTES,
  RESERVED_MARKER_PATTERN,
  assigneesInputSchema,
  boundedString,
  commentInputSchema,
  githubToolInputSchemas,
  githubToolManifest,
  githubToolMaxCalls,
  issueStateInputSchema,
  labelSchema,
  labelsInputSchema,
  loginSchema,
  pullMetadataInputSchema,
  type GitHubToolBinding,
} from "./github-catalog.js";
import { githubToolSchema, type GitHubToolId } from "./schema.js";

const MAX_API_CALL_MS = 15_000;

type RequestControl = GitHubBackendRequestControl;
type IssueView = GitHubIssueSnapshot;
type PullView = GitHubPullSnapshot;
type OwnedCommentView = GitHubCommentSnapshot;
type ChecksView = GitHubChecksSnapshot;

const effectSchema = z.enum(["read", "scheduled", "created", "updated", "unchanged"]);
const commonOutputSchema = z.strictObject({
  effect: effectSchema,
  target: boundedString(160, 160),
  attempts: z.number().int().min(0).max(2),
  reconciled: z.boolean(),
  externalEffect: z.enum(["none", "possible", "confirmed"]).optional(),
});
const labelsOutputSchema = commonOutputSchema.extend({ labels: z.array(labelSchema).max(20) });
const assigneesOutputSchema = commonOutputSchema.extend({
  assignees: z.array(loginSchema).max(10),
});
const stateOutputSchema = commonOutputSchema.extend({
  state: z.enum(["open", "closed"]),
  stateReason: z.enum(["completed", "not_planned", "reopened"]).nullable(),
});
const commentOutputSchema = commonOutputSchema.extend({ commentId: z.number().int().positive() });
const pullOutputSchema = commonOutputSchema.extend({
  title: boundedString(256, 1024),
  body: boundedString(MAX_PULL_BODY_BYTES, MAX_PULL_BODY_BYTES),
  state: z.enum(["open", "closed"]),
  base: boundedString(255, 1024),
  maintainerCanModify: z.boolean(),
});
const checksOutputSchema = commonOutputSchema.extend({
  headSha: z.string().regex(/^[0-9a-f]{40}$/u),
  combinedState: boundedString(32, 32),
  checkRuns: z
    .array(
      z.strictObject({
        name: boundedString(256, 1024),
        status: boundedString(32, 32),
        conclusion: boundedString(32, 32).nullable(),
      }),
    )
    .max(50),
  statuses: z
    .array(
      z.strictObject({
        context: boundedString(256, 1024),
        state: boundedString(32, 32),
        description: boundedString(512, 2048),
      }),
    )
    .max(50),
  truncated: z.boolean(),
});
const mutationToolSchema = githubToolSchema.exclude(["github.checks.read"]);
const scheduledOutputSchema = commonOutputSchema.extend({ operation: mutationToolSchema });

function bounded(value: string, bytes: number): string {
  const raw = Buffer.from(value, "utf8");
  if (raw.byteLength <= bytes) return value;
  let result = raw.subarray(0, bytes).toString("utf8");
  while (result.endsWith("\uFFFD") || Buffer.byteLength(result, "utf8") > bytes) {
    result = result.slice(0, -1);
  }
  return result;
}

function sanitizedPublicText(
  value: string,
  label: string,
  allowEmpty: boolean,
  maximumCharacters: number,
  maximumBytes: number,
): string {
  if (RESERVED_MARKER_PATTERN.test(value)) {
    throw new Error(`${label} contains a reserved Controller marker`);
  }
  const sanitized = sanitizeUntrustedText(stripTrackingMarkers(value));
  if (!allowEmpty && sanitized.trim() === "") {
    throw new Error(`${label} is empty after Controller sanitization`);
  }
  if (sanitized.length > maximumCharacters || Buffer.byteLength(sanitized, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds its bound after Controller sanitization`);
  }
  return sanitized;
}

function sanitizedOutputText(value: string, maximumBytes: number): string {
  return bounded(sanitizeUntrustedText(stripTrackingMarkers(value)), maximumBytes);
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function equalSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    JSON.stringify(sorted(left.map((value) => value.toLowerCase()))) ===
    JSON.stringify(sorted(right.map((value) => value.toLowerCase())))
  );
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

class GitHubEntityRevalidationError extends Error {
  public constructor(options?: ErrorOptions) {
    super("Trusted GitHub entity binding failed immediate revalidation", options);
    this.name = "GitHubEntityRevalidationError";
  }
}

function ambiguousMutationError(error: unknown): boolean {
  if (error instanceof GitHubEntityRevalidationError) return false;
  const status = errorStatus(error);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

interface InvocationDeadline {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("GitHub tool request aborted");
}

async function apiCall<T>(
  invocation: InvocationDeadline,
  start: (control: RequestControl) => Promise<T>,
): Promise<T> {
  if (invocation.signal?.aborted === true) throw abortError(invocation.signal);
  const remainingMs = invocation.deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error("GitHub tool invocation deadline exhausted");
  const timeoutMs = Math.min(MAX_API_CALL_MS, remainingMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("GitHub API request timed out")),
    timeoutMs,
  );
  const forwardAbort = (): void => controller.abort(abortError(invocation.signal));
  invocation.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const promise = start({ timeoutMs, signal: controller.signal });
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(abortError(controller.signal));
      controller.signal.addEventListener("abort", abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", abort));
    });
  } finally {
    clearTimeout(timer);
    invocation.signal?.removeEventListener("abort", forwardAbort);
  }
}

interface MutationResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly effect: "updated" | "unchanged";
  readonly reconciled: boolean;
}

class GitHubMutationExecutionError extends Error {
  public constructor(
    public readonly attempts: number,
    public readonly reconciled: boolean,
    public readonly externalEffect: "none" | "possible" | "confirmed",
    options?: ErrorOptions,
  ) {
    super("GitHub mutation failed its bounded retry and reconciliation policy", options);
    this.name = "GitHubMutationExecutionError";
  }
}

async function mutateWithPostcondition<T>(options: {
  readonly invocation: InvocationDeadline;
  readonly read: (control: RequestControl) => Promise<T>;
  readonly mutate: (control: RequestControl, markStarted: () => void) => Promise<void>;
  readonly matches: (value: T) => boolean;
}): Promise<MutationResult<T>> {
  const read = async (): Promise<T> => await apiCall(options.invocation, options.read);
  const before = await read();
  if (options.matches(before)) {
    return { value: before, attempts: 0, effect: "unchanged", reconciled: true };
  }
  let attempts = 0;
  let lastError: unknown;
  let reconciled = false;
  let possibleExternalEffect = false;
  while (attempts < 2) {
    attempts += 1;
    const mutation = { started: false };
    let mutationAcknowledged = false;
    try {
      await apiCall(options.invocation, async (control) =>
        options.mutate(control, () => {
          mutation.started = true;
        }),
      );
      mutationAcknowledged = true;
      const after = await read();
      if (!options.matches(after)) {
        throw new Error("GitHub mutation postcondition did not match the requested state");
      }
      return { value: after, attempts, effect: "updated", reconciled: true };
    } catch (error: unknown) {
      if (mutationAcknowledged) {
        throw new GitHubMutationExecutionError(attempts, reconciled, "confirmed", {
          cause: error,
        });
      }
      if (!mutation.started || error instanceof GitHubEntityRevalidationError) {
        throw new GitHubMutationExecutionError(
          attempts,
          reconciled,
          possibleExternalEffect ? "possible" : "none",
          { cause: error },
        );
      }
      if (options.invocation.signal?.aborted === true || !ambiguousMutationError(error)) {
        const externalEffect =
          possibleExternalEffect || ambiguousMutationError(error) ? "possible" : "none";
        throw new GitHubMutationExecutionError(attempts, reconciled, externalEffect, {
          cause: error,
        });
      }
      possibleExternalEffect = true;
      lastError = error;
      try {
        const value = await read();
        reconciled = true;
        if (options.matches(value)) {
          return { value, attempts, effect: "updated", reconciled: true };
        }
      } catch (readError: unknown) {
        throw new GitHubMutationExecutionError(attempts, reconciled, "possible", {
          cause: readError,
        });
      }
    }
  }
  throw new GitHubMutationExecutionError(
    attempts,
    reconciled,
    possibleExternalEffect ? "possible" : "none",
    { cause: lastError },
  );
}

export type GitHubMutationToolId = Exclude<GitHubToolId, "github.checks.read">;

export interface GitHubMutationValidationRequest {
  readonly workspacePath: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly mutations: readonly {
    readonly callId: string;
    readonly id: GitHubMutationToolId;
  }[];
}

/** Controller-owned validation gate invoked once before a non-empty mutation flush. */
export type GitHubMutationValidationGate = (
  request: GitHubMutationValidationRequest,
) => Promise<void>;

export interface GitHubAuthorityGatewayOptions {
  readonly ids: readonly GitHubToolId[];
  readonly binding: GitHubToolBinding;
  readonly policy: SecurityPolicy;
  readonly allowWrite: boolean;
  readonly expectedAuthorId: number;
  readonly backend: GitHubToolBackend;
  readonly validationGate?: GitHubMutationValidationGate;
}

export interface GitHubToolFlushReceipt {
  readonly result: AgentToolResult;
  readonly durationMs: number;
}

export function githubFlushHasExternalEffect(receipts: readonly GitHubToolFlushReceipt[]): boolean {
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

/** Replace deferred scheduling receipts with their bounded final Gateway receipts. */
export function mergeGitHubFlushReceipts(
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

export class GitHubToolFlushError extends Error {
  public readonly receipts: readonly GitHubToolFlushReceipt[];
  public readonly hasExternalEffect: boolean;

  public constructor(receipts: readonly GitHubToolFlushReceipt[], options?: ErrorOptions) {
    super("A deferred GitHub tool mutation failed during Controller finalization", options);
    this.name = "GitHubToolFlushError";
    this.receipts = receipts;
    this.hasExternalEffect = githubFlushHasExternalEffect(receipts);
  }
}

export class GitHubAuthorityGateway implements ToolProvider {
  public readonly id = "github";
  private readonly enabled: ReadonlySet<GitHubToolId>;
  private readonly calls = new Map<GitHubToolId, number>();
  private readonly backend: GitHubToolBackend;
  private binding: GitHubToolBinding;
  private readonly pending = new Map<string, AgentToolCall>();
  private flushing = false;
  private activeFlushCallId: string | undefined;

  public constructor(private readonly options: GitHubAuthorityGatewayOptions) {
    this.binding = options.binding;
    this.enabled = new Set(options.ids);
    if (this.enabled.size !== options.ids.length) throw new Error("Duplicate GitHub tool id");
    if (options.ids.some((id) => !githubToolSchema.safeParse(id).success)) {
      throw new Error("Invalid GitHub tool id");
    }
    if (
      options.ids.some((id) => id !== "github.checks.read") &&
      options.validationGate === undefined
    ) {
      throw new Error("GitHub mutation authority requires a Controller validation gate");
    }
    this.backend = options.backend;
    if (options.binding.repositoryId <= 0) throw new Error("Invalid trusted repository binding");
    if (!Number.isSafeInteger(options.expectedAuthorId) || options.expectedAuthorId <= 0) {
      throw new Error("Invalid trusted GitHub bot author binding");
    }
    if (options.binding.target === "issue") {
      if (
        !Number.isSafeInteger(options.binding.entityNumber) ||
        options.binding.entityNumber <= 0 ||
        (options.binding.state !== "open" && options.binding.state !== "closed") ||
        !Number.isFinite(Date.parse(options.binding.updatedAt)) ||
        !/^[a-f0-9]{64}$/u.test(options.binding.contentFingerprint)
      ) {
        throw new Error("Invalid trusted issue fingerprint binding");
      }
    } else {
      validateCommitSha(options.binding.headSha);
      if (options.binding.target === "pull_request") {
        validateCommitSha(options.binding.baseSha);
        validateRefName(options.binding.headRef);
        validateRefName(options.binding.baseRef);
        if (
          !Number.isSafeInteger(options.binding.entityNumber) ||
          options.binding.entityNumber <= 0 ||
          !Number.isSafeInteger(options.binding.headRepositoryId) ||
          !Number.isSafeInteger(options.binding.baseRepositoryId) ||
          options.binding.headRepositoryId !== options.binding.repositoryId ||
          options.binding.baseRepositoryId !== options.binding.repositoryId
        ) {
          throw new Error("GitHub PR tools require a same-repository trusted binding");
        }
      }
    }
  }

  public manifest(): readonly AgentToolManifest[] {
    return [...this.enabled].sort().map((id) => githubToolManifest(id));
  }

  public hasPendingMutations(): boolean {
    return this.pending.size > 0;
  }

  /** Advance only a same-PR head after the validated Controller write returns its commit SHA. */
  public advancePullHead(commitSha: string, expectedHeadRef: string): void {
    if (this.binding.target !== "pull_request") {
      throw new Error("Only a pull request binding can advance its trusted head");
    }
    const headSha = validateCommitSha(commitSha);
    const headRef = validateRefName(expectedHeadRef);
    if (headRef !== this.binding.headRef) {
      throw new Error("Validated Controller write head ref does not match the trusted PR binding");
    }
    this.binding = { ...this.binding, headSha };
  }

  public async flush(context: ToolInvocationContext): Promise<readonly GitHubToolFlushReceipt[]> {
    if (this.flushing) throw new Error("GitHub tool mutation flush is already active");
    const receipts: GitHubToolFlushReceipt[] = [];
    const deadlineMs = Date.now() + context.timeoutMs;
    this.flushing = true;
    try {
      if (this.pending.size > 0 && this.options.validationGate !== undefined) {
        await this.options.validationGate({
          workspacePath: context.workspacePath,
          timeoutMs: Math.max(0, deadlineMs - Date.now()),
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          mutations: [...this.pending.values()].map((call) => ({
            callId: call.callId,
            id: mutationToolSchema.parse(call.id),
          })),
        });
      }
      for (const [callId, call] of this.pending) {
        const startedAt = Date.now();
        this.activeFlushCallId = callId;
        try {
          const result = await this.invoke(call, {
            ...context,
            timeoutMs: Math.max(0, deadlineMs - Date.now()),
          });
          receipts.push({ result, durationMs: Math.max(0, Date.now() - startedAt) });
          this.pending.delete(callId);
        } catch (error: unknown) {
          const mutationError = error instanceof GitHubMutationExecutionError ? error : undefined;
          const output = scheduledOutputSchema.parse({
            effect: "scheduled",
            target: this.target(),
            attempts: mutationError?.attempts ?? 0,
            reconciled: mutationError?.reconciled ?? false,
            ...(mutationError === undefined || mutationError.externalEffect === "none"
              ? {}
              : { externalEffect: mutationError.externalEffect }),
            operation: call.id,
          });
          receipts.push({
            result: { callId: call.callId, id: call.id, ok: false, output },
            durationMs: Math.max(0, Date.now() - startedAt),
          });
          throw new GitHubToolFlushError(receipts, { cause: error });
        } finally {
          this.activeFlushCallId = undefined;
        }
      }
      return receipts;
    } finally {
      this.flushing = false;
    }
  }

  public dispose(): Promise<void> {
    this.pending.clear();
    return Promise.resolve();
  }

  private assertAuthority(id: GitHubToolId): void {
    const { policy } = this.options;
    const binding = this.binding;
    if (id === "github.checks.read") {
      if (
        binding.target === "issue" ||
        !policy.allowed ||
        policy.trust === "untrusted" ||
        !policy.capabilities.readCi
      ) {
        throw new Error("GitHub checks authority is not present in the trusted Controller context");
      }
      return;
    }
    if (!policy.allowed || policy.trust !== "trusted-write" || !this.options.allowWrite) {
      throw new Error("GitHub mutation authority requires trusted-write and allow-write=true");
    }
    if (binding.target === "workflow_run") {
      throw new Error("GitHub mutation authority is not bound to a current entity");
    }
    const capability =
      id === "github.issue.labels.set"
        ? policy.capabilities.manageIssueLabels
        : id === "github.issue.assignees.set"
          ? policy.capabilities.manageIssueAssignees
          : id === "github.issue.state.update"
            ? policy.capabilities.updateIssueState && binding.target === "issue"
            : id === "github.pull.metadata.update"
              ? policy.capabilities.updatePullRequestMetadata && binding.target === "pull_request"
              : policy.capabilities.publishComments;
    if (!capability) throw new Error(`GitHub mutation capability denied for ${id}`);
  }

  private target(): string {
    const entity =
      this.binding.target === "workflow_run"
        ? `head:${this.binding.headSha}`
        : `${this.binding.target}:${String(this.binding.entityNumber)}`;
    return `repository:${String(this.binding.repositoryId)}/${entity}`;
  }

  private async revalidateEntity(
    binding: Extract<GitHubToolBinding, { target: "issue" | "pull_request" }>,
    allowClosed: boolean,
    control: RequestControl,
  ): Promise<void> {
    if (binding.target === "issue") {
      const target = {
        owner: binding.owner,
        repo: binding.repo,
        issueNumber: binding.entityNumber,
      } as const;
      const [repository, issue] = await Promise.all([
        this.backend.getRepository(target, control),
        this.backend.getIssue(target, control),
      ]);
      const fingerprint = issueContentFingerprint({
        number: issue.number,
        title: issue.title,
        body: issue.body,
        authorId: issue.authorId,
      });
      if (
        repository.id !== binding.repositoryId ||
        issue.number !== binding.entityNumber ||
        issue.kind !== "issue" ||
        fingerprint !== binding.contentFingerprint ||
        (issue.state === "closed" && !allowClosed)
      ) {
        throw new Error("Bound issue identity or state changed before GitHub tool mutation");
      }
      return;
    }

    const pull = await this.backend.getPull(
      { owner: binding.owner, repo: binding.repo, pullNumber: binding.entityNumber },
      control,
    );
    if (
      pull.number !== binding.entityNumber ||
      pull.headSha !== binding.headSha ||
      pull.headRef !== binding.headRef ||
      pull.headRepositoryId !== binding.headRepositoryId ||
      pull.baseSha !== binding.baseSha ||
      pull.baseRef !== binding.baseRef ||
      pull.baseRepositoryId !== binding.baseRepositoryId ||
      binding.headRepositoryId !== binding.baseRepositoryId ||
      (pull.state === "closed" && !allowClosed)
    ) {
      throw new Error("Bound pull request identity or state changed before GitHub tool mutation");
    }
  }

  public async invoke(
    call: AgentToolCall,
    context: ToolInvocationContext,
  ): Promise<AgentToolResult> {
    const parsedId = githubToolSchema.safeParse(call.id);
    if (!parsedId.success || !this.enabled.has(parsedId.data)) {
      throw new Error(`Unknown or unauthorized tool: ${call.id}`);
    }
    const id = parsedId.data;
    if (this.flushing && this.activeFlushCallId !== call.callId) {
      throw new Error("Concurrent GitHub tool invocation during mutation flush is not allowed");
    }
    this.assertAuthority(id);
    const parsedInput = githubToolInputSchemas[id].safeParse(call.input);
    if (!parsedInput.success) {
      throw new Error(`Invalid input for ${id}: ${z.prettifyError(parsedInput.error)}`);
    }
    if (!this.flushing) {
      const next = (this.calls.get(id) ?? 0) + 1;
      if (next > githubToolMaxCalls[id]) {
        throw new Error(`GitHub tool ${id} exceeded its maxCalls limit`);
      }
      this.calls.set(id, next);
    }
    const invocation: InvocationDeadline = {
      deadlineMs: Date.now() + context.timeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
    const target = this.target();

    if (id === "github.checks.read") {
      const binding = this.binding;
      if (binding.target === "issue") throw new Error("Checks are not available for issue targets");
      const value: ChecksView = await apiCall(invocation, async (control) =>
        this.backend.readChecks(
          {
            owner: binding.owner,
            repo: binding.repo,
            headSha: validateCommitSha(binding.headSha),
          },
          control,
        ),
      );
      const output = checksOutputSchema.parse({
        effect: "read",
        target,
        attempts: 1,
        reconciled: false,
        headSha: validateCommitSha(binding.headSha),
        combinedState: bounded(value.combinedState, 32),
        checkRuns: value.checkRuns.slice(0, 50).map((check) => ({
          name: sanitizedOutputText(check.name, 1024).slice(0, 256),
          status: bounded(check.status, 32),
          conclusion: check.conclusion === null ? null : bounded(check.conclusion, 32),
        })),
        statuses: value.statuses.slice(0, 50).map((status) => ({
          context: sanitizedOutputText(status.context, 1024).slice(0, 256),
          state: bounded(status.state, 32),
          description: sanitizedOutputText(status.description, 2048).slice(0, 512),
        })),
        truncated:
          value.totalCount > value.checkRuns.length || value.statusCount > value.statuses.length,
      });
      return { callId: call.callId, id, ok: true, output };
    }

    if (!this.flushing) {
      const existing = this.pending.get(call.callId);
      if (existing !== undefined) {
        if (
          existing.id !== call.id ||
          JSON.stringify(existing.input) !== JSON.stringify(call.input)
        ) {
          throw new Error(`GitHub tool callId ${call.callId} was reused with different input`);
        }
      } else {
        this.pending.set(call.callId, { ...call, input: parsedInput.data });
      }
      const output = scheduledOutputSchema.parse({
        effect: "scheduled",
        target,
        attempts: 0,
        reconciled: false,
        operation: id,
      });
      return { callId: call.callId, id, ok: true, output };
    }
    const binding = this.binding;
    if (binding.target === "workflow_run") throw new Error("Mutation target is not an entity");
    const issueTarget = {
      owner: binding.owner,
      repo: binding.repo,
      issueNumber: binding.entityNumber,
    } as const;
    const allowClosed =
      id === "github.issue.state.update" ||
      (id === "github.pull.metadata.update" &&
        pullMetadataInputSchema.parse(parsedInput.data).state !== undefined);
    const revalidate = async (control: RequestControl): Promise<void> => {
      try {
        await this.revalidateEntity(binding, allowClosed, control);
      } catch (error: unknown) {
        throw new GitHubEntityRevalidationError({ cause: error });
      }
    };
    await apiCall(invocation, revalidate);

    if (id === "github.issue.labels.set") {
      const input = labelsInputSchema.parse(parsedInput.data);
      const result = await mutateWithPostcondition<IssueView>({
        invocation,
        read: async (control) => this.backend.getIssue(issueTarget, control),
        mutate: async (control, markStarted) => {
          await revalidate(control);
          markStarted();
          await this.backend.setLabels(issueTarget, input.labels, control);
        },
        matches: (value) => equalSet(value.labels, input.labels),
      });
      const output = labelsOutputSchema.parse({
        effect: result.effect,
        target,
        attempts: result.attempts,
        reconciled: result.reconciled,
        labels: sorted(result.value.labels).slice(0, 20),
      });
      return { callId: call.callId, id, ok: true, output };
    }
    if (id === "github.issue.assignees.set") {
      const input = assigneesInputSchema.parse(parsedInput.data);
      const result = await mutateWithPostcondition<IssueView>({
        invocation,
        read: async (control) => this.backend.getIssue(issueTarget, control),
        mutate: async (control, markStarted) => {
          await revalidate(control);
          markStarted();
          await this.backend.setAssignees(issueTarget, input.assignees, control);
        },
        matches: (value) => equalSet(value.assignees, input.assignees),
      });
      const output = assigneesOutputSchema.parse({
        effect: result.effect,
        target,
        attempts: result.attempts,
        reconciled: result.reconciled,
        assignees: sorted(result.value.assignees).slice(0, 10),
      });
      return { callId: call.callId, id, ok: true, output };
    }
    if (id === "github.issue.state.update") {
      if (binding.target !== "issue") throw new Error("Issue state cannot target a pull request");
      const input = issueStateInputSchema.parse(parsedInput.data);
      const update = {
        state: input.state,
        ...(input.stateReason === undefined ? {} : { stateReason: input.stateReason }),
      } as const;
      const result = await mutateWithPostcondition<IssueView>({
        invocation,
        read: async (control) => this.backend.getIssue(issueTarget, control),
        mutate: async (control, markStarted) => {
          await revalidate(control);
          markStarted();
          await this.backend.updateIssueState(issueTarget, update, control);
        },
        matches: (value) =>
          value.state === input.state &&
          (input.stateReason === undefined || value.stateReason === input.stateReason),
      });
      const output = stateOutputSchema.parse({
        effect: result.effect,
        target,
        attempts: result.attempts,
        reconciled: result.reconciled,
        state: result.value.state,
        stateReason: result.value.stateReason,
      });
      return { callId: call.callId, id, ok: true, output };
    }
    if (id === "github.comment.create") {
      const input = commentInputSchema.parse(parsedInput.data);
      const markerId = createHash("sha256").update(call.callId, "utf8").digest("hex");
      const marker = `${COMMENT_MARKER_PREFIX}${markerId} -->`;
      const suffix = `\n\n${marker}`;
      const safeBodyBytes = MAX_COMMENT_BYTES - Buffer.byteLength(suffix, "utf8");
      const safeBody = sanitizedPublicText(
        input.body,
        "GitHub comment body",
        false,
        safeBodyBytes,
        safeBodyBytes,
      );
      const body = `${safeBody}${suffix}`;
      if (Buffer.byteLength(body, "utf8") > MAX_COMMENT_BYTES) {
        throw new Error("GitHub comment body exceeds its complete outbound byte bound");
      }
      const find = (comments: readonly OwnedCommentView[]) =>
        comments.find(
          (comment) =>
            comment.authorId === this.options.expectedAuthorId && comment.body.includes(marker),
        );
      const existing = find(
        await apiCall(invocation, async (control) =>
          this.backend.listRecentComments(issueTarget, control),
        ),
      );
      if (existing !== undefined) {
        const output = commentOutputSchema.parse({
          effect: "unchanged",
          target,
          attempts: 0,
          reconciled: true,
          commentId: existing.id,
        });
        return { callId: call.callId, id, ok: true, output };
      }
      const attempts = 1;
      const mutation = { started: false };
      let acknowledged = false;
      let mutationError: unknown;
      try {
        await apiCall(invocation, async (control) => {
          await revalidate(control);
          mutation.started = true;
          await this.backend.createComment(issueTarget, body, control);
        });
        acknowledged = true;
      } catch (error: unknown) {
        mutationError = error;
        if (!mutation.started || error instanceof GitHubEntityRevalidationError) {
          throw new GitHubMutationExecutionError(attempts, false, "none", { cause: error });
        }
        if (!ambiguousMutationError(error)) {
          throw new GitHubMutationExecutionError(attempts, false, "none", { cause: error });
        }
      }
      try {
        const recovered = find(
          await apiCall(invocation, async (control) =>
            this.backend.listRecentComments(issueTarget, control),
          ),
        );
        if (recovered !== undefined) {
          const output = commentOutputSchema.parse({
            effect: "created",
            target,
            attempts,
            reconciled: true,
            commentId: recovered.id,
          });
          return { callId: call.callId, id, ok: true, output };
        }
        throw new GitHubMutationExecutionError(
          attempts,
          true,
          acknowledged ? "confirmed" : "possible",
          { cause: mutationError },
        );
      } catch (error: unknown) {
        if (error instanceof GitHubMutationExecutionError) throw error;
        throw new GitHubMutationExecutionError(
          attempts,
          false,
          acknowledged ? "confirmed" : "possible",
          { cause: error },
        );
      }
    }

    if (binding.target !== "pull_request") throw new Error("Pull metadata target is not a PR");
    const pullTarget = {
      owner: binding.owner,
      repo: binding.repo,
      pullNumber: binding.entityNumber,
    } as const;
    const rawInput = pullMetadataInputSchema.parse(parsedInput.data);
    const input = {
      ...(rawInput.title === undefined
        ? {}
        : {
            title: sanitizedPublicText(rawInput.title, "pull request title", false, 256, 1024),
          }),
      ...(rawInput.body === undefined
        ? {}
        : {
            body: sanitizedPublicText(
              rawInput.body,
              "pull request body",
              true,
              MAX_PULL_BODY_BYTES,
              MAX_PULL_BODY_BYTES,
            ),
          }),
      ...(rawInput.state === undefined ? {} : { state: rawInput.state }),
      ...(rawInput.maintainerCanModify === undefined
        ? {}
        : { maintainerCanModify: rawInput.maintainerCanModify }),
    };
    const matches = (value: PullView): boolean =>
      (input.title === undefined || value.title === input.title) &&
      (input.body === undefined || value.body === input.body) &&
      (input.state === undefined || value.state === input.state) &&
      (input.maintainerCanModify === undefined ||
        value.maintainerCanModify === input.maintainerCanModify);
    const result = await mutateWithPostcondition<PullView>({
      invocation,
      read: async (control) => this.backend.getPull(pullTarget, control),
      mutate: async (control, markStarted) => {
        await revalidate(control);
        markStarted();
        await this.backend.updatePull(pullTarget, input, control);
      },
      matches,
    });
    const output = pullOutputSchema.parse({
      effect: result.effect,
      target,
      attempts: result.attempts,
      reconciled: result.reconciled,
      title: sanitizedOutputText(result.value.title, 1024).slice(0, 256),
      body: sanitizedOutputText(result.value.body, MAX_PULL_BODY_BYTES),
      state: result.value.state,
      base: result.value.baseRef,
      maintainerCanModify: result.value.maintainerCanModify,
    });
    return { callId: call.callId, id, ok: true, output };
  }
}
