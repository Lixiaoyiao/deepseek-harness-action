import * as core from "@actions/core";

import type { Operation } from "../commands/parse.js";
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

  public constructor(private readonly options: ProgressReporterOptions) {
    this.warning = options.warning ?? core.warning;
  }

  public async update(stage: Exclude<ProgressStage, "complete">, message: string): Promise<void> {
    this.stage = stage;
    await this.publish({ stage, message });
  }

  public async complete(message: string): Promise<void> {
    this.stage = "complete";
    await this.publish({ stage: "complete", message });
  }

  public async blocked(message: string): Promise<void> {
    this.stage = "blocked";
    await this.publish({ stage: "blocked", message });
  }

  public async fail(failure: ActionFailure): Promise<void> {
    await this.publish({
      stage: this.stage,
      message: "The run stopped before completion.",
      failure,
    });
  }

  private async publish(state: Pick<ProgressView, "stage" | "message" | "failure">): Promise<void> {
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
      );
      this.lastBody = body;
    } catch (error: unknown) {
      const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(
        0,
        500,
      );
      this.warning(`Progress comment update failed: ${detail}`);
    }
  }
}
