import type { EffectiveExtensionPlan } from "../extensions/plan.js";
import type { NativeToolId, ToolPolicyOwner } from "../tools/schema.js";
import type { DshRuntime } from "./runtime.js";
import type { DshOperation } from "./schema.js";

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

export interface DshBasePatchOptions {
  readonly assetsDirectory: string;
  readonly trust: "untrusted" | "trusted-read" | "trusted-write";
  readonly isolation: "docker" | "none";
}

export interface DshBasePatch {
  readonly patchPath: string;
}

export interface DshRuntimeAssetsOptions {
  readonly assetsDirectory: string;
}

export interface PrepareLocalDshCompositionOptions {
  readonly isolation: "none";
  readonly assetsDirectory: string;
  readonly runtime: DshRuntime;
  readonly nativeTools: readonly NativeToolId[];
}

export interface PrepareDockerDshCompositionOptions {
  readonly isolation: "docker";
  readonly assetsDirectory: string;
  readonly runtime: DshRuntime;
  readonly plan: EffectiveExtensionPlan;
  readonly nativeTools: readonly NativeToolId[];
  readonly workspaceWrite: boolean;
  readonly expectedOperation: DshOperation;
  readonly task: string;
  readonly manifestBase: Readonly<Record<string, unknown>>;
}

export type RunDshCompositionPreparation = <T>(prepare: () => Promise<T>) => Promise<T>;

export interface PreparedLocalDshComposition {
  readonly isolation: "none";
  readonly toolPolicyPath: string;
}

export interface PreparedDockerDshComposition {
  readonly isolation: "docker";
  readonly policyPluginPath: string;
  readonly workspacePluginPath: string;
  readonly launcherSourcePath: string;
  readonly launcherDestinationPath: string;
  readonly statePath: string;
  readonly auditPath: string;
  readonly rules: readonly DshPolicyRule[];
  finalizeAfterInstall(
    runPreparation: RunDshCompositionPreparation,
  ): Promise<PreparedDockerDshComposition>;
}

/** Prepare the DSH-owned launch configuration without choosing a user-visible run mode. */
export interface DshComposition {
  /** Stable authorization identity; distinct implementations must use distinct IDs. */
  readonly id: string;
  /** Identifies whether granted tools are Controller-effective or only DSH-observed. */
  readonly toolPolicyOwner: ToolPolicyOwner;
  readonly profileSchemaVersion: number;

  runtimeToolNames(nativeTools: readonly NativeToolId[]): readonly string[];

  prepareBasePatch(options: DshBasePatchOptions): Promise<DshBasePatch>;

  validateRuntimeAssets(options: DshRuntimeAssetsOptions): Promise<void>;

  prepareLocal(options: PrepareLocalDshCompositionOptions): Promise<PreparedLocalDshComposition>;

  prepareDocker(options: PrepareDockerDshCompositionOptions): Promise<PreparedDockerDshComposition>;
}

/** One production selection point keeps execution and audit ownership in sync. */
export interface DshCompositionSelection<TOwner extends ToolPolicyOwner = ToolPolicyOwner> {
  readonly toolPolicyOwner: TOwner;
  create(): DshComposition & { readonly toolPolicyOwner: TOwner };
}
