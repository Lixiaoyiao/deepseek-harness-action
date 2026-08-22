import * as core from "@actions/core";

import type { Operation } from "../commands/parse.js";
import { PHASE_TIMEOUTS } from "../lifecycle/deadline.js";
import type { ActionFailure } from "../result.js";
import { createTrackingMarker, type TrackingKind } from "../review/tracking.js";
import type { SecurityPolicy } from "../security/policy.js";
import { redactSecrets, sanitizeUntrustedText } from "../security/redaction.js";
import type { GitHubClient } from "./client.js";
import { upsertTrackingComment, type CommentTarget } from "./comments.js";

export type ProgressStage = "context" | "agent" | "finalizing" | "complete" | "blocked";

export interface ProgressReporterOptions {
  readonly client: GitHubClient;
  readonly target: CommentTarget;
  readonly expectedAuthorId: number;
  readonly operation: Operation;
  readonly policy: SecurityPolicy;
  readonly runUrl: string;
  /** Controller cancellation applies only to non-terminal lifecycle updates. */
  readonly signal?: AbortSignal;
  readonly warning?: (message: string) => void;
}

interface ProgressView {
  readonly operation: Operation;
  readonly policy: SecurityPolicy;
  readonly runUrl: string;
  readonly stage: ProgressStage;
  readonly message: string;
  readonly failure?: ActionFailure;
}

type PublicationState = Pick<ProgressView, "stage" | "message" | "failure">;

interface QueuedPublication {
  readonly state: PublicationState;
  readonly resolve: () => void;
}

const stages: readonly {
  key: Exclude<ProgressStage, "complete" | "blocked">;
  label: string;
}[] = [
  { key: "context", label: "Route, authorize, and build immutable context" },
  { key: "agent", label: "Run DeepSeek Harness and validate its structured output" },
  { key: "finalizing", label: "Publish the result or apply the trusted write" },
];

function trackingKind(operation: Operation): Exclude<TrackingKind, "finding"> {
  if (operation === "review") return "summary";
  if (operation === "diagnose") return "diagnosis";
  if (operation === "task") return "task";
  return "write";
}

function repositoryAccess(policy: SecurityPolicy): string {
  if (policy.trust === "untrusted") return "bounded context only; no workspace";
  if (policy.capabilities.modifyWorkspace) return "read/write `.git`-less snapshot";
  return policy.capabilities.readRepository ? "read-only `.git`-less snapshot" : "none";
}

function githubAccess(policy: SecurityPolicy): string {
  const capabilities = [
    policy.capabilities.publishComments ? "comments" : "",
    policy.capabilities.commit ? "commit" : "",
    policy.capabilities.push ? "push" : "",
    policy.capabilities.createPullRequest ? "open PR" : "",
  ].filter(Boolean);
  return capabilities.length === 0 ? "none" : capabilities.join(", ");
}

function executionAccess(policy: SecurityPolicy): string {
  return policy.capabilities.executeRepositoryCode
    ? "maintainer-defined fixed-argv tools and final validation"
    : "disabled";
}

function safeText(value: string): string {
  return sanitizeUntrustedText(value.replace(/<!--\s*dsh-action:[\s\S]*?-->/giu, "")).slice(
    0,
    8_000,
  );
}

function safeTableCell(value: string): string {
  return safeText(value)
    .replace(/[\r\n]+/gu, " ")
    .replaceAll("|", "\\|");
}

export function renderProgressComment(view: ProgressView): string {
  const current =
    view.stage === "complete"
      ? stages.length
      : view.stage === "blocked"
        ? stages.length - 1
        : stages.findIndex(({ key }) => key === view.stage);
  const checklist = stages.map(({ label }, index) => {
    if (view.failure !== undefined && index === current) return `- [ ] ❌ ${label}`;
    if (view.stage === "blocked" && index === current) return `- [ ] ⚠️ ${label}`;
    if (index < current || view.stage === "complete") return `- [x] ${label}`;
    if (index === current) return `- [ ] ⏳ ${label}`;
    return `- [ ] ${label}`;
  });
  const status =
    view.failure === undefined
      ? view.stage === "complete"
        ? "✅ Completed"
        : view.stage === "blocked"
          ? "⚠️ Blocked"
          : "⏳ In progress"
      : `❌ ${safeText(view.failure.title)}`;
  const body = [
    createTrackingMarker({ kind: trackingKind(view.operation) }),
    `## DeepSeek Harness · ${view.operation}`,
    "",
    `**${status}**`,
    "",
    ...checklist,
    "",
    safeText(view.message),
    "",
    "| Trust boundary | Effective access |",
    "| --- | --- |",
    `| Trust tier | \`${view.policy.trust}\` |`,
    `| Policy decision | ${safeTableCell(view.policy.reason)} |`,
    `| Repository | ${repositoryAccess(view.policy)} |`,
    `| Repository code execution | ${executionAccess(view.policy)} |`,
    `| GitHub controller writes | ${githubAccess(view.policy)} |`,
  ];
  if (view.failure !== undefined) {
    body.push(
      "",
      `**Failure code:** \`${view.failure.code}\` · **Phase:** \`${view.failure.phase}\``,
      "",
      safeText(view.failure.message),
      "",
      `**Next step:** ${safeText(view.failure.guidance)}`,
    );
  }
  body.push("", `<sub>[Workflow run](${view.runUrl}) · this comment updates in place</sub>`);
  return body.join("\n").slice(0, 65_000);
}

