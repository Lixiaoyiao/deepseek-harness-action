import type { ModelUsage } from "./usage.js";
import type { AgentToolManifest } from "../agent/contracts.js";
import type { AnyExtensionAudit, ExtensionPlan } from "../extensions/plan.js";
import type { NativeToolId } from "../tools/schema.js";
import type { DshComposition } from "./composition.js";
import type { DshProcessLimits, DshProcessResult, DshProcessSpec } from "./process.js";
import type { DeepSeekProxyHandle, DeepSeekProxyOptions } from "./proxy.js";
import type { DshToolReceipt } from "./receipts.js";
import type { DshRuntime } from "./runtime.js";
import type { DshOperation, DshOutput } from "./schema.js";
import type { TaskOutputSchema } from "./task-output.js";

export type DshTrust = "untrusted" | "trusted-read" | "trusted-write";
export type DshIsolation = "docker" | "none";

export interface DshRunRequest {
  readonly operation: DshOperation;
  readonly prompt: string;
  readonly trustedInstructions?: string;
  readonly workspacePath?: string;
  readonly trust: DshTrust;
  readonly isolation: DshIsolation;
  /** Immutable controller-wide absolute deadline. Direct callers may omit it. */
  readonly deadlineMs?: number;
  /** Agent execution cap, applied after setup and still bounded by deadlineMs. */
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Controller-only credential. It is never put in a worker env or argv. */
  readonly apiKey: string;
  /** Other Controller-only credentials to reject from every worker channel. */
  readonly controllerCredentials?: readonly string[];
  readonly baseUrl: string;
  readonly webSearchBaseUrl: string;
  readonly dshVersion: string;
  /** Absolute path to @deepseek-ai/dsh/lib/bin.js for isolation=none. */
  readonly dshExecutable?: string;
  readonly containerImage: string;
  readonly toolCatalog?: readonly AgentToolManifest[];
  /** Controller-resolved outer capability inputs; not native DSH inventory. */
  readonly nativeTools?: readonly NativeToolId[];
  /** Trusted maintainer schema. It affects task result validation only. */
  readonly taskOutputSchema?: TaskOutputSchema;
  readonly extensions?: ExtensionPlan;
  readonly signal?: AbortSignal;
}

export interface DshIsolationReport {
  readonly backend: DshIsolation;
  readonly credentialMediated: true;
  readonly repoToolsEnabled: boolean;
  readonly processIsolated: boolean;
  readonly networkIsolated: boolean;
  readonly workspaceAccess: "read-only" | "read-write";
  readonly extensionProfile: "github-action" | "headless-native" | "none";
  readonly extensionDigest?: string;
  readonly limitations: readonly string[];
}

export interface DshRunResult {
  /** Informational worker report; never an authority or billing input. */
  readonly usage?: ModelUsage;
  readonly output: DshOutput;
  readonly rawStdout?: string;
  readonly durationMs: number;
  readonly isolationReport: DshIsolationReport;
  readonly extensionAudit?: AnyExtensionAudit;
  readonly toolReceipts?: readonly DshToolReceipt[];
  /** DSH-owned model-visible inventory observed from the actual Agent scope. */
  readonly observedTools?: readonly string[];
}

export interface DshRunDependencies {
  readonly executeProcess?: (
    spec: DshProcessSpec,
    limits: DshProcessLimits,
  ) => Promise<DshProcessResult>;
  readonly startProxy?: (options: DeepSeekProxyOptions) => Promise<DeepSeekProxyHandle>;
  readonly environment?: NodeJS.ProcessEnv;
  readonly assetsDirectory?: string;
  readonly temporaryDirectory?: string;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly runtime?: DshRuntime;
  /** Internal composition seam. The Action default remains ControlledComposition. */
  readonly composition?: DshComposition;
  readonly warning?: (message: string) => void;
  /** Test seam for the single tool-free result formatting request. */
  readonly resultRepairFetch?: typeof fetch;
}
