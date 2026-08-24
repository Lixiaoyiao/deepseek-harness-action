import { randomUUID } from "node:crypto";
import { stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  nativeRuntimeToolNames,
  prepareControlledProfile,
  resolveInstalledPluginModuleSpecifiers,
} from "../extensions/profile.js";
import {
  CONTAINER_AUDIT,
  CONTAINER_LAUNCHER,
  CONTAINER_POLICY_PLUGIN,
  CONTAINER_PROFILE_ROOT,
  CONTAINER_STATE,
  CONTAINER_WORKSPACE,
  CONTAINER_WORKSPACE_PLUGIN,
} from "./docker-policy.js";
import { DshConfigurationError } from "./errors.js";
import type {
  DshBasePatch,
  DshBasePatchOptions,
  DshComposition,
  DshRuntimeAssetsOptions,
  PrepareDockerDshCompositionOptions,
  PreparedDockerDshComposition,
  PrepareLocalDshCompositionOptions,
  PreparedLocalDshComposition,
  RunDshCompositionPreparation,
} from "./composition.js";
import type { DshRuntime } from "./runtime.js";

const CONTROLLED_PROFILE_SCHEMA_VERSION = 1;

async function assertFile(path: string, description: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch (error: unknown) {
    throw new DshConfigurationError(`${description} does not exist`, { cause: error });
  }
  if (!details.isFile()) throw new DshConfigurationError(`${description} is not a file`);
}