export class StickyProgressReporter {
  public commentId: number | undefined;
  private stage: ProgressStage = "context";
  private lastBody: string | undefined;
  private readonly warning: (message: string) => void;
  private readonly queue: QueuedPublication[] = [];
  private activeNonTerminal: AbortController | undefined;
  private draining = false;
  private terminal = false;
  private terminalState: PublicationState | undefined;
  private activeTerminal: AbortController | undefined;
  private terminalPublication: Promise<void> | undefined;

  public constructor(private readonly options: ProgressReporterOptions) {
    this.warning = options.warning ?? core.warning;
  }

  public async update(stage: Exclude<ProgressStage, "complete">, message: string): Promise<void> {
    if (this.terminal) return await this.terminalPublication;
    this.stage = stage;
    await this.enqueueNonTerminal({ stage, message });
  }

  public async complete(message: string): Promise<void> {
    if (this.terminal) return await this.terminalPublication;
    this.stage = "complete";
    await this.publishTerminal({ stage: "complete", message });
  }

  public async blocked(message: string): Promise<void> {
    if (this.terminal) return await this.terminalPublication;
    this.stage = "blocked";
    await this.publishTerminal({ stage: "blocked", message });
  }

  public async fail(failure: ActionFailure): Promise<void> {
    const state: PublicationState = {
      stage: this.stage,
      message: "The run stopped before completion.",
      failure,
    };
    if (!this.terminal) {
      await this.publishTerminal(state);
      return;
    }
    if (this.terminalState?.failure?.code === "DSH_ABORTED" && failure.code !== "DSH_ABORTED") {
      await this.correctProvisionalTerminal(state);
      return;
    }
    await this.terminalPublication;
  }

  private async enqueueNonTerminal(state: PublicationState): Promise<void> {
    await new Promise<void>((resolve) => {
      this.queue.push({ state, resolve });
      this.startDrain();
    });
  }

  private startDrain(): void {
    if (this.draining) return;
    this.draining = true;
    void this.drainNonTerminal();
  }

  private async drainNonTerminal(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const publication = this.queue.shift();
        if (publication === undefined) continue;
        if (this.terminal || this.options.signal?.aborted === true) {
          publication.resolve();
          continue;
        }
        const controller = new AbortController();
        this.activeNonTerminal = controller;
        const signal =
          this.options.signal === undefined
            ? controller.signal
            : AbortSignal.any([controller.signal, this.options.signal]);
        await this.publish(publication.state, signal, false);
        if (this.activeNonTerminal === controller) this.activeNonTerminal = undefined;
        publication.resolve();
      }
    } finally {
      this.activeNonTerminal = undefined;
      this.draining = false;
      if (this.queue.length > 0) this.startDrain();
    }
  }

  private async publishTerminal(state: PublicationState): Promise<void> {
    this.terminal = true;
    this.terminalState = state;
    this.activeNonTerminal?.abort(new Error("Superseded by terminal progress"));
    for (const publication of this.queue.splice(0)) publication.resolve();

    await this.startTerminalPublication(state);
  }

  private async correctProvisionalTerminal(state: PublicationState): Promise<void> {
    this.terminalState = state;
    this.activeTerminal?.abort(new Error("Superseded by authoritative terminal failure"));
    await this.startTerminalPublication(state);
  }

  private async startTerminalPublication(state: PublicationState): Promise<void> {
    const controller = new AbortController();
    this.activeTerminal = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error("Terminal progress finalization timed out")),
      PHASE_TIMEOUTS.cancellationFinalizationMs,
    );
    this.terminalPublication = this.publish(state, controller.signal, true).finally(() => {
      clearTimeout(timeout);
      if (this.activeTerminal === controller) this.activeTerminal = undefined;
    });
    await this.terminalPublication;
  }

  private async publish(
    state: PublicationState,
    signal: AbortSignal,
    terminal: boolean,
  ): Promise<void> {
    const body = renderProgressComment({
      operation: this.options.operation,
      policy: this.options.policy,
      runUrl: this.options.runUrl,
      ...state,
    });
    if (body === this.lastBody) return;
    try {
      this.commentId = await upsertTrackingComment(
        this.options.client,
        this.options.target,
        this.options.expectedAuthorId,
        trackingKind(this.options.operation),
        body,
        { signal },
      );
      if (signal.aborted) return;
      this.lastBody = body;
    } catch (error: unknown) {
      if (signal.aborted && (!terminal || this.activeTerminal?.signal !== signal)) return;
      const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(
        0,
        500,
      );
      this.warning(`Progress comment update failed: ${detail}`);
    }
  }
}
