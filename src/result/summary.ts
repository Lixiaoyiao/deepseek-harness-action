import type { PermissionAudit, ToolPolicyAudit } from "../permissions/profile.js";
import type { AuthorityAudit, KnownAuthoritySource } from "../security/authority.js";
import { sanitizeUntrustedText } from "../security/redaction.js";
import { stripTrackingMarkers } from "../review/tracking.js";
import type { RunOutcome, ValidationSummary } from "./types.js";

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
  const toolLines =
    toolPolicy?.policyOwner === "dsh"
      ? [`**Observed tools:** ${boundedInlineList(toolPolicy.observedTools)}`]
      : [
          `**Requested tools:** ${boundedInlineList(toolPolicy?.requestedTools ?? permission?.requestedTools ?? [])}`,
          `**Effective tools:** ${boundedInlineList(toolPolicy?.effectiveTools ?? permission?.effectiveTools ?? [])}`,
        ];
  const lines = [
    "",
    "### Effective Agent permissions",
    "",
    `**Profile:** ${inlineCode(profile)}`,
    `**Tool policy owner:** ${inlineCode(policyOwner)}`,
    ...toolLines,
    `**Network:** ${inlineCode(network)}`,
    `**Workspace write:** ${inlineCode(workspaceWrite)}`,
    `**Trusted extensions:** ${boundedInlineList(trustedExtensions)}`,
  ];
  const dshOwnedPolicy = toolPolicy?.policyOwner === "dsh";
  const denials = dshOwnedPolicy
    ? (permission?.deniedTools ?? [])
    : (toolPolicy?.deniedTools ?? permission?.deniedTools ?? []);
  const denialLabel = dshOwnedPolicy ? "Controller boundary denials" : "Denials";
  if (denials.length === 0) {
    lines.push(`**${denialLabel}:** none`);
    return lines;
  }
  lines.push(`**${denialLabel} (${String(denials.length)}):**`);
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

function authoritySourceLabel(source: KnownAuthoritySource): string {
  if (source.kind === "extension-credential") {
    return `${source.extensionKind}:${source.extensionId} (explicit credential configured)`;
  }
  if (source.service === "github") {
    return "controller:github (credential not exposed to worker)";
  }
  return "controller:deepseek (run-scoped proxy mediation)";
}

function authoritySummaryLines(authority: AuthorityAudit | undefined): readonly string[] {
  if (authority === undefined) return [];
  return [
    "",
    "### Known authority sources",
    "",
    `**Scope:** ${inlineCode(authority.scope)}`,
    `**Known sources:** ${boundedInlineList(authority.knownSources.map(authoritySourceLabel))}`,
    "- Records only sources the Action knows, configures, or mediates; this does not prove the worker has no other authority.",
    "- Trusted extension code may also use granted network access, runner ambient state, or other process capabilities.",
  ];
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
    `**DSH mode:** ${outcome.dsh?.mode ?? "none"}`,
    `**DSH composition:** ${outcome.dsh?.composition ?? "none"}`,
    ...(outcome.writeStatus === undefined ? [] : [`**Write:** ${outcome.writeStatus}`]),
    `**Duration:** ${(outcome.durationMs / 1_000).toFixed(1)}s`,
    "",
    safeMarkdown(outcome.summary),
    ...permissionSummaryLines(outcome.permission, outcome.toolPolicy),
    ...authoritySummaryLines(outcome.authority),
    ...validationSummaryLines(outcome.validation),
  ];
  const usage = outcome.agent?.usage;
  if (usage !== undefined) {
    const tokens = usage.tokens;
    const buckets =
      tokens === undefined
        ? ["token counts unknown"]
        : [
            `uncached input ${String(tokens.inputTokens)}`,
            `output ${String(tokens.outputTokens)}`,
            ...(tokens.cacheReadTokens === undefined
              ? []
              : [`cache read ${String(tokens.cacheReadTokens)}`]),
            ...(tokens.cacheWriteTokens === undefined
              ? []
              : [`cache write ${String(tokens.cacheWriteTokens)}`]),
            ...(tokens.reasoningTokens === undefined
              ? []
              : [`reasoning (within output) ${String(tokens.reasoningTokens)}`]),
          ];
    lines.push(
      "",
      `**Model usage (worker reported):** ${usage.completeness}; ${String(usage.reportedSteps)}/${String(usage.observedSteps)} steps; ${buckets.join("; ")}.`,
    );
  }
  if (outcome.githubRequests !== undefined) {
    const audit = outcome.githubRequests;
    lines.push(
      "",
      `**GitHub requests (production Action main client; lifecycle comments use a separate client):** ${String(audit.requests)}; immutable cache hits ${String(audit.cacheHits)}; merged reads ${String(audit.coalesced)}; retries ${String(audit.retries)}; quota wait ${String(audit.waitMs)}ms.`,
      ...(audit.resetAt === undefined ? [] : [`**Quota recovery:** ${audit.resetAt}`]),
    );
  }
  if (outcome.session !== undefined) {
    const session = outcome.session;
    lines.push(
      "",
      `**Session:** ${inlineCode(session.mode)} / ${inlineCode(session.status)}${session.generation === undefined ? "" : `; generation ${String(session.generation)}`}. Current authority was recalculated; historical GitHub writes were not replayed.`,
    );
    if (session.sourceRunId !== undefined)
      lines.push(`**Session source run:** ${String(session.sourceRunId)}`);
    if (session.selection !== undefined)
      lines.push(`**Session selection:** ${inlineCode(session.selection)}.`);
    lines.push(
      "Session artifact SDK uploads use a separate job-scoped credential; SDK transport requests are not included in the GitHub client counters.",
    );
    if (session.artifactName !== undefined)
      lines.push(
        `**Session checkpoint:** ${inlineCode(session.artifactName)}${session.expiresAt === undefined ? "" : `; expires ${session.expiresAt}`}.`,
      );
  }
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
