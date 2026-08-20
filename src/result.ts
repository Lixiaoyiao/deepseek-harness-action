import type { Operation } from "./commands/parse.js";
import {
  AgentDeadlineError,
  AgentLoopLimitError,
  AgentNoProgressError,
  type AgentToolReceipt,
} from "./agent/loop.js";
import { DshError } from "./dsh/errors.js";
import type { DshIsolationReport } from "./dsh/runner.js";
import type { PublicationResult } from "./review/publisher.js";
import { stripTrackingMarkers } from "./review/tracking.js";
import type { SecurityPolicy } from "./security/policy.js";
import { redactSecrets, sanitizeUntrustedText } from "./security/redaction.js";
import { ValidationFailureError } from "./write/validate.js";

export type ActionConclusion = "success" | "neutral" | "failure";
export type ActionStatus =
  "success" | "neutral" | "failed" | "timed_out" | "validation_failed" | "denied";
export type ActionPhase =
  | "configuration"
  | "routing"
  | "authorization"
  | "context"
  | "agent"
  | "validation"
  | "publication"
  | "write";

export interface ActionFailure {
  readonly code: string;
  readonly phase: ActionPhase;
  readonly title: string;
  readonly message: string;
  readonly guidance: string;
  readonly retryable: boolean;
}

export interface AgentRunSummary {
  readonly durationMs: number;
  readonly isolation: DshIsolationReport;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly validationRetries?: number;
  readonly toolReceipts?: readonly AgentToolReceipt[];
}

export interface ValidationSummary {
  readonly status: "passed" | "failed" | "skipped" | "not-applicable";
  readonly commandCount: number;
}

export interface RunOutcome {
  readonly schemaVersion: 1;
  readonly conclusion: ActionConclusion;
  readonly operation?: Operation;
  readonly summary: string;
  readonly findingsCount: number;
  readonly durationMs: number;
  readonly runUrl?: string;
  readonly policy?: SecurityPolicy;
  readonly agent?: AgentRunSummary;
  readonly publication?: PublicationResult;
  readonly validation?: ValidationSummary;
  readonly writeStatus?: "success" | "partial-success";
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly commentId?: number;
  readonly error?: ActionFailure;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 4_000);
}

const dshFailureMetadata: Readonly<
  Record<string, { title: string; guidance: string; retryable: boolean }>
> = {
  DSH_ABORTED: {
    title: "DeepSeek Harness was cancelled",
    guidance: "Check whether a newer workflow run cancelled this one, then rerun if needed.",
    retryable: true,
  },
  DSH_CONFIGURATION: {
    title: "DeepSeek Harness configuration is invalid",
    guidance: "Check the action inputs, pinned DSH version, and container image reference.",
    retryable: false,
  },
  DSH_CREDENTIAL_LEAK: {
    title: "Credential safety check stopped the run",
    guidance: "Rotate any potentially exposed credential and inspect the linked workflow run.",
    retryable: false,
  },
  DSH_ENVIRONMENT: {
    title: "The runner environment is not usable",
    guidance: "Check the runner prerequisites and the isolation configuration.",
    retryable: false,
  },
  DSH_ISOLATION_UNAVAILABLE: {
    title: "Required isolation is unavailable",
    guidance: "Ensure Docker is installed and available to the runner, then rerun the job.",
    retryable: false,
  },
  DSH_MALFORMED_OUTPUT: {
    title: "DSH output did not pass validation",
    guidance:
      "Retry once. If it persists, verify the pinned dsh-version and inspect the schema error in the workflow run.",
    retryable: true,
  },
  DSH_OUTPUT_LIMIT: {
    title: "DSH produced too much output",
    guidance: "Reduce the task scope or repository context before rerunning.",
    retryable: false,
  },
  DSH_PROCESS_FAILED: {
    title: "DeepSeek Harness exited unsuccessfully",
    guidance: "Inspect the workflow run for the worker error, then rerun after correcting it.",
    retryable: true,
  },
  DSH_PROXY: {
    title: "The DeepSeek API proxy failed",
    guidance:
      "Check API availability, the base URL, and the configured credential before rerunning.",
    retryable: true,
  },
  DSH_SPAWN: {
    title: "DeepSeek Harness could not start",
    guidance: "Check the runner runtime and configured DSH executable or container.",
    retryable: false,
  },
  DSH_TIMEOUT: {
    title: "DeepSeek Harness timed out",
    guidance: "Increase timeout-minutes or reduce the task scope, then rerun the workflow.",
    retryable: true,
  },
};

