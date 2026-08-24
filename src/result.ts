import type { Operation } from "./commands/parse.js";
import {
  AgentDeadlineError,
  AgentLoopLimitError,
  AgentNoProgressError,
  type AgentToolReceipt,
} from "./agent/loop.js";
import { DshError } from "./dsh/errors.js";
import {
  isClassifiedActionError,
  type ActionErrorCategory,
  type ClassifiedActionError,
} from "./errors.js";
import type { DshIsolationReport, DshToolReceipt } from "./dsh/runner.js";
import type { ExtensionAudit } from "./extensions/plan.js";
import type { PermissionAudit, ToolPolicyAudit } from "./permissions/profile.js";
import type { PublicationResult } from "./review/publisher.js";
import { stripTrackingMarkers } from "./review/tracking.js";
import type { SecurityPolicy } from "./security/policy.js";
import { redactSecrets, sanitizeUntrustedText } from "./security/redaction.js";
import {
  ValidationIntegrityError,
  type ValidationIntegritySummary,
} from "./write/validation-integrity.js";
import { ValidationFailureError } from "./write/validate.js";

export type ActionConclusion = "success" | "neutral" | "failure";
export type ActionStatus =
  "success" | "neutral" | "failed" | "timed_out" | "validation_failed" | "denied";
export type ActionPhase =
  | "entrypoint"
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
  readonly category: ActionErrorCategory;
  /** Controller lifecycle location where the stable error surfaced. */
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
  readonly dshToolReceipts?: readonly DshToolReceipt[];
  readonly extensionAudit?: ExtensionAudit;
}

export interface ValidationSummary {
  readonly status: "passed" | "failed" | "skipped" | "not-applicable";
  readonly commandCount: number;
  readonly integrity?: ValidationIntegritySummary;
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
  readonly permission?: PermissionAudit;
  readonly toolPolicy?: ToolPolicyAudit;
  readonly agent?: AgentRunSummary;
  readonly publication?: PublicationResult;
  readonly validation?: ValidationSummary;
  readonly writeStatus?: "success" | "partial-success" | "no-changes";
  readonly commitSha?: string;
  readonly changedPaths?: readonly string[];
  readonly branchName?: string;
  readonly pullRequestNumber?: number;
  readonly pullRequestUrl?: string;
  readonly commentId?: number;
  /** Controller-validated maintainer-defined task result; never an authority input. */
  readonly taskOutput?: unknown;
  readonly error?: ActionFailure;
}

interface PublicReceiptPayload {
  readonly controller: readonly AgentToolReceipt[];
  readonly dsh: readonly DshToolReceipt[];
  readonly truncated: boolean;
  readonly droppedCount: number;
}

const MAX_LARGE_ACTION_OUTPUT_UTF16_BYTES = 640 * 1024;

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 4_000);
}

const dshFailureMetadata: Readonly<Record<string, { title: string; guidance: string }>> = {
  DSH_ABORTED: {
    title: "DeepSeek Harness was cancelled",
    guidance: "Check whether a newer workflow run cancelled this one, then rerun if needed.",
  },
  DSH_CONFIGURATION: {
    title: "DeepSeek Harness configuration is invalid",
    guidance: "Check the action inputs, pinned DSH version, and container image reference.",
  },
  DSH_CREDENTIAL_LEAK: {
    title: "Credential safety check stopped the run",
    guidance: "Rotate any potentially exposed credential and inspect the linked workflow run.",
  },
  DSH_ENVIRONMENT: {
    title: "The runner environment is not usable",
    guidance: "Check the runner prerequisites and the isolation configuration.",
  },
  DSH_ISOLATION_UNAVAILABLE: {
    title: "Required isolation is unavailable",
    guidance: "Ensure Docker is installed and available to the runner, then rerun the job.",
  },
  DSH_MALFORMED_OUTPUT: {
    title: "DSH output did not pass validation",
    guidance:
      "Retry once. If it persists, verify the pinned dsh-version and inspect the schema error in the workflow run.",
  },
  DSH_OUTPUT_LIMIT: {
    title: "DSH produced too much output",
    guidance: "Reduce the task scope or repository context before rerunning.",
  },
  DSH_PROCESS_FAILED: {
    title: "DeepSeek Harness exited unsuccessfully",
    guidance: "Inspect the workflow run for the worker error, then rerun after correcting it.",
  },
  DSH_PROXY: {
    title: "The DeepSeek API proxy failed",
    guidance:
      "Check API availability, the base URL, and the configured credential before rerunning.",
  },
  DSH_SPAWN: {
    title: "DeepSeek Harness could not start",
    guidance: "Check the runner runtime and configured DSH executable or container.",
  },
  DSH_TIMEOUT: {
    title: "DeepSeek Harness timed out",
    guidance: "Increase timeout-minutes or reduce the task scope, then rerun the workflow.",
  },
};