async function writeToolPolicy(
  runtime: DshRuntime,
  nativeTools: PrepareLocalDshCompositionOptions["nativeTools"],
): Promise<string> {
  const enabled = new Set(nativeTools);
  const rows: string[] = [];
  for (const [tool, row] of [
    ["workspace.read", "tool-fs"],
    ["workspace.search", "tool-fs-search"],
    ["workspace.edit", "tool-str-replace-editor"],
  ] as const) {
    if (!enabled.has(tool)) rows.push(`- id: ${row}\n  disabled: true`);
  }
  const path = join(runtime.root, `tool-policy-${randomUUID()}.patch.yml`);
  await writeFile(path, rows.length === 0 ? "[]\n" : `${rows.join("\n\n")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
}

function controlledAssets(assetsDirectory: string): {
  readonly policyPluginPath: string;
  readonly workspacePluginPath: string;
  readonly launcherPath: string;
} {
  return {
    policyPluginPath: join(assetsDirectory, "action-policy.mjs"),
    workspacePluginPath: join(assetsDirectory, "action-workspace.mjs"),
    launcherPath: join(assetsDirectory, "action-launcher.mjs"),
  };
}

/** The sole current DSH composition: the existing github-action controlled behavior. */
export class ControlledComposition implements DshComposition {
  public readonly id = "github-action-controlled";
  public readonly profileSchemaVersion = CONTROLLED_PROFILE_SCHEMA_VERSION;
  private validatedAssetsDirectory: string | undefined;

  public runtimeToolNames(
    nativeTools: Parameters<DshComposition["runtimeToolNames"]>[0],
  ): readonly string[] {
    return nativeRuntimeToolNames(nativeTools);
  }

  public async prepareBasePatch(options: DshBasePatchOptions): Promise<DshBasePatch> {
    const patchName =
      options.trust === "trusted-write"
        ? "trusted-write.patch.yml"
        : options.trust === "trusted-read" && options.isolation === "docker"
          ? "trusted-read.patch.yml"
          : "strict-untrusted.patch.yml";
    const patchPath = join(options.assetsDirectory, patchName);
    await assertFile(patchPath, "DSH patch profile");
    return { patchPath };
  }

  public async validateRuntimeAssets(options: DshRuntimeAssetsOptions): Promise<void> {
    const assets = controlledAssets(options.assetsDirectory);
    await Promise.all([
      assertFile(assets.policyPluginPath, "DSH Action policy plugin"),
      assertFile(assets.workspacePluginPath, "DSH Action workspace plugin"),
      assertFile(assets.launcherPath, "DSH Action launcher"),
    ]);
    this.validatedAssetsDirectory = options.assetsDirectory;
  }

  public async prepareLocal(
    options: PrepareLocalDshCompositionOptions,
  ): Promise<PreparedLocalDshComposition> {
    if (this.validatedAssetsDirectory !== options.assetsDirectory) {
      await this.validateRuntimeAssets({ assetsDirectory: options.assetsDirectory });
    }
    return {
      isolation: "none",
      toolPolicyPath: await writeToolPolicy(options.runtime, options.nativeTools),
    };
  }

  public async prepareDocker(
    options: PrepareDockerDshCompositionOptions,
  ): Promise<PreparedDockerDshComposition> {
    if (this.validatedAssetsDirectory !== options.assetsDirectory) {
      await this.validateRuntimeAssets({ assetsDirectory: options.assetsDirectory });
    }
    return await this.prepareDockerProfile(options, options.runtime.verifiedPluginModuleSpecifiers);
  }

  private async prepareDockerProfile(
    options: PrepareDockerDshCompositionOptions,
    pluginModuleSpecifiers: Readonly<Record<string, string>> | undefined,
  ): Promise<PreparedDockerDshComposition> {
    const assets = controlledAssets(options.assetsDirectory);
    const profile = await prepareControlledProfile({
      dshHome: options.runtime.dshHome,
      plan: options.plan,
      nativeTools: options.nativeTools,
      workspaceWrite: options.workspaceWrite,
      expectedOperation: options.expectedOperation,
      task: options.task,
      workerWorkspacePath: CONTAINER_WORKSPACE,
      policyPluginPath: CONTAINER_POLICY_PLUGIN,
      workspacePluginPath: CONTAINER_WORKSPACE_PLUGIN,
      workerStatePath: CONTAINER_STATE,
      workerAuditPath: CONTAINER_AUDIT,
      manifestBase: options.manifestBase,
      ...(pluginModuleSpecifiers === undefined ? {} : { pluginModuleSpecifiers }),
    });
    if (resolve(profile.profileDir) !== resolve(options.runtime.packageRoot)) {
      throw new DshConfigurationError(
        "Controlled Profile and extension installation must share one package root",
      );
    }
    const needsPostInstallPreparation =
      options.plan.plugins.length > 0 && pluginModuleSpecifiers === undefined;
    const prepared: PreparedDockerDshComposition = {
      isolation: "docker",
      policyPluginPath: assets.policyPluginPath,
      workspacePluginPath: assets.workspacePluginPath,
      launcherSourcePath: assets.launcherPath,
      launcherDestinationPath: join(profile.profileDir, basename(CONTAINER_LAUNCHER)),
      statePath: profile.statePath,
      auditPath: profile.auditPath,
      rules: profile.rules,
      finalizeAfterInstall: async (runPreparation) => {
        if (!needsPostInstallPreparation) return prepared;
        return await this.finalizeInstalledPlugins(options, runPreparation);
      },
    };
    return prepared;
  }

  private async finalizeInstalledPlugins(
    options: PrepareDockerDshCompositionOptions,
    runPreparation: RunDshCompositionPreparation,
  ): Promise<PreparedDockerDshComposition> {
    let pluginModuleSpecifiers: Readonly<Record<string, string>>;
    try {
      pluginModuleSpecifiers = await runPreparation(async () =>
        resolveInstalledPluginModuleSpecifiers({
          packageRoot: options.runtime.packageRoot,
          workerProfilePath: CONTAINER_PROFILE_ROOT,
          plan: options.plan,
        }),
      );
    } catch (error: unknown) {
      throw new DshConfigurationError(
        "Installed direct Plugin entry failed Controller containment validation",
        { cause: error },
      );
    }
    options.runtime.verifiedPluginModuleSpecifiers = pluginModuleSpecifiers;
    return await runPreparation(async () =>
      this.prepareDockerProfile(options, pluginModuleSpecifiers),
    );
  }
}
