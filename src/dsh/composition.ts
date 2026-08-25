import type { EffectiveExtensionPlan } from "../extensions/plan.js";
import type { NativeToolId, ToolPolicyOwner } from "../tools/schema.js";
import type { DshRuntime } from "./runtime.js";
import type { DshOperation } from "./schema.js";

export type DshMode = "controlled" | "native";

export interface DshPolicyRule {
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: "builtin" | "mcp" | "plugin";
  readonly groupId: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCalls: number;
  readonly groupMaxCalls: number;
}

export type DshPromptToolPolicy =
  | {
      readonly policyOwner: "controller";
      readonly nativeTools: readonly NativeToolId[];
    }
  | {
      readonly policyOwner: "dsh";
    };

export interface DshCompositionCompatibilityOptions {
  readonly isolation: "docker" | "none";
  readonly extensions: EffectiveExtensionPlan;
}

export interface DshCompositionIsolationMetadata {
  readonly repoToolsEnabled: boolean;
  readonly extensionProfile: "github-action" | "none";
  readonly limitations: readonly string[];
}

export interface PrepareDshCompositionOptions {
  readonly isolation: "docker" | "none";
  readonly assetsDirectory: string;
  readonly runtime: DshRuntime;
  readonly plan: EffectiveExtensionPlan;
  readonly nativeTools: readonly NativeToolId[];
  readonly trust: "untrusted" | "trusted-read" | "trusted-write";
  readonly workspaceWrite: boolean;
  readonly expectedOperation: DshOperation;
  readonly task: string;
  readonly workspacePath: string;
  readonly manifestBase?: Readonly<Record<string, unknown>>;
  readonly dshExecutableIdentity?: string;
}

export interface DshDockerMount {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly readOnly: boolean;
}

export interface DshLocalLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface DshDockerLaunchPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly workdir: string;
  readonly mounts: readonly DshDockerMount[];
}

export interface DshReceiptPlan {
  readonly statePath: string;
  readonly auditPath: string;
  readonly rules: readonly DshPolicyRule[];
}

export interface DshObservedToolPlan {
  /** Read model-visible names observed from the actual DSH Agent scope. */
  collect(): Promise<readonly string[]>;
}

export type RunDshCompositionPreparation = <T>(prepare: () => Promise<T>) => Promise<T>;

export interface PreparedLocalDshComposition {
  readonly isolation: "none";
  readonly launchPlan: DshLocalLaunchPlan;
}

export interface PreparedDockerDshComposition {
  readonly isolation: "docker";
  readonly launchPlan: DshDockerLaunchPlan;
  readonly receipts?: DshReceiptPlan;
  readonly observedTools?: DshObservedToolPlan;
  finalizeAfterInstall?(
    runPreparation: RunDshCompositionPreparation,
  ): Promise<PreparedDockerDshComposition>;
}

export type PreparedDshComposition = PreparedLocalDshComposition | PreparedDockerDshComposition;

/** Prepare one DSH-owned launch plan; the shared runner owns only outer isolation. */
export interface DshComposition {
  /** Stable authorization identity; distinct implementations must use distinct IDs. */
  readonly id: string;
  /** Whether tool inventory is a Controller grant or DSH runtime observation. */
  readonly toolPolicyOwner: ToolPolicyOwner;
  /** Binds reuse to this exact composition contract. */
  readonly profileSchemaVersion: number;
  readonly actionManagedExtensionProfile: boolean;

  readonly assertCompatible?: (options: DshCompositionCompatibilityOptions) => void;

  promptToolPolicy(nativeTools: readonly NativeToolId[]): DshPromptToolPolicy;

  /** Controller inputs that materially change this composition's runtime graph. */
  runtimeToolNames(nativeTools: readonly NativeToolId[]): readonly string[];

  /** Whether this composition needs the Controller-mediated DSH web-search route. */
  requiresWebSearchProxy(nativeTools: readonly NativeToolId[]): boolean;

  isolationMetadata(options: {
    readonly isolation: "docker" | "none";
    readonly nativeTools: readonly NativeToolId[];
    readonly extensionNetwork: boolean;
  }): DshCompositionIsolationMetadata;

  prepare(options: PrepareDshCompositionOptions): Promise<PreparedDshComposition>;
}

/** One production selection point keeps execution and audit ownership in sync. */
export interface DshCompositionSelection<TOwner extends ToolPolicyOwner = ToolPolicyOwner> {
  readonly mode: DshMode;
  readonly id: string;
  readonly toolPolicyOwner: TOwner;
  create(): DshComposition & { readonly toolPolicyOwner: TOwner };
}