const categoryMetadata: Readonly<Record<ActionErrorCategory, { title: string; guidance: string }>> =
  {
    configuration: {
      title: "Action configuration is invalid",
      guidance: "Check the workflow inputs and required secrets.",
    },
    policy: {
      title: "The requested operation was denied",
      guidance: "Review the effective trust policy, permissions, and requested capabilities.",
    },
    domain: {
      title: "The requested operation could not be completed",
      guidance: "Inspect the workflow run and correct the reported operation state.",
    },
    runtime: {
      title: "The Action runtime failed",
      guidance: "Inspect the workflow run, correct the reported runtime condition, and retry.",
    },
  };

const unexpectedRuntimeMetadata = {
  code: "ACTION_RUNTIME_FAILED",
  category: "runtime",
  title: "The Action runtime failed",
  guidance: "Inspect the workflow run, correct the reported runtime condition, and retry.",
  retryable: true,
} as const;

function classifiedFailure(
  error: ClassifiedActionError,
  phase: ActionPhase,
  presentation: { readonly title: string; readonly guidance: string },
): ActionFailure {
  return {
    code: error.code,
    category: error.category,
    phase,
    title: presentation.title,
    message: safeMessage(error),
    guidance: presentation.guidance,
    retryable: error.retryable,
  };
}

export function describeActionFailure(error: unknown, phase: ActionPhase): ActionFailure {
  if (error instanceof AgentDeadlineError) {
    return classifiedFailure(error, phase, {
      title: "Action execution timed out",
      guidance: "Increase timeout-minutes or reduce the context, task, and validation scope.",
    });
  }
  if (error instanceof AgentNoProgressError && error.cause instanceof ValidationIntegrityError) {
    return classifiedFailure(error.cause, phase, {
      title: "Validation integrity policy blocked the write",
      guidance:
        "Review the validation-definition audit, restore or strengthen weakened scripts, tests, entrypoints, or configuration, and rerun. The Agent cannot lower validation-integrity; only trusted workflow configuration can change the policy.",
    });
  }
  if (error instanceof AgentNoProgressError || error instanceof AgentLoopLimitError) {
    return classifiedFailure(error, phase, {
      title:
        error instanceof AgentNoProgressError
          ? "Agent repair loop made no progress"
          : "Agent turn limit reached",
      guidance:
        error instanceof AgentNoProgressError
          ? "Inspect the repeated validation failure and adjust the task, tools, or repository setup."
          : "Increase max-turns or reduce the task scope, then rerun.",
    });
  }
  if (error instanceof ValidationIntegrityError) {
    return classifiedFailure(error, phase, {
      title: "Validation integrity policy blocked the write",
      guidance:
        "Review the validation-definition audit, restore or strengthen weakened scripts, tests, entrypoints, or configuration, and rerun. The Agent cannot lower validation-integrity; only trusted workflow configuration can change the policy.",
    });
  }
  if (error instanceof ValidationFailureError) {
    return classifiedFailure(error, phase, {
      title: error.timedOut ? "Validation timed out" : "Validation did not pass",
      guidance: error.timedOut
        ? "Reduce the validation workload or split the configured commands before rerunning."
        : "Inspect the failing command in the workflow run and correct the generated change or test setup.",
    });
  }
  if (error instanceof DshError) {
    const metadata = dshFailureMetadata[error.code] ?? categoryMetadata[error.category];
    return classifiedFailure(error, phase, metadata);
  }
  if (isClassifiedActionError(error)) {
    return classifiedFailure(error, phase, categoryMetadata[error.category]);
  }
  return {
    code: unexpectedRuntimeMetadata.code,
    category: unexpectedRuntimeMetadata.category,
    phase,
    title: unexpectedRuntimeMetadata.title,
    message: safeMessage(error),
    guidance: unexpectedRuntimeMetadata.guidance,
    retryable: unexpectedRuntimeMetadata.retryable,
  };
}