const phaseMetadata: Readonly<
  Record<ActionPhase, { code: string; title: string; guidance: string; retryable: boolean }>
> = {
  configuration: {
    code: "ACTION_CONFIGURATION",
    title: "Action configuration is invalid",
    guidance: "Check the workflow inputs and required secrets.",
    retryable: false,
  },
  routing: {
    code: "EVENT_ROUTING_FAILED",
    title: "The GitHub event could not be routed",
    guidance: "Check the supported event and @dsh command syntax.",
    retryable: false,
  },
  authorization: {
    code: "POLICY_DENIED",
    title: "The requested operation was denied",
    guidance: "Review actor permissions, fork status, event type, and the allow-write setting.",
    retryable: false,
  },
  context: {
    code: "CONTEXT_PREPARATION_FAILED",
    title: "Repository context could not be prepared",
    guidance:
      "Check repository access and whether the issue or pull request changed during the run.",
    retryable: true,
  },
  agent: {
    code: "AGENT_FAILED",
    title: "DeepSeek Harness failed",
    guidance: "Inspect the workflow run, then retry after correcting the reported worker error.",
    retryable: true,
  },
  validation: {
    code: "VALIDATION_FAILED",
    title: "Validation did not pass",
    guidance:
      "Inspect the failing command in the workflow run and fix the generated change or test setup.",
    retryable: false,
  },
  publication: {
    code: "PUBLICATION_FAILED",
    title: "The result could not be published",
    guidance: "Check GitHub token permissions and rerun; model work may already have completed.",
    retryable: true,
  },
  write: {
    code: "WRITE_FAILED",
    title: "The trusted write could not be completed",
    guidance: "Check whether the bound branch, issue, or pull request changed during the run.",
    retryable: true,
  },
};

export function describeActionFailure(error: unknown, phase: ActionPhase): ActionFailure {
  if (error instanceof AgentDeadlineError) {
    return {
      code: error.code,
      phase: "agent",
      title: "Agent loop timed out",
      message: safeMessage(error),
      guidance: "Increase timeout-minutes or reduce the task and validation scope.",
      retryable: true,
    };
  }
  if (error instanceof AgentNoProgressError || error instanceof AgentLoopLimitError) {
    return {
      code: error.code,
      phase: "agent",
      title:
        error instanceof AgentNoProgressError
          ? "Agent repair loop made no progress"
          : "Agent turn limit reached",
      message: safeMessage(error),
      guidance:
        error instanceof AgentNoProgressError
          ? "Inspect the repeated validation failure and adjust the task, tools, or repository setup."
          : "Increase max-turns or reduce the task scope, then rerun.",
      retryable: false,
    };
  }
  if (error instanceof ValidationFailureError) {
    return {
      code: error.code,
      phase: "validation",
      title: error.timedOut ? "Validation timed out" : "Validation did not pass",
      message: safeMessage(error),
      guidance: error.timedOut
        ? "Reduce the validation workload or split the configured commands before rerunning."
        : "Inspect the failing command in the workflow run and correct the generated change or test setup.",
      retryable: error.timedOut,
    };
  }
  if (error instanceof DshError) {
    const metadata = dshFailureMetadata[error.code] ?? phaseMetadata.agent;
    return {
      code: error.code,
      phase,
      title: metadata.title,
      message: safeMessage(error),
      guidance: metadata.guidance,
      retryable: metadata.retryable,
    };
  }
  const metadata = phaseMetadata[phase];
  return {
    code: metadata.code,
    phase,
    title: metadata.title,
    message: safeMessage(error),
    guidance: metadata.guidance,
    retryable: metadata.retryable,
  };
}

