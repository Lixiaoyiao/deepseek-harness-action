import { randomUUID } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { PROFILE_TEMPLATES } from "@deepseek-ai/dsh-app-boot";

import { resolveInstalledPluginModuleSpecifiers } from "../extensions/profile.js";
import type { NativeExtensionPlan } from "../extensions/plan.js";
import {
  CONTAINER_PACKAGE_ROOT,
  CONTAINER_PROFILE_ROOT,
  CONTAINER_WORKSPACE,
} from "./docker-policy.js";
import { DshConfigurationError, DshIsolationUnavailableError } from "./errors.js";
import type {
  DshComposition,
  DshCompositionCompatibilityOptions,
  DshCompositionIsolationMetadata,
  DshCompositionSelection,
  DshPromptToolPolicy,
  PrepareDshCompositionOptions,
  PreparedDshComposition,
} from "./composition.js";
import type { NativeToolId } from "../tools/schema.js";

const NATIVE_TEMPLATE_NAME = "headless";
const NATIVE_PROFILE_ROOT_FILENAME = "action-native-root.yml";
const NATIVE_LAUNCHER_FILENAME = "native-launcher.mjs";
const NATIVE_OBSERVATION_FILENAME = "native-observed-tools.jsonl";
const NATIVE_PROFILE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] as const;
const MAX_OBSERVATION_BYTES = 1024 * 1024;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const CONTAINER_NATIVE_LAUNCHER = `${CONTAINER_PACKAGE_ROOT}/${NATIVE_LAUNCHER_FILENAME}`;

interface NativeObservationRow {
  readonly schemaVersion: 1;
  readonly source: "ctx.tools.schemas(agent)";
  readonly observedTools: readonly string[];
}

function assertNativeProfileTemplate(): readonly string[] {
  const template = PROFILE_TEMPLATES[NATIVE_TEMPLATE_NAME];
  if (
    template?.length !== NATIVE_PROFILE_BUNDLES.length ||
    !template.every((name, index) => name === NATIVE_PROFILE_BUNDLES[index])
  ) {
    throw new DshConfigurationError(
      "Locked DSH runtime no longer exposes the audited native headless bundle composition",
    );
  }
  return template;
}

async function assertNativeProfileManifest(
  profileRoot: string,
  expectedBundles: readonly string[],
): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(join(profileRoot, "package.json"), "utf8"));
  } catch (error: unknown) {
    throw new DshConfigurationError("Native DSH headless profile manifest is invalid", {
      cause: error,
    });
  }
  const bundles =
    typeof manifest === "object" &&
    manifest !== null &&
    "dsh" in manifest &&
    typeof manifest.dsh === "object" &&
    manifest.dsh !== null &&
    "profile" in manifest.dsh &&
    typeof manifest.dsh.profile === "object" &&
    manifest.dsh.profile !== null &&
    "bundles" in manifest.dsh.profile
      ? manifest.dsh.profile.bundles
      : undefined;
  if (
    !Array.isArray(bundles) ||
    bundles.length !== expectedBundles.length ||
    !bundles.every((name, index) => name === expectedBundles[index])
  ) {
    throw new DshConfigurationError(
      "Native DSH profile bundle layers do not match the admitted official composition",
    );
  }
}

function nativeMcpEntry(
  server: NativeExtensionPlan["mcpServers"][number],
): Record<string, unknown> {
  const definition = server.definition;
  const common = {
    serverName: definition.id,
    transport: definition.transport,
    toolCallTimeoutMs: definition.toolCallTimeoutMs,
    failOnStartupError: true,
    reconnect: definition.reconnect,
  };
  const config =
    definition.transport === "stdio"
      ? {
          ...common,
          command: definition.command,
          args: definition.args,
          env: { ...definition.env, ...definition.credentialEnv },
          cwd:
            definition.cwd === undefined
              ? CONTAINER_WORKSPACE
              : `${CONTAINER_WORKSPACE}/${definition.cwd.replaceAll("\\", "/")}`,
        }
      : {
          ...common,
          url: definition.url,
          headers: { ...definition.headers, ...definition.credentialHeaders },
        };
  return {
    id: `dsh-action-native-mcp-${definition.id}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config,
  };
}

function nativePluginEntry(
  plugin: NativeExtensionPlan["plugins"][number],
  moduleSpecifiers: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> {
  return {
    id: `dsh-action-native-plugin-${plugin.definition.id}`,
    name:
      moduleSpecifiers?.[plugin.definition.id] ??
      `file:///__dsh_action_unresolved_native_plugin__/${plugin.definition.id}.mjs`,
    config: { ...plugin.definition.config, ...plugin.definition.credentialConfig },
  };
}