/** Build the provisional SIGINT/SIGTERM identity without cross-bundle instanceof checks. */
export function describeCancellationFailure(phase: ActionPhase): ActionFailure {
  return {
    code: "DSH_ABORTED",
    category: "runtime",
    phase,
    title: "DeepSeek Harness was cancelled",
    message: "DSH execution was aborted",
    guidance: "Check whether a newer workflow run cancelled this one, then rerun if needed.",
    retryable: true,
  };
}

function structuredResult(
  outcome: RunOutcome,
  receipts: PublicReceiptPayload,
): Record<string, unknown> {
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
    ...(outcome.permission === undefined ? {} : { permissions: outcome.permission }),
    ...(outcome.toolPolicy === undefined ? {} : { toolPolicy: outcome.toolPolicy }),
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
            ...(receipts.controller.length === 0 ? {} : { toolReceipts: receipts.controller }),
            ...(receipts.dsh.length === 0 ? {} : { dshToolReceipts: receipts.dsh }),
            ...(receipts.truncated
              ? {
                  toolReceiptsTruncated: true,
                  toolReceiptsDroppedCount: receipts.droppedCount,
                }
              : {}),
          },
          ...(outcome.agent.extensionAudit === undefined
            ? {}
            : { extensions: outcome.agent.extensionAudit }),
        }),
    ...(outcome.publication === undefined ? {} : { publication: outcome.publication }),
    ...(outcome.validation === undefined ? {} : { validation: outcome.validation }),
    ...(Object.keys(write).length === 0 ? {} : { write }),
    ...(outcome.commentId === undefined ? {} : { commentId: outcome.commentId }),
    ...(outcome.taskOutput === undefined ? {} : { taskOutput: outcome.taskOutput }),
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  };
}

type InterleavedReceipt =
  | { readonly plane: "controller"; readonly receipt: AgentToolReceipt }
  | { readonly plane: "dsh"; readonly receipt: DshToolReceipt };

function interleavedReceipts(outcome: RunOutcome): readonly InterleavedReceipt[] {
  const controller = outcome.agent?.toolReceipts ?? [];
  const dsh = outcome.agent?.dshToolReceipts ?? [];
  const entries: InterleavedReceipt[] = [];
  for (let index = 0; index < Math.max(controller.length, dsh.length); index += 1) {
    const controllerReceipt = controller[index];
    if (controllerReceipt !== undefined) {
      entries.push({ plane: "controller", receipt: controllerReceipt });
    }
    const dshReceipt = dsh[index];
    if (dshReceipt !== undefined) entries.push({ plane: "dsh", receipt: dshReceipt });
  }
  return entries;
}

function receiptPayload(
  entries: ReturnType<typeof interleavedReceipts>,
  keep: number,
): PublicReceiptPayload {
  const controller: AgentToolReceipt[] = [];
  const dsh: DshToolReceipt[] = [];
  for (const entry of entries.slice(0, keep)) {
    if (entry.plane === "controller") controller.push(entry.receipt);
    else dsh.push(entry.receipt);
  }
  return {
    controller,
    dsh,
    truncated: keep < entries.length,
    droppedCount: entries.length - keep,
  };
}

