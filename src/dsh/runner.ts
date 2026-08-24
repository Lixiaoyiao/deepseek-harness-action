import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { copyFile, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "@actions/core";

import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { settleWithin } from "../lifecycle/deadline.js";
import {
  assertNoSecretOutput,
  assertSecretAbsent,
  buildDshWorkerEnvironment,
  collectControllerSecrets,
  redactKnownSecrets,
} from "../security/env.js";
import {
  DshConfigurationError,
  DshIsolationUnavailableError,
  DshProcessError,
  DshSpawnError,
  DshTimeoutError,
} from "./errors.js";
import { DshError } from "./errors.js";
import { buildDshPrompt, DEFAULT_MAX_PROMPT_BYTES, WINDOWS_MAX_PROMPT_BYTES } from "./prompt.js";
import { startDeepSeekProxy } from "./proxy.js";
import type { DeepSeekProxyHandle, DeepSeekProxyOptions } from "./proxy.js";
import { parseDshOutput } from "./schema.js";
import type { TaskOutputSchema } from "./task-output.js";
import type { DshOperation, DshOutput } from "./schema.js";
import type { AgentToolManifest } from "../agent/contracts.js";
import {
  configuredHttpSecrets,
  configuredPluginSecrets,
  configuredStdioSecrets,
} from "../extensions/plan.js";
import type { EffectiveExtensionPlan, ExtensionAudit } from "../extensions/plan.js";
import type { NativeToolId } from "../tools/schema.js";
import { DSH_VERSION } from "../release.js";
import {
  assertContainerImageReference,
  assertPinnedContainerImage,
  dockerInstallerSpec,
  dockerWorkerSpec,
} from "./docker-policy.js";
import type {
  DshComposition,
  PreparedDockerDshComposition,
  PreparedLocalDshComposition,
} from "./composition.js";
import { ControlledComposition } from "./controlled-composition.js";
import {
  assertExtensionInstallBaseline,
  auditFreshExtensionInstallation,
  auditReusedExtensionInstallation,
  captureExtensionInstallBaseline,
  prepareLockedRuntimeFiles,
} from "./install.js";
import {
  dockerNetworkInspectSpec,
  dockerNetworkSpec,
  parseInternalNetworkGateway,
} from "./network.js";
import { executeBoundedDshProcess } from "./process.js";
import type { DshProcessLimits, DshProcessResult, DshProcessSpec } from "./process.js";
import {
  emptyInvocationCounts,
  fileSize,
  readInvocationCounts,
  readToolReceipts,
  reconcileToolAudit,
} from "./receipts.js";
import type { DshToolReceipt } from "./receipts.js";
import { bindDshRuntime, createDshRuntime, disposeDshRuntime, type DshRuntime } from "./runtime.js";
import { PHASE_TIMEOUTS, phaseTimeoutMs, runBestEffortDshCleanup } from "./timeouts.js";

export { createDshRuntime, disposeDshRuntime } from "./runtime.js";
export type { DshRuntime } from "./runtime.js";
export { executeBoundedDshProcess } from "./process.js";
export type { DshProcessLimits, DshProcessResult, DshProcessSpec } from "./process.js";
export { assertContainerImageReference, assertPinnedContainerImage } from "./docker-policy.js";
export {
  assertExtensionPackagesDoNotShadowRuntime,
  assertInstalledRuntimeInventoryUnchanged,
  installedTopLevelPackageInventory,
} from "./install.js";
export type { DshToolReceipt } from "./receipts.js";

const DSH_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u;
export const SUPPORTED_DSH_VERSIONS = [DSH_VERSION] as const;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
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
  readonly nativeTools?: readonly NativeToolId[];
  /** Trusted maintainer schema. It affects task result validation only. */
  readonly taskOutputSchema?: TaskOutputSchema;
  readonly extensions?: EffectiveExtensionPlan;
  readonly signal?: AbortSignal;
}

export interface DshIsolationReport {
  readonly backend: DshIsolation;
  readonly credentialMediated: true;
  readonly repoToolsEnabled: boolean;
  readonly processIsolated: boolean;
  readonly networkIsolated: boolean;
  readonly workspaceAccess: "read-only" | "read-write";
  readonly extensionProfile: "github-action" | "none";
  readonly extensionDigest?: string;
  readonly limitations: readonly string[];
}

