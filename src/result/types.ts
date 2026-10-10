import type { ModelUsage } from "../dsh/usage.js";
import type { Operation } from "../commands/parse.js";
import type { AgentToolReceipt } from "../agent/loop.js";
import type { ActionErrorCategory } from "../errors.js";
import type { DshIsolationReport, DshToolReceipt } from "../dsh/runner.js";
import type { AnyExtensionAudit } from "../extensions/plan.js";
import type { PermissionAudit, ToolPolicyAudit } from "../permissions/profile.js";
import type { DshMode } from "../dsh/composition.js";
import type { PublicationResult } from "../review/publisher.js";
import type { SecurityPolicy } from "../security/policy.js";
import type { AuthorityAudit } from "../security/authority.js";
import type { ValidationIntegritySummary } from "../write/validation-integrity.js";
import type { GitHubRequestAudit } from "../github/request-policy.js";
import type { RepositoryTextFileAudit } from "../text-files.js";

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
  readonly usage?: ModelUsage;
  readonly durationMs: number;
  readonly isolation: DshIsolationReport;
  readonly turns?: number;
  readonly toolCalls?: number;
  readonly validationRetries?: number;
  readonly toolReceipts?: readonly AgentToolReceipt[];
  readonly dshToolReceipts?: readonly DshToolReceipt[];
  readonly extensionAudit?: AnyExtensionAudit;
}

export interface ValidationSummary {
  readonly status: "passed" | "failed" | "skipped" | "not-applicable";
  readonly commandCount: number;
  readonly integrity?: ValidationIntegritySummary;
}

export interface SessionRunSummary {
  readonly mode: "auto" | "save" | "resume";
  readonly status: "preparing" | "claimed" | "restored" | "saved" | "failed" | "not_saved";
  readonly sourceRunId?: number;
  readonly selection?: "created" | "resumed";
  readonly sessionId?: string;
  readonly generation?: number;
  readonly claimArtifactId?: number;
  readonly artifactId?: number;
  readonly artifactName?: string;
  readonly payloadSha256?: string;
  readonly archiveSha256?: string;
  readonly expiresAt?: string;
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
  readonly dsh?: { readonly mode: DshMode; readonly composition: string };
  readonly authority?: AuthorityAudit;
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
  readonly githubRequests?: GitHubRequestAudit;
  readonly session?: SessionRunSummary;
  readonly textSources?: {
    readonly instruction?: RepositoryTextFileAudit;
    readonly contexts: readonly RepositoryTextFileAudit[];
  };
}