function nativeProfilePatch(
  plan: NativeExtensionPlan,
  moduleSpecifiers?: Readonly<Record<string, string>>,
): string {
  const entries = [
    ...plan.mcpServers.map((server) => nativeMcpEntry(server)),
    ...plan.plugins.map((plugin) => nativePluginEntry(plugin, moduleSpecifiers)),
  ];
  return entries.length === 0 ? "[]\n" : `${JSON.stringify([{ insert: entries }], undefined, 2)}\n`;
}

/** @internal Render the official native Profile; exported for frozen contract smoke coverage. */
export async function writeNativeProfile(options: {
  readonly profileRoot: string;
  readonly manifestBase: Readonly<Record<string, unknown>>;
  readonly plan: NativeExtensionPlan;
  readonly moduleSpecifiers?: Readonly<Record<string, string>>;
}): Promise<void> {
  const officialBundles = assertNativeProfileTemplate();
  const bundles = [
    ...officialBundles,
    ...options.plan.bundles.map((bundle) => bundle.definition.package),
  ];
  const baseDependencies =
    typeof options.manifestBase.dependencies === "object" &&
    options.manifestBase.dependencies !== null &&
    !Array.isArray(options.manifestBase.dependencies)
      ? (options.manifestBase.dependencies as Readonly<Record<string, unknown>>)
      : {};
  const manifest = {
    ...options.manifestBase,
    name: "dsh-profile-headless-native",
    private: true,
    dependencies: { ...baseDependencies, ...options.plan.packageDependencies },
    dsh: { profile: { bundles } },
  };
  await writeFile(
    join(options.profileRoot, "package.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
  await writeFile(
    join(options.profileRoot, "cordis.patch.yml"),
    nativeProfilePatch(options.plan, options.moduleSpecifiers),
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(join(options.profileRoot, NATIVE_PROFILE_ROOT_FILENAME), "[]\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(
    join(options.profileRoot, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await assertNativeProfileManifest(options.profileRoot, bundles);
}

async function assertFile(path: string, description: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch (error: unknown) {
    throw new DshConfigurationError(`${description} does not exist`, { cause: error });
  }
  if (!details.isFile()) throw new DshConfigurationError(`${description} is not a file`);
}

function parseObservationRow(line: string): NativeObservationRow {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error: unknown) {
    throw new DshConfigurationError("Native DSH tool observation is not valid JSON", {
      cause: error,
    });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DshConfigurationError("Native DSH tool observation must be an object");
  }
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    row.source !== "ctx.tools.schemas(agent)" ||
    !Array.isArray(row.observedTools) ||
    Object.keys(row).some(
      (key) => key !== "schemaVersion" && key !== "source" && key !== "observedTools",
    )
  ) {
    throw new DshConfigurationError("Native DSH tool observation has an invalid contract");
  }
  const names = row.observedTools;
  if (
    names.length === 0 ||
    names.length > 512 ||
    names.some((name) => typeof name !== "string" || !TOOL_NAME.test(name))
  ) {
    throw new DshConfigurationError("Native DSH tool observation has an invalid inventory");
  }
  return {
    schemaVersion: 1,
    source: "ctx.tools.schemas(agent)",
    observedTools: names as string[],
  };
}

async function collectObservedTools(path: string, offset: number): Promise<readonly string[]> {
  let details;
  try {
    details = await stat(path);
  } catch (error: unknown) {
    throw new DshConfigurationError("Native DSH tool observation file is unavailable", {
      cause: error,
    });
  }
  if (!details.isFile() || details.size < offset || details.size > MAX_OBSERVATION_BYTES) {
    throw new DshConfigurationError("Native DSH tool observation file has an invalid size");
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error: unknown) {
    throw new DshConfigurationError("Native DSH tool observation file could not be read", {
      cause: error,
    });
  }
  const appended = contents.slice(offset);
  const rows = appended
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => parseObservationRow(line));
  if (rows.length === 0) {
    throw new DshConfigurationError(
      "Native DSH runtime did not report its model-visible tool inventory",
    );
  }
  return [...new Set(rows.flatMap((row) => row.observedTools))].sort((left, right) =>
    left.localeCompare(right),
  );
}

/** Official rc.2 headless Profile/Bundle composition with Action-owned outer isolation only. */
export class NativeComposition implements DshComposition {
  public readonly id = "dsh-native-headless";
  public readonly toolPolicyOwner = "dsh";
  public readonly profileSchemaVersion = 1;
  public readonly actionManagedExtensionProfile = false;
  public readonly extensionPlanProfile = "headless-native" as const;

  public readonly assertCompatible = (options: DshCompositionCompatibilityOptions): void => {
    if (options.isolation !== "docker") {
      throw new DshIsolationUnavailableError("Native DSH composition requires Docker isolation");
    }
    if (options.extensions.profileName !== this.extensionPlanProfile) {
      throw new DshConfigurationError(
        "NativeComposition requires the definition-only headless-native extension plan",
      );
    }
  };

  public promptToolPolicy(): DshPromptToolPolicy {
    return { policyOwner: "dsh" };
  }

  public runtimeToolNames(): readonly string[] {
    // Action allowlists do not shape the DSH-owned native capability graph.
    return [];
  }

  public requiresWebSearchProxy(): boolean {
    // The official headless graph always mounts web_search. Its only credential
    // and network route remains the Controller-mediated proxy.
    return true;
  }

  public isolationMetadata(options: {
    readonly isolation: "docker" | "none";
    readonly nativeTools: readonly NativeToolId[];
    readonly extensionNetwork: boolean;
    readonly extensionsConfigured: boolean;
  }): DshCompositionIsolationMetadata {
    if (options.isolation !== "docker") {
      throw new DshIsolationUnavailableError("Native DSH composition requires Docker isolation");
    }
    return {
      repoToolsEnabled: true,
      extensionProfile: options.extensionsConfigured ? "headless-native" : "none",
      limitations: [
        "DSH owns the internal native capability graph; observed tool names are telemetry, not Controller grants.",
        ...(options.extensionNetwork
          ? [
              "A trusted native extension requested bridge networking, so the entire native worker and every DSH capability share that egress path.",
            ]
          : [
              "The worker's internal Docker network blocks ordinary external egress; DeepSeek chat and web search use the Controller credential proxy.",
            ]),
        "The configured container image is supplied by the workflow and should be pinned by digest.",
        "Native Bundle and Plugin startup code is trusted worker code; network and workspace mounts are process-level boundaries, not per-tool sandboxes.",
        "The Action still owns workspace mounts, credentials, GitHub authority, deadlines, validation, and deferred mutations.",
      ],
    };
  }

  public async prepare(options: PrepareDshCompositionOptions): Promise<PreparedDshComposition> {
    this.assertCompatible({ isolation: options.isolation, extensions: options.plan });
    if (options.plan.profileName !== this.extensionPlanProfile) {
      throw new DshConfigurationError(
        "NativeComposition requires the definition-only headless-native extension plan",
      );
    }
    if (options.manifestBase === undefined) {
      throw new DshConfigurationError("Native DSH Docker preparation requires the locked manifest");
    }
    const plan = options.plan;
    const manifestBase = options.manifestBase;
    const launcherSourcePath = join(options.assetsDirectory, NATIVE_LAUNCHER_FILENAME);
    await assertFile(launcherSourcePath, "DSH native launcher");
    const launcherDestinationPath = join(options.runtime.packageRoot, NATIVE_LAUNCHER_FILENAME);
    await copyFile(launcherSourcePath, launcherDestinationPath);

    const profileRoot = options.runtime.packageRoot;
    await writeNativeProfile({
      profileRoot,
      manifestBase,
      plan,
    });

    const anonymousIdPath = join(options.runtime.dshHome, ".anonymous-user-id");
    try {
      await writeFile(anonymousIdPath, `${randomUUID()}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "EEXIST"
      ) {
        throw error;
      }
    }

    const observationPath = join(
      options.runtime.dshHome,
      "action-state",
      NATIVE_OBSERVATION_FILENAME,
    );
    await writeFile(observationPath, "", { encoding: "utf8", flag: "a", mode: 0o600 });
    const observationOffset = (await stat(observationPath)).size;

    const prepared = {
      isolation: "docker",
      launchPlan: {
        command: "node",
        args: ["--expose-internals", CONTAINER_NATIVE_LAUNCHER, options.task],
        workdir: CONTAINER_WORKSPACE,
        mounts: [],
      },
      observedTools: {
        collect: async () => await collectObservedTools(observationPath, observationOffset),
      },
    } as const;
    if (plan.plugins.length === 0) return prepared;
    return {
      ...prepared,
      finalizeAfterInstall: async (runPreparation) => {
        const moduleSpecifiers = await runPreparation(async () =>
          resolveInstalledPluginModuleSpecifiers({
            packageRoot: options.runtime.packageRoot,
            workerProfilePath: CONTAINER_PROFILE_ROOT,
            plan,
          }),
        );
        options.runtime.verifiedPluginModuleSpecifiers = moduleSpecifiers;
        await runPreparation(async () =>
          writeNativeProfile({
            profileRoot,
            manifestBase,
            plan,
            moduleSpecifiers,
          }),
        );
        return prepared;
      },
    };
  }
}

export const NATIVE_DSH_COMPOSITION = {
  mode: "native",
  id: "dsh-native-headless",
  toolPolicyOwner: "dsh",
  create: () => new NativeComposition(),
} satisfies DshCompositionSelection<"dsh">;