export interface DshRunResult {
  readonly output: DshOutput;
  readonly rawStdout?: string;
  readonly durationMs: number;
  readonly isolationReport: DshIsolationReport;
  readonly extensionAudit?: ExtensionAudit;
  readonly toolReceipts?: readonly DshToolReceipt[];
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
}

/** Bind policy patches to DSH versions whose complete native tool surface was audited. */
export function assertSupportedDshVersion(version: string): void {
  if (!DSH_VERSION_PATTERN.test(version)) {
    throw new DshConfigurationError("dshVersion must be an exact semver, not a tag or range");
  }
  if (!(SUPPORTED_DSH_VERSIONS as readonly string[]).includes(version)) {
    throw new DshConfigurationError(
      `dshVersion ${version} has no audited dsh-action policy profile; supported: ${SUPPORTED_DSH_VERSIONS.join(", ")}`,
    );
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshConfigurationError(`${name} must be a positive integer`);
  }
}

function defaultAssetsDirectory(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  if (basename(moduleDirectory) === "dist") {
    return resolve(moduleDirectory, "..", "assets", "dsh");
  }
  if (basename(moduleDirectory) === "dsh" && basename(dirname(moduleDirectory)) === "src") {
    return resolve(moduleDirectory, "..", "..", "assets", "dsh");
  }
  throw new DshConfigurationError("Cannot locate packaged DSH assets from the action module");
}

function defaultActionRoot(): string {
  return resolve(defaultAssetsDirectory(), "..", "..");
}

const EMPTY_EXTENSION_AUDIT_DIGEST = createHash("sha256")
  .update(
    '{"entries":[],"network":false,"packageDependencies":{},"profile":"github-action","schemaVersion":1}',
    "utf8",
  )
  .digest("hex");
const EMPTY_EXTENSION_CONFIGURATION_DIGEST = createHash("sha256")
  .update(
    '{"bundles":[],"mcpServers":[],"packageDependencies":{},"plugins":[],"profile":"github-action","schemaVersion":1}',
    "utf8",
  )
  .digest("hex");

function effectiveExtensionPlan(request: DshRunRequest): EffectiveExtensionPlan {
  if (request.extensions !== undefined) return request.extensions;
  const audit: ExtensionAudit = {
    schemaVersion: 1,
    profile: "github-action",
    digest: EMPTY_EXTENSION_AUDIT_DIGEST,
    network: false,
    entries: [],
  };
  return {
    schemaVersion: 1,
    profileName: "github-action",
    digest: EMPTY_EXTENSION_AUDIT_DIGEST,
    configurationDigest: EMPTY_EXTENSION_CONFIGURATION_DIGEST,
    network: false,
    mcpServers: [],
    bundles: [],
    plugins: [],
    tools: [],
    manifests: [],
    packageDependencies: {},
    audit,
  };
}

async function assertDirectory(path: string, description: string): Promise<void> {
  let details;
  try {
    details = await stat(path);
  } catch (error: unknown) {
    throw new DshConfigurationError(`${description} does not exist`, { cause: error });
  }
  if (!details.isDirectory()) throw new DshConfigurationError(`${description} is not a directory`);
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

function resolveInstalledDshBin(): string {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve("@deepseek-ai/dsh");
    return join(dirname(entry), "bin.js");
  } catch (error: unknown) {
    throw new DshConfigurationError(
      "@deepseek-ai/dsh is not installed; set dshExecutable to its absolute lib/bin.js path",
      { cause: error },
    );
  }
}

async function resolveHostDshExecutableIdentity(
  request: DshRunRequest,
): Promise<string | undefined> {
  if (request.isolation !== "none") return undefined;
  const executable =
    request.dshExecutable === undefined || request.dshExecutable === ""
      ? resolveInstalledDshBin()
      : request.dshExecutable;
  if (!isAbsolute(executable)) {
    throw new DshConfigurationError("dshExecutable must be an absolute path to lib/bin.js");
  }
  await assertFile(executable, "dshExecutable");
  return await realpath(executable);
}