function utf16Bytes(value: string): number {
  return value.length * 2;
}

function boundedPublicReceipts(outcome: RunOutcome): PublicReceiptPayload {
  const entries = interleavedReceipts(outcome);
  const serializedBytes = (keep: number): number => {
    const receipts = receiptPayload(entries, keep);
    return (
      utf16Bytes(JSON.stringify(receipts)) +
      utf16Bytes(JSON.stringify(structuredResult(outcome, receipts)))
    );
  };
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(middle) <= MAX_LARGE_ACTION_OUTPUT_UTF16_BYTES) low = middle;
    else high = middle - 1;
  }
  return receiptPayload(entries, low);
}

export function actionStatus(outcome: RunOutcome): ActionStatus {
  if (outcome.conclusion !== "failure") return outcome.conclusion;
  if (outcome.error?.category === "policy" || outcome.error?.code === "POLICY_DENIED") {
    return "denied";
  }
  if (outcome.error?.code === "DSH_TIMEOUT" || outcome.error?.code === "AGENT_TIMEOUT") {
    return "timed_out";
  }
  if (
    outcome.error?.code === "DSH_MALFORMED_OUTPUT" ||
    outcome.error?.code.startsWith("VALIDATION_") === true
  ) {
    return "validation_failed";
  }
  // Preserve phase-based compatibility only for otherwise-unclassified errors.
  if (outcome.error?.category === undefined && outcome.error?.phase === "validation") {
    return "validation_failed";
  }
  return "failed";
}

export function buildActionOutputs(outcome: RunOutcome): Readonly<Record<string, string | number>> {
  const receipts = boundedPublicReceipts(outcome);
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
    "task-output": outcome.taskOutput === undefined ? "" : JSON.stringify(outcome.taskOutput),
    "error-code": outcome.error?.code ?? "",
    "error-message": outcome.error?.message ?? "",
    "extension-profile-digest": outcome.agent?.extensionAudit?.digest ?? "",
    "permission-profile": outcome.permission?.profile ?? "none",
    "effective-tools": JSON.stringify(outcome.permission?.effectiveTools ?? []),
    "network-access": outcome.permission?.network ?? "none",
    "workspace-write": outcome.permission?.workspaceWrite === true ? "true" : "false",
    "trusted-extensions": JSON.stringify(outcome.permission?.trustedExtensions ?? []),
    "tool-receipts": JSON.stringify(receipts),
    "result-json": JSON.stringify(structuredResult(outcome, receipts)),
  };
}

function safeMarkdown(value: string): string {
  return sanitizeUntrustedText(stripTrackingMarkers(value));
}

const MAX_STEP_SUMMARY_AUDIT_ITEMS = 20;
const MAX_STEP_SUMMARY_AUDIT_ITEM_CHARACTERS = 256;