function structuredResult(outcome: RunOutcome): Record<string, unknown> {
  const write = {
    ...(outcome.writeStatus === undefined ? {} : { status: outcome.writeStatus }),
    ...(outcome.commitSha === undefined ? {} : { commitSha: outcome.commitSha }),
    ...(outcome.changedPaths === undefined ? {} : { changedPaths: outcome.changedPaths }),
    ...(outcome.branchName === undefined ? {} : { branchName: outcome.branchName }),
    ...(outcome.pullRequestNumber === undefined
      ? {}
      : { pullRequestNumber: outcome.pullRequestNumber }),
    ...(outcome.pullRequestUrl === undefined ? {} : { pullRequestUrl: outcome.pullRequestUrl }),
  };
  return {
    schemaVersion: outcome.schemaVersion,
    status: actionStatus(outcome),
    conclusion: outcome.conclusion,
    operation: outcome.operation ?? "none",
    summary: outcome.summary,
    findingsCount: outcome.findingsCount,
    timing: {
      durationMs: outcome.durationMs,
      ...(outcome.agent === undefined ? {} : { agentDurationMs: outcome.agent.durationMs }),
    },
    ...(outcome.runUrl === undefined ? {} : { run: { url: outcome.runUrl } }),
    ...(outcome.policy === undefined
      ? {}
      : {
          policy: {
            trust: outcome.policy.trust,
            allowed: outcome.policy.allowed,
            reason: outcome.policy.reason,
            capabilities: outcome.policy.capabilities,
          },
        }),
    ...(outcome.agent === undefined
      ? {}
      : {
          isolation: outcome.agent.isolation,
          loop: {
            ...(outcome.agent.turns === undefined ? {} : { turns: outcome.agent.turns }),
            ...(outcome.agent.toolCalls === undefined
              ? {}
              : { toolCalls: outcome.agent.toolCalls }),
            ...(outcome.agent.validationRetries === undefined
              ? {}
              : { validationRetries: outcome.agent.validationRetries }),
            ...(outcome.agent.toolReceipts === undefined
              ? {}
              : { toolReceipts: outcome.agent.toolReceipts }),
          },
        }),
    ...(outcome.publication === undefined ? {} : { publication: outcome.publication }),
    ...(outcome.validation === undefined ? {} : { validation: outcome.validation }),
    ...(Object.keys(write).length === 0 ? {} : { write }),
    ...(outcome.commentId === undefined ? {} : { commentId: outcome.commentId }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

export function actionStatus(outcome: RunOutcome): ActionStatus {
  if (outcome.conclusion !== "failure") return outcome.conclusion;
  if (outcome.error?.code === "DSH_TIMEOUT" || outcome.error?.code === "AGENT_TIMEOUT") {
    return "timed_out";
  }
  if (
    outcome.error?.phase === "validation" ||
    outcome.error?.code === "DSH_MALFORMED_OUTPUT" ||
    outcome.error?.code.startsWith("VALIDATION_") === true
  ) {
    return "validation_failed";
  }
  if (outcome.error?.code === "POLICY_DENIED") return "denied";
  return "failed";
}

export function buildActionOutputs(outcome: RunOutcome): Readonly<Record<string, string | number>> {
  return {
    conclusion: outcome.conclusion,
    operation: outcome.operation ?? "none",
    summary: outcome.summary,
    "review-summary": outcome.summary,
    "findings-count": outcome.findingsCount,
    "branch-name": outcome.branchName ?? "",
    "pull-request-url": outcome.pullRequestUrl ?? "",
    "commit-sha": outcome.commitSha ?? "",
    trust: outcome.policy?.trust ?? "none",
    "duration-ms": outcome.durationMs,
    "comment-id": outcome.commentId ?? "",
    "error-code": outcome.error?.code ?? "",
    "error-message": outcome.error?.message ?? "",
    "result-json": JSON.stringify(structuredResult(outcome)),
  };
}

function safeMarkdown(value: string): string {
  return sanitizeUntrustedText(stripTrackingMarkers(value));
}

export function formatStepSummary(outcome: RunOutcome): string {
  const lines = [
    `**Status:** ${outcome.conclusion}`,
    `**Operation:** ${outcome.operation ?? "none"}`,
    `**Trust:** ${outcome.policy?.trust ?? "not resolved"}`,
    `**Duration:** ${(outcome.durationMs / 1_000).toFixed(1)}s`,
    "",
    safeMarkdown(outcome.summary),
  ];
  if (outcome.error !== undefined) {
    lines.push(
      "",
      `### ${safeMarkdown(outcome.error.title)}`,
      "",
      `**Code:** \`${outcome.error.code}\` · **Phase:** \`${outcome.error.phase}\``,
      "",
      safeMarkdown(outcome.error.message),
      "",
      `**Next step:** ${safeMarkdown(outcome.error.guidance)}`,
    );
  }
  if (outcome.pullRequestUrl !== undefined) {
    lines.push("", `**Pull request:** ${outcome.pullRequestUrl}`);
  }
  if (outcome.commitSha !== undefined) {
    lines.push("", `**Commit:** \`${outcome.commitSha}\``);
  }
  if (outcome.runUrl !== undefined) lines.push("", `[Workflow run](${outcome.runUrl})`);
  return lines.join("\n");
}