function localSpec(
  executable: string | undefined,
  workspace: string,
  patchPath: string,
  toolPolicyPath: string,
  prompt: string,
  workerEnvironment: NodeJS.ProcessEnv,
): DshProcessSpec {
  if (executable === undefined) {
    throw new DshConfigurationError("Resolved host dshExecutable identity is missing");
  }
  return {
    command: process.execPath,
    args: [
      "--expose-internals",
      executable,
      "--profile",
      "headless",
      "--patch",
      patchPath,
      "--patch",
      toolPolicyPath,
      prompt,
    ],
    cwd: workspace,
    env: workerEnvironment,
  };
}

function isolationReport(request: DshRunRequest): DshIsolationReport {
  const repoToolsEnabled = effectiveNativeTools(request).length > 0;
  const plan = effectiveExtensionPlan(request);
  if (request.isolation === "docker") {
    return {
      backend: "docker",
      credentialMediated: true,
      repoToolsEnabled,
      processIsolated: true,
      networkIsolated: !plan.network,
      workspaceAccess: workerWorkspaceWrite(request) ? "read-write" : "read-only",
      extensionProfile: "github-action",
      extensionDigest: plan.digest,
      limitations: [
        ...(plan.network
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
  return {
    backend: "none",
    credentialMediated: true,
    repoToolsEnabled,
    processIsolated: false,
    networkIsolated: false,
    workspaceAccess: workerWorkspaceWrite(request) ? "read-write" : "read-only",
    extensionProfile: "none",
    limitations: [
      "No operating-system or container boundary surrounds the DSH process.",
      "Host-only mode is retained for v0.3 compatibility and never loads MCP, Bundle, or Plugin extensions.",
    ],
  };
}

function defaultNativeTools(request: DshRunRequest): readonly NativeToolId[] {
  if (request.trust === "trusted-write") {
    return ["workspace.read", "workspace.search", "workspace.edit"];
  }
  if (request.trust === "trusted-read" && request.isolation === "docker") {
    return ["workspace.read", "workspace.search"];
  }
  return [];
}

function effectiveNativeTools(request: DshRunRequest): readonly NativeToolId[] {
  const requested = request.nativeTools ?? defaultNativeTools(request);
  if (request.trust === "untrusted") return [];
  if (request.trust === "trusted-read" && request.isolation !== "docker") return [];
  return requested.filter(
    (tool) =>
      request.isolation === "docker" &&
      (request.trust === "trusted-write" ||
        (tool !== "workspace.edit" && tool !== "native.bash" && tool !== "native.subagent")),
  );
}

function workerWorkspaceWrite(request: DshRunRequest): boolean {
  return (
    effectiveNativeTools(request).includes("workspace.edit") ||
    effectiveExtensionPlan(request).tools.some((tool) =>
      tool.permissions.includes("workspace-write"),
    )
  );
}

function controllerSecrets(
  request: DshRunRequest,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const extensionValues =
    request.extensions === undefined
      ? []
      : [
          ...request.extensions.mcpServers.flatMap((server) =>
            server.definition.transport === "stdio"
              ? configuredStdioSecrets(server.definition.args, server.definition.env)
              : configuredHttpSecrets(server.definition.url, server.definition.headers),
          ),
          ...request.extensions.plugins.flatMap((plugin) =>
            configuredPluginSecrets(plugin.definition.config),
          ),
        ];
  return [
    ...new Set([
      request.apiKey,
      ...(request.controllerCredentials ?? []),
      ...collectControllerSecrets(environment),
      ...extensionValues,
    ]),
  ].filter((secret) => secret.length >= 4);
}

function assertWorkerLaunchHasNoControllerCredentials(
  spec: DshProcessSpec,
  secrets: readonly string[],
): void {
  assertNoSecretOutput("argv", [spec.command, ...spec.args].join("\u0000"), secrets);
  assertNoSecretOutput(
    "environment",
    Object.entries(spec.env)
      .map(([name, value]) => `${name}=${value ?? ""}`)
      .join("\u0000"),
    secrets,
  );
}

async function runControllerPhase<T>(options: {
  readonly run: () => Promise<T>;
  readonly capMs: number;
  readonly deadlineMs: number;
  readonly overallTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly now: () => number;
  readonly disposeLateValue?: (value: T) => Promise<void>;
}): Promise<T> {
  throwIfCancelled(options.signal);
  const timeoutMs = phaseTimeoutMs(options.deadlineMs, options.capMs, options.now);
  if (timeoutMs <= 0) throw new DshTimeoutError(options.overallTimeoutMs);
  const pending = Promise.resolve().then(options.run);
  const disposeLate = (): void => {
    if (options.disposeLateValue === undefined) return;
    void pending.then(options.disposeLateValue).catch(() => undefined);
  };
  let result: { readonly settled: true; readonly value: T } | { readonly settled: false };
  try {
    result = await settleWithin(pending, timeoutMs, options.signal);
  } catch (error: unknown) {
    disposeLate();
    throw error;
  }
  if (!result.settled) {
    disposeLate();
    throw new DshTimeoutError(timeoutMs);
  }
  return result.value;
}

function runtimeExtensionAudit(
  request: DshRunRequest,
  extensions: EffectiveExtensionPlan,
  runtime: DshRuntime,
): ExtensionAudit | undefined {
  if (request.isolation !== "docker") return undefined;
  return runtime.installedExtensionRuntimeLock === undefined
    ? extensions.audit
    : { ...extensions.audit, runtimeLock: runtime.installedExtensionRuntimeLock };
}

/** Execute one DSH headless turn behind a controller-side credential proxy. */
export async function runDsh(
  request: DshRunRequest,
  dependencies: DshRunDependencies = {},
): Promise<DshRunResult> {
  assertSupportedDshVersion(request.dshVersion);
  assertContainerImageReference(request.containerImage);
  positiveInteger(request.timeoutMs, "timeoutMs");
  positiveInteger(request.maxOutputBytes, "maxOutputBytes");
  if (request.apiKey.trim() === "") throw new DshConfigurationError("apiKey must be non-empty");
  if (request.isolation === "none" && request.trust === "untrusted") {
    throw new DshIsolationUnavailableError("Untrusted DSH execution requires Docker isolation");
  }
  if (request.trust === "trusted-write" && request.isolation !== "docker") {
    throw new DshIsolationUnavailableError("Trusted-write DSH execution requires Docker isolation");
  }
  const extensions = effectiveExtensionPlan(request);
  if (
    request.isolation !== "docker" &&
    (extensions.mcpServers.length > 0 ||
      extensions.bundles.length > 0 ||
      extensions.plugins.length > 0)
  ) {
    throw new DshIsolationUnavailableError(
      "MCP, Bundle, and Plugin extensions require Docker isolation",
    );
  }
  if (
    request.trust === "trusted-write" ||
    extensions.mcpServers.length > 0 ||
    extensions.bundles.length > 0 ||
    extensions.plugins.length > 0
  ) {
    assertPinnedContainerImage(request.containerImage);
  }

  throwIfCancelled(request.signal);
  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const deadlineMs = request.deadlineMs ?? startedAt + request.timeoutMs;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= startedAt) {
    throw new DshTimeoutError(request.timeoutMs);
  }
  const runPhase = <T>(
    run: () => Promise<T>,
    capMs: number,
    disposeLateValue?: (value: T) => Promise<void>,
  ): Promise<T> =>
    runControllerPhase({
      run,
      capMs,
      deadlineMs,
      overallTimeoutMs: request.timeoutMs,
      now,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      ...(disposeLateValue === undefined ? {} : { disposeLateValue }),
    });
  let setupBudgetMs: number = PHASE_TIMEOUTS.setupMs;
  const runSetup = async <T>(
    run: () => Promise<T>,
    disposeLateValue?: (value: T) => Promise<void>,
  ): Promise<T> => {
    const phaseStartedAt = now();
    try {
      return await runPhase(run, setupBudgetMs, disposeLateValue);
    } finally {
      setupBudgetMs = Math.max(0, setupBudgetMs - Math.max(0, now() - phaseStartedAt));
    }
  };
  const secrets = controllerSecrets(request, environment);
  const requestedWorkspace = resolve(request.workspacePath ?? process.cwd());
  const workspace = await runSetup(async () => {
    await assertDirectory(requestedWorkspace, "workspacePath");
    return await realpath(requestedWorkspace);
  });

  const composition = dependencies.composition ?? new ControlledComposition();
  const assets = dependencies.assetsDirectory ?? defaultAssetsDirectory();
  const { patchPath } = await runSetup(async () =>
    composition.prepareBasePatch({
      assetsDirectory: assets,
      trust: request.trust,
      isolation: request.isolation,
    }),
  );

  const prompt = buildDshPrompt({
    operation: request.operation,
    prompt: request.prompt,
    ...(request.trustedInstructions === undefined
      ? {}
      : { trustedInstructions: request.trustedInstructions }),
    trust: request.trust,
    toolCatalog: request.toolCatalog ?? [],
    nativeTools: effectiveNativeTools(request),
    ...(request.taskOutputSchema === undefined
      ? {}
      : { taskOutputSchema: request.taskOutputSchema }),
    maxBytes: platform === "win32" ? WINDOWS_MAX_PROMPT_BYTES : DEFAULT_MAX_PROMPT_BYTES,
  });
  assertNoSecretOutput(
    "prompt",
    [request.prompt, request.trustedInstructions ?? "", prompt].join("\u0000"),
    secrets,
  );

  const effectiveTools = effectiveNativeTools(request);
  const webSearchEnabled = effectiveTools.includes("native.web-search");
  const dshExecutableIdentity = await runSetup(async () =>
    resolveHostDshExecutableIdentity(request),
  );
  const ownsRuntime = dependencies.runtime === undefined;
  const runtime =
    dependencies.runtime ??
    (await runPhase(
      async () => createDshRuntime(dependencies.temporaryDirectory ?? tmpdir()),
      PHASE_TIMEOUTS.runtimeCreateMs,
      disposeDshRuntime,
    ));
  let proxy: DeepSeekProxyHandle | undefined;
  let internalNetwork: string | undefined;
  let internalNetworkGateway: string | undefined;
  let preparedDockerComposition: PreparedDockerDshComposition | undefined;
  let preparedLocalComposition: PreparedLocalDshComposition | undefined;
  let turnReceipts: readonly DshToolReceipt[] = [];
  let executeForCleanup:
    ((spec: DshProcessSpec, limits: DshProcessLimits) => Promise<DshProcessResult>) | undefined;
  try {
    if (extensions.network && effectiveTools.includes("native.bash")) {
      throw new DshConfigurationError(
        "native.bash cannot share a worker with a bridge-networked extension; remove native.bash or the networked extension",
      );
    }
    bindDshRuntime(runtime, {
      compositionId: composition.id,
      dshVersion: request.dshVersion,
      containerImage: request.containerImage,
      isolation: request.isolation,
      workspacePath: workspace,
      chatBaseUrl: request.baseUrl,
      ...(webSearchEnabled ? { webSearchBaseUrl: request.webSearchBaseUrl } : {}),
      ...(dshExecutableIdentity === undefined ? {} : { dshExecutableIdentity }),
      extensionConfigurationDigest: extensions.configurationDigest,
      nativeRuntimeTools: composition.runtimeToolNames(effectiveTools),
      workspaceWrite: workerWorkspaceWrite(request),
      network: extensions.network,
      profileSchemaVersion: composition.profileSchemaVersion,
    });
    if (runtime.installedVersion !== undefined && runtime.installedVersion !== request.dshVersion) {
      throw new DshConfigurationError("A reused DSH runtime cannot change dshVersion");
    }
    if (
      runtime.installedExtensionDigest !== undefined &&
      runtime.installedExtensionDigest !== extensions.configurationDigest
    ) {
      throw new DshConfigurationError("A reused DSH runtime cannot change its extension lock");
    }
    const docker = request.isolation === "docker";
    const localDshHome = runtime.dshHome;
    const packageRoot = runtime.packageRoot;
    const execute =
      dependencies.executeProcess ??
      ((processSpec, limits) => executeBoundedDshProcess(processSpec, limits, platform));
    executeForCleanup = execute;
    const executeSetup = async (
      spec: DshProcessSpec,
      phaseCapMs: number,
    ): Promise<DshProcessResult> => {
      const timeoutMs = phaseTimeoutMs(deadlineMs, phaseCapMs, now);
      if (timeoutMs <= 0) throw new DshTimeoutError(request.timeoutMs);
      let result: DshProcessResult;
      try {
        result = await execute(spec, {
          timeoutMs,
          maxStdoutBytes: request.maxOutputBytes,
          maxStderrBytes: Math.min(request.maxOutputBytes, MAX_STDERR_BYTES),
          maxCombinedBytes: request.maxOutputBytes,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
      } catch (error: unknown) {
        if (docker && error instanceof DshSpawnError) {
          throw new DshIsolationUnavailableError("Docker could not be started", { cause: error });
        }
        throw error;
      }
      if (result.exitCode !== 0 || result.signal !== null) {
        throw new DshProcessError(
          result.exitCode,
          result.signal,
          redactKnownSecrets(result.stderr.trim(), secrets),
        );
      }
      return result;
    };

    let manifestBase: Record<string, unknown> | undefined;
    if (docker && runtime.installedVersion === undefined) {
      manifestBase = await runSetup(async () =>
        prepareLockedRuntimeFiles(runtime, request.dshVersion, defaultActionRoot()),
      );
      await executeSetup(
        dockerInstallerSpec({
          kind: "runtime",
          containerImage: request.containerImage,
          workspace,
          packageRoot,
          npmCache: runtime.npmCache,
          environment,
        }),
        PHASE_TIMEOUTS.runtimeInstallMs,
      );
      runtime.installedVersion = request.dshVersion;
      await runSetup(async () => captureExtensionInstallBaseline(runtime, extensions));
    }

    await runSetup(async () => composition.validateRuntimeAssets({ assetsDirectory: assets }));
    if (docker) {
      await runSetup(async () => rm(join(localDshHome, ".env"), { force: true }));
      manifestBase ??= await runSetup(async () => {
        const parsed = JSON.parse(
          await readFile(join(packageRoot, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        return parsed;
      });
      const profileManifest = manifestBase;
      preparedDockerComposition = await runSetup(async () =>
        composition.prepareDocker({
          isolation: "docker",
          assetsDirectory: assets,
          runtime,
          plan: extensions,
          nativeTools: effectiveTools,
          workspaceWrite: workerWorkspaceWrite(request),
          expectedOperation: request.operation,
          task: prompt,
          manifestBase: profileManifest,
        }),
      );
      if (runtime.installedExtensionDigest === undefined) {
        if (Object.keys(extensions.packageDependencies).length > 0) {
          assertExtensionInstallBaseline(runtime, extensions);
          await executeSetup(
            dockerInstallerSpec({
              kind: "extension",
              containerImage: request.containerImage,
              workspace,
              packageRoot,
              npmCache: runtime.npmCache,
              environment,
            }),
            PHASE_TIMEOUTS.extensionInstallMs,
          );
          await runSetup(async () => auditFreshExtensionInstallation(runtime, extensions));
        }
        runtime.installedExtensionDigest = extensions.configurationDigest;
      } else if (Object.keys(extensions.packageDependencies).length > 0) {
        await runSetup(async () => auditReusedExtensionInstallation(runtime, extensions));
      }
      const preparedBeforeFinalization = preparedDockerComposition;
      preparedDockerComposition = await preparedBeforeFinalization.finalizeAfterInstall(runSetup);
      // Keep the launcher inside the populated package root so its bare imports
      // resolve against the locked runtime. A separate child bind mount below
      // the read-only package bind cannot create its mountpoint under Linux runc.
      await runSetup(async () => {
        const prepared = preparedDockerComposition;
        if (prepared === undefined) {
          throw new DshConfigurationError("DSH composition was not prepared for Docker isolation");
        }
        await copyFile(prepared.launcherSourcePath, prepared.launcherDestinationPath);
      });
      if (!extensions.network) {
        internalNetwork = `dsh-action-internal-${randomUUID()}`;
        await executeSetup(
          dockerNetworkSpec("create", internalNetwork, workspace, environment),
          PHASE_TIMEOUTS.setupMs,
        );
        const inspected = await executeSetup(
          dockerNetworkInspectSpec(internalNetwork, workspace, environment),
          PHASE_TIMEOUTS.setupMs,
        );
        internalNetworkGateway = parseInternalNetworkGateway(inspected.stdout);
      }
    }

    const proxyFactory = dependencies.startProxy ?? startDeepSeekProxy;
    proxy = await runSetup(
      async () =>
        proxyFactory({
          apiKey: request.apiKey,
          baseUrl: request.baseUrl,
          ...(webSearchEnabled ? { webSearchBaseUrl: request.webSearchBaseUrl } : {}),
          allowWebSearch: webSearchEnabled,
          bindHost: docker ? "0.0.0.0" : "127.0.0.1",
          workerHost: docker ? (internalNetworkGateway ?? "host.docker.internal") : "127.0.0.1",
          requestTimeoutMs: request.timeoutMs,
          maxResponseBytes: request.maxOutputBytes,
        }),
      async (lateProxy) => lateProxy.close(),
    );
    if (webSearchEnabled && proxy.workerWebSearchBaseUrl === undefined) {
      throw new DshConfigurationError(
        "The Controller proxy did not expose the required mediated web-search route",
      );
    }
    const workerSecrets = [...secrets, proxy.workerToken];
    const workerEnvironment = buildDshWorkerEnvironment({
      source: environment,
      dshHome: localDshHome,
      permissionMode: workerWorkspaceWrite(request) ? "workspace-write" : "read-only",
      proxyBaseUrl: proxy.workerBaseUrl,
      proxyToken: proxy.workerToken,
      realDeepSeekApiKey: request.apiKey,
    });
    assertSecretAbsent(workerEnvironment, request.apiKey, "real DeepSeek API key");
    if (!docker) {
      preparedLocalComposition = await runSetup(async () =>
        composition.prepareLocal({
          isolation: "none",
          assetsDirectory: assets,
          runtime,
          nativeTools: effectiveTools,
        }),
      );
    }
    const { auditOffset, invocationCountsBefore } = await runSetup(async () => ({
      auditOffset:
        preparedDockerComposition === undefined
          ? 0
          : await fileSize(preparedDockerComposition.auditPath),
      invocationCountsBefore:
        preparedDockerComposition === undefined
          ? emptyInvocationCounts()
          : await readInvocationCounts(
              preparedDockerComposition.statePath,
              preparedDockerComposition.rules,
            ),
    }));

    let spec: DshProcessSpec;
    if (docker) {
      const prepared = preparedDockerComposition;
      if (prepared === undefined) {
        throw new DshConfigurationError("DSH composition was not prepared for Docker isolation");
      }
      spec = dockerWorkerSpec({
        containerImage: request.containerImage,
        ...(request.dshExecutable === undefined ? {} : { dshExecutable: request.dshExecutable }),
        workspace,
        dshHome: localDshHome,
        packageRoot,
        policyPluginPath: prepared.policyPluginPath,
        workspacePluginPath: prepared.workspacePluginPath,
        networkName: internalNetwork ?? "bridge",
        hostGateway: internalNetworkGateway ?? "host-gateway",
        prompt,
        environment,
        workerEnvironment,
        proxy,
        workspaceWrite: workerWorkspaceWrite(request),
      });
    } else {
      const prepared = preparedLocalComposition;
      if (prepared === undefined) {
        throw new DshConfigurationError("DSH composition was not prepared for host isolation");
      }
      spec = localSpec(
        dshExecutableIdentity,
        workspace,
        patchPath,
        prepared.toolPolicyPath,
        prompt,
        workerEnvironment,
      );
    }
    assertWorkerLaunchHasNoControllerCredentials(spec, secrets);

    const remainingMs = phaseTimeoutMs(
      deadlineMs,
      Math.min(request.timeoutMs, PHASE_TIMEOUTS.agentTurnMs),
      now,
    );
    if (remainingMs <= 0) throw new DshTimeoutError(request.timeoutMs);

    let processResult: DshProcessResult | undefined;
    let output: DshOutput | undefined;
    let executionFailure: unknown;
    try {
      processResult = await execute(spec, {
        timeoutMs: remainingMs,
        maxStdoutBytes: request.maxOutputBytes,
        maxStderrBytes: Math.min(request.maxOutputBytes, MAX_STDERR_BYTES),
        maxCombinedBytes: request.maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch (error: unknown) {
      executionFailure =
        docker && error instanceof DshSpawnError
          ? new DshIsolationUnavailableError("Docker could not be started", { cause: error })
          : error;
    }

    if (processResult !== undefined) {
      try {
        assertNoSecretOutput("stdout", processResult.stdout, workerSecrets);
        assertNoSecretOutput("stderr", processResult.stderr, workerSecrets);
        if (processResult.exitCode !== 0 || processResult.signal !== null) {
          throw new DshProcessError(
            processResult.exitCode,
            processResult.signal,
            redactKnownSecrets(processResult.stderr.trim(), workerSecrets),
          );
        }
        output = parseDshOutput(processResult.stdout, request.operation, request.taskOutputSchema);
      } catch (error: unknown) {
        executionFailure = error;
      }
    }

    if (preparedDockerComposition !== undefined) {
      const profileForAudit = preparedDockerComposition;
      try {
        turnReceipts = await runSetup(async () => {
          const receipts = await readToolReceipts(profileForAudit.auditPath, auditOffset);
          assertNoSecretOutput("tool receipt", JSON.stringify(receipts), workerSecrets);
          const countsAfter = await readInvocationCounts(
            profileForAudit.statePath,
            profileForAudit.rules,
          );
          reconcileToolAudit(
            invocationCountsBefore,
            countsAfter,
            receipts,
            executionFailure === undefined,
          );
          return receipts;
        });
      } catch (error: unknown) {
        // Auditing still runs to collect valid incomplete receipts, but a
        // malformed state file must not replace an earlier abort, credential
        // leak, process failure, or output failure.
        executionFailure ??= error;
      }
    }

    if (executionFailure !== undefined) {
      throw executionFailure instanceof Error
        ? executionFailure
        : new DshConfigurationError("DSH execution failed with a non-Error value");
    }
    if (processResult === undefined || output === undefined) {
      throw new DshConfigurationError("DSH execution produced no process result");
    }
    const extensionAudit = runtimeExtensionAudit(request, extensions, runtime);
    return {
      output,
      rawStdout: processResult.stdout,
      durationMs: Math.max(0, now() - startedAt),
      isolationReport: isolationReport(request),
      ...(extensionAudit === undefined ? {} : { extensionAudit }),
      ...(turnReceipts.length === 0 ? {} : { toolReceipts: turnReceipts }),
    };
  } catch (error: unknown) {
    if (error instanceof DshError) {
      const extensionAudit = runtimeExtensionAudit(request, extensions, runtime);
      error.attachTelemetry({
        durationMs: Math.max(0, now() - startedAt),
        isolationReport: isolationReport(request),
        ...(extensionAudit === undefined ? {} : { extensionAudit }),
        ...(turnReceipts.length === 0 ? {} : { toolReceipts: turnReceipts }),
      });
    }
    throw error;
  } finally {
    const proxyForCleanup = proxy;
    const networkForCleanup = internalNetwork;
    const cleanupExecutor = executeForCleanup;
    const cleanupTasks = [
      ...(proxyForCleanup === undefined
        ? []
        : [{ label: "proxy", run: async (): Promise<void> => proxyForCleanup.close() }]),
      ...(networkForCleanup === undefined || cleanupExecutor === undefined
        ? []
        : [
            {
              label: "Docker network",
              run: async (): Promise<void> => {
                await cleanupExecutor(
                  dockerNetworkSpec("remove", networkForCleanup, workspace, environment),
                  {
                    timeoutMs: PHASE_TIMEOUTS.cleanupMs,
                    maxStdoutBytes: 64 * 1024,
                    maxStderrBytes: 64 * 1024,
                    maxCombinedBytes: 128 * 1024,
                  },
                );
              },
            },
          ]),
      ...(ownsRuntime
        ? [
            {
              label: "runtime",
              run: async (): Promise<void> => disposeDshRuntime(runtime),
            },
          ]
        : []),
    ];
    await runBestEffortDshCleanup(
      cleanupTasks,
      PHASE_TIMEOUTS.cleanupMs,
      dependencies.warning ?? core.warning,
    );
  }
}