function safeInline(value: string): string {
  return safeMarkdown(value)
    .replaceAll("`", "'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_STEP_SUMMARY_AUDIT_ITEM_CHARACTERS);
}

function inlineCode(value: string): string {
  return `\`${safeInline(value)}\``;
}

function boundedInlineList(values: readonly string[]): string {
  if (values.length === 0) return "none";
  const shown = values.slice(0, MAX_STEP_SUMMARY_AUDIT_ITEMS).map((value) => inlineCode(value));
  const hidden = values.length - shown.length;
  return `${shown.join(", ")}${hidden === 0 ? "" : ` (+${String(hidden)} more)`}`;
}

function permissionSummaryLines(
  permission: PermissionAudit | undefined,
  toolPolicy: ToolPolicyAudit | undefined,
): readonly string[] {
  const profile = permission?.profile ?? "not resolved";
  const policyOwner =
    toolPolicy?.policyOwner === "controller"
      ? "Controller"
      : toolPolicy?.policyOwner === "dsh"
        ? "DSH"
        : "not resolved";
  const network = permission?.network ?? "none";
  const workspaceWrite = permission?.workspaceWrite === true ? "enabled" : "disabled";
  const trustedExtensions =
    permission?.trustedExtensions.map(
      (extension) =>
        `${extension.kind}:${extension.id} (network=${extension.network ? "yes" : "no"}, workspace-write=${extension.workspaceWrite ? "yes" : "no"})`,
    ) ?? [];
  const lines = [
    "",
    "### Effective Agent permissions",
    "",
    `**Profile:** ${inlineCode(profile)}`,
    `**Tool policy owner:** ${inlineCode(policyOwner)}`,
    `**Requested tools:** ${boundedInlineList(toolPolicy?.requestedTools ?? permission?.requestedTools ?? [])}`,
    toolPolicy?.policyOwner === "dsh"
      ? `**Observed tools:** ${boundedInlineList(toolPolicy.observedTools)}`
      : `**Effective tools:** ${boundedInlineList(toolPolicy?.effectiveTools ?? permission?.effectiveTools ?? [])}`,
    `**Network:** ${inlineCode(network)}`,
    `**Workspace write:** ${inlineCode(workspaceWrite)}`,
    `**Trusted extensions:** ${boundedInlineList(trustedExtensions)}`,
  ];
  const denials = toolPolicy?.deniedTools ?? permission?.deniedTools ?? [];
  if (denials.length === 0) {
    lines.push("**Denials:** none");
    return lines;
  }
  lines.push(`**Denials (${String(denials.length)}):**`);
  for (const denial of denials.slice(0, MAX_STEP_SUMMARY_AUDIT_ITEMS)) {
    lines.push(`- ${inlineCode(denial.id)} — ${inlineCode(denial.reason)}`);
  }
  if (denials.length > MAX_STEP_SUMMARY_AUDIT_ITEMS) {
    lines.push(
      `- ${String(denials.length - MAX_STEP_SUMMARY_AUDIT_ITEMS)} additional denial(s) omitted`,
    );
  }
  return lines;
}

function validationSummaryLines(validation: ValidationSummary | undefined): readonly string[] {
  if (validation === undefined) return [];
  const lines = [
    "",
    "### Validation",
    "",
    `**Status:** ${inlineCode(validation.status)}`,
    `**Commands:** ${String(validation.commandCount)}`,
  ];
  const integrity = validation.integrity;
  if (integrity === undefined) {
    lines.push("**Integrity:** not evaluated");
    return lines;
  }
  lines.push(
    `**Integrity:** mode ${inlineCode(integrity.mode)} · status ${inlineCode(integrity.status)}`,
    `**Definition changes:** ${String(integrity.changeCount)} total · ${String(integrity.dangerousChangeCount)} dangerous · ${String(integrity.controlPlaneChangeCount)} control-plane · ${String(integrity.testChangeCount)} test`,
    `**Baseline replay:** ${
      integrity.baselineReplay === undefined
        ? "not run"
        : `${inlineCode(integrity.baselineReplay.status)} (${String(integrity.baselineReplay.commandCount)} command(s))`
    }`,
  );
  return lines;
}

export function formatStepSummary(outcome: RunOutcome): string {
  const lines = [
    `**Status:** ${outcome.conclusion}`,
    `**Operation:** ${outcome.operation ?? "none"}`,
    `**Trust:** ${outcome.policy?.trust ?? "not resolved"}`,
    ...(outcome.writeStatus === undefined ? [] : [`**Write:** ${outcome.writeStatus}`]),
    `**Duration:** ${(outcome.durationMs / 1_000).toFixed(1)}s`,
    "",
    safeMarkdown(outcome.summary),
    ...permissionSummaryLines(outcome.permission, outcome.toolPolicy),
    ...validationSummaryLines(outcome.validation),
  ];
  if (outcome.error !== undefined) {
    lines.push(
      "",
      `### ${safeMarkdown(outcome.error.title)}`,
      "",
      `**Code:** \`${outcome.error.code}\` · **Category:** \`${outcome.error.category}\` · **Phase:** \`${outcome.error.phase}\``,
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
