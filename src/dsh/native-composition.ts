import { randomUUID } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { initProfile, PROFILE_TEMPLATES } from "@deepseek-ai/dsh-app-boot";

import { CONTAINER_PACKAGE_ROOT, CONTAINER_WORKSPACE } from "./docker-policy.js";
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

const NATIVE_PROFILE_NAME = "headless";
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
  const template = PROFILE_TEMPLATES[NATIVE_PROFILE_NAME];
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

async function assertNativeProfileManifest(profileRoot: string): Promise<void> {
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
    bundles.length !== NATIVE_PROFILE_BUNDLES.length ||
    !bundles.every((name, index) => name === NATIVE_PROFILE_BUNDLES[index])
  ) {
    throw new DshConfigurationError(
      "Native DSH profile must contain only the official base and headless bundles",
    );
  }
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

  public readonly assertCompatible = (options: DshCompositionCompatibilityOptions): void => {
    if (options.isolation !== "docker") {
      throw new DshIsolationUnavailableError("Native DSH composition requires Docker isolation");
    }
    if (
      options.extensions.mcpServers.length > 0 ||
      options.extensions.bundles.length > 0 ||
      options.extensions.plugins.length > 0
    ) {
      throw new DshConfigurationError(
        "Native DSH composition does not yet support Action-managed MCP, Bundle, or Plugin configuration; use controlled mode until Codex 6",
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
  }): DshCompositionIsolationMetadata {
    if (options.isolation !== "docker") {
      throw new DshIsolationUnavailableError("Native DSH composition requires Docker isolation");
    }
    return {
      repoToolsEnabled: true,
      extensionProfile: "none",
      limitations: [
        "DSH owns the internal native capability graph; observed tool names are telemetry, not Controller grants.",
        "The worker's internal Docker network blocks ordinary external egress; DeepSeek chat and web search use the Controller credential proxy.",
        "The configured container image is supplied by the workflow and should be pinned by digest.",
        "The Action still owns workspace mounts, credentials, GitHub authority, deadlines, validation, and deferred mutations.",
      ],
    };
  }

  public async prepare(options: PrepareDshCompositionOptions): Promise<PreparedDshComposition> {
    this.assertCompatible({ isolation: options.isolation, extensions: options.plan });
    const launcherSourcePath = join(options.assetsDirectory, NATIVE_LAUNCHER_FILENAME);
    await assertFile(launcherSourcePath, "DSH native launcher");
    const launcherDestinationPath = join(options.runtime.packageRoot, NATIVE_LAUNCHER_FILENAME);
    await copyFile(launcherSourcePath, launcherDestinationPath);

    const profileRoot = join(options.runtime.dshHome, "profiles", NATIVE_PROFILE_NAME);
    initProfile(profileRoot, assertNativeProfileTemplate());
    await assertNativeProfileManifest(profileRoot);
    await writeFile(join(profileRoot, "cordis.patch.yml"), "[]\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await writeFile(join(profileRoot, NATIVE_PROFILE_ROOT_FILENAME), "[]\n", {
      encoding: "utf8",
      mode: 0o600,
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

    return {
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
    };
  }
}

export const NATIVE_DSH_COMPOSITION = {
  mode: "native",
  id: "dsh-native-headless",
  toolPolicyOwner: "dsh",
  create: () => new NativeComposition(),
} satisfies DshCompositionSelection<"dsh">;
