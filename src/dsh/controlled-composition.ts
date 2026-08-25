import { randomUUID } from "node:crypto";
import { copyFile, stat, writeFile } from "node:fs/promises";
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
import type { NativeToolId } from "../tools/schema.js";
import { DshConfigurationError } from "./errors.js";
import type {
  DshComposition,
  DshCompositionCompatibilityOptions,
  DshCompositionSelection,
  DshCompositionIsolationMetadata,
  DshPromptToolPolicy,
  PrepareDshCompositionOptions,
  PreparedDockerDshComposition,
  PreparedDshComposition,
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
  nativeTools: PrepareDshCompositionOptions["nativeTools"],
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

/** Existing github-action controlled behavior, kept byte-compatible as the default. */
export class ControlledComposition implements DshComposition {
  public readonly id = "github-action-controlled";
  public readonly toolPolicyOwner = "controller";
  public readonly profileSchemaVersion = CONTROLLED_PROFILE_SCHEMA_VERSION;
  public readonly actionManagedExtensionProfile = true;
  public readonly extensionPlanProfile = "github-action" as const;
  private validatedAssetsDirectory: string | undefined;

  public readonly assertCompatible = (options: DshCompositionCompatibilityOptions): void => {
    if (options.extensions.profileName !== this.extensionPlanProfile) {
      throw new DshConfigurationError(
        "ControlledComposition requires the github-action controlled extension plan",
      );
    }
  };

  public runtimeToolNames(
    nativeTools: Parameters<DshComposition["runtimeToolNames"]>[0],
  ): readonly string[] {
    return nativeRuntimeToolNames(nativeTools);
  }

  public promptToolPolicy(nativeTools: readonly NativeToolId[]): DshPromptToolPolicy {
    return { policyOwner: "controller", nativeTools };
  }

  public requiresWebSearchProxy(nativeTools: readonly NativeToolId[]): boolean {
    return nativeTools.includes("native.web-search");
  }

  public isolationMetadata(options: {
    readonly isolation: "docker" | "none";
    readonly nativeTools: readonly NativeToolId[];
    readonly extensionNetwork: boolean;
    readonly extensionsConfigured: boolean;
  }): DshCompositionIsolationMetadata {
    if (options.isolation === "none") {
      return {
        repoToolsEnabled: options.nativeTools.length > 0,
        extensionProfile: "none",
        limitations: [
          "No operating-system or container boundary surrounds the DSH process.",
          "Host-only mode is retained for v0.3 compatibility and never loads MCP, Bundle, or Plugin extensions.",
        ],
      };
    }
    return {
      repoToolsEnabled: options.nativeTools.length > 0,
      extensionProfile: "github-action",
      limitations: [
        ...(options.extensionNetwork
          ? ["Explicitly network-enabled extensions share the worker's Docker bridge egress."]
          : [
              "The worker's internal Docker network blocks ordinary external egress; host-gateway access still depends on runner firewall policy.",
            ]),
        "The configured container image is supplied by the workflow and should be pinned by digest.",
        "Third-party Bundle and Plugin startup code is trusted worker code, outside per-tool invocation guards.",
        "Same-process Plugin timeouts are cooperative; the overall controller deadline hard-stops the worker.",
      ],
    };
  }

  private async prepareBasePatch(options: {
    readonly assetsDirectory: string;
    readonly trust: "untrusted" | "trusted-read" | "trusted-write";
    readonly isolation: "docker" | "none";
  }): Promise<string> {
    const patchName =
      options.trust === "trusted-write"
        ? "trusted-write.patch.yml"
        : options.trust === "trusted-read" && options.isolation === "docker"
          ? "trusted-read.patch.yml"
          : "strict-untrusted.patch.yml";
    const patchPath = join(options.assetsDirectory, patchName);
    await assertFile(patchPath, "DSH patch profile");
    return patchPath;
  }

  private async validateRuntimeAssets(options: {
    readonly assetsDirectory: string;
  }): Promise<void> {
    const assets = controlledAssets(options.assetsDirectory);
    await Promise.all([
      assertFile(assets.policyPluginPath, "DSH Action policy plugin"),
      assertFile(assets.workspacePluginPath, "DSH Action workspace plugin"),
      assertFile(assets.launcherPath, "DSH Action launcher"),
    ]);
    this.validatedAssetsDirectory = options.assetsDirectory;
  }

  public async prepare(options: PrepareDshCompositionOptions): Promise<PreparedDshComposition> {
    this.assertCompatible({ isolation: options.isolation, extensions: options.plan });
    if (options.plan.profileName !== this.extensionPlanProfile) {
      throw new DshConfigurationError(
        "ControlledComposition requires the github-action controlled extension plan",
      );
    }
    if (this.validatedAssetsDirectory !== options.assetsDirectory) {
      await this.validateRuntimeAssets({ assetsDirectory: options.assetsDirectory });
    }
    const patchPath = await this.prepareBasePatch({
      assetsDirectory: options.assetsDirectory,
      trust: options.trust,
      isolation: options.isolation,
    });
    if (options.isolation === "docker") {
      if (options.manifestBase === undefined) {
        throw new DshConfigurationError(
          "Controlled Docker composition requires a runtime manifest",
        );
      }
      return await this.prepareDockerProfile(
        { ...options, manifestBase: options.manifestBase },
        options.runtime.verifiedPluginModuleSpecifiers,
      );
    }
    if (options.dshExecutableIdentity === undefined) {
      throw new DshConfigurationError("Controlled host composition requires a DSH executable");
    }
    const toolPolicyPath = await writeToolPolicy(options.runtime, options.nativeTools);
    return {
      isolation: "none",
      launchPlan: {
        command: process.execPath,
        args: [
          "--expose-internals",
          options.dshExecutableIdentity,
          "--profile",
          "headless",
          "--patch",
          patchPath,
          "--patch",
          toolPolicyPath,
          options.task,
        ],
        cwd: options.workspacePath,
      },
    };
  }

  private async prepareDockerProfile(
    options: PrepareDshCompositionOptions & {
      readonly manifestBase: Readonly<Record<string, unknown>>;
    },
    pluginModuleSpecifiers: Readonly<Record<string, string>> | undefined,
  ): Promise<PreparedDockerDshComposition> {
    if (options.plan.profileName !== this.extensionPlanProfile) {
      throw new DshConfigurationError(
        "ControlledComposition requires the github-action controlled extension plan",
      );
    }
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
    const launcherDestinationPath = join(profile.profileDir, basename(CONTAINER_LAUNCHER));
    await copyFile(assets.launcherPath, launcherDestinationPath);
    const prepared: PreparedDockerDshComposition = {
      isolation: "docker",
      launchPlan: {
        command: "node",
        args: ["--expose-internals", CONTAINER_LAUNCHER, options.task],
        workdir: "/tmp",
        mounts: [
          {
            sourcePath: options.runtime.packageRoot,
            destinationPath: CONTAINER_PROFILE_ROOT,
            readOnly: true,
          },
          {
            sourcePath: assets.policyPluginPath,
            destinationPath: CONTAINER_POLICY_PLUGIN,
            readOnly: true,
          },
          {
            sourcePath: assets.workspacePluginPath,
            destinationPath: CONTAINER_WORKSPACE_PLUGIN,
            readOnly: true,
          },
        ],
      },
      receipts: {
        statePath: profile.statePath,
        auditPath: profile.auditPath,
        rules: profile.rules,
      },
      ...(needsPostInstallPreparation
        ? {
            finalizeAfterInstall: async (runPreparation: RunDshCompositionPreparation) =>
              await this.finalizeInstalledPlugins(options, runPreparation),
          }
        : {}),
    };
    return prepared;
  }

  private async finalizeInstalledPlugins(
    options: PrepareDshCompositionOptions & {
      readonly manifestBase: Readonly<Record<string, unknown>>;
    },
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

/** The sole production selection. Adding another owner requires an explicit audit path. */
export const PRODUCTION_DSH_COMPOSITION = {
  mode: "controlled",
  id: "github-action-controlled",
  toolPolicyOwner: "controller",
  create: () => new ControlledComposition(),
} satisfies DshCompositionSelection<"controller">;
