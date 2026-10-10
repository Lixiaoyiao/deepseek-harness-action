import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { prepareWorkerSession } from "../session/worker.js";
import { buildChildEnvironment } from "../security/argv.js";
import { DSH_WORKER_ENV_ALLOWLIST, redactKnownSecrets } from "../security/env.js";
import type { PreparedDshComposition } from "./composition.js";
import { readDshManifest } from "./composition-files.js";
import { dockerControllerEnvironment, dockerInstallerSpec } from "./docker-policy.js";
import {
  DshConfigurationError,
  DshIsolationUnavailableError,
  DshProcessError,
  DshSpawnError,
} from "./errors.js";
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
import type { DshProcessLimits, DshProcessResult, DshProcessSpec } from "./process.js";
import type { DshRunContext } from "./runner-context.js";
import type { DshRunScope } from "./run-scope.js";
import { bindDshRuntime, type DshRuntime } from "./runtime.js";
import { PHASE_TIMEOUTS, type BestEffortCleanupTask } from "./timeouts.js";

export type DshProcessExecutor = (
  spec: DshProcessSpec,
  limits: DshProcessLimits,
) => Promise<DshProcessResult>;

export interface PreparedWorkerRuntime {
  readonly composition: PreparedDshComposition;
  readonly network?: { readonly name: string; readonly gateway: string };
}

async function bindRuntime(
  context: DshRunContext,
  runtime: DshRuntime,
  scope: DshRunScope,
): Promise<void> {
  const { request, extensions, composition } = context;
  if (runtime.session !== undefined && request.isolation !== "docker") {
    throw new DshConfigurationError("Portable Session requires Docker's fixed worker workspace");
  }
  await scope.setup(async () => prepareWorkerSession(runtime, context.workspaceWrite));
  bindDshRuntime(runtime, {
    compositionId: composition.id,
    dshVersion: request.dshVersion,
    containerImage: request.containerImage,
    isolation: request.isolation,
    workspacePath: context.workspace,
    chatBaseUrl: request.baseUrl,
    webSearchProxy: context.webSearchEnabled,
    ...(context.webSearchEnabled ? { webSearchBaseUrl: request.webSearchBaseUrl } : {}),
    ...(context.dshExecutableIdentity === undefined
      ? {}
      : { dshExecutableIdentity: context.dshExecutableIdentity }),
    extensionConfigurationDigest: extensions.configurationDigest,
    nativeRuntimeTools: composition.runtimeToolNames(context.nativeTools),
    workspaceWrite: context.workspaceWrite,
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
}

function assertSuccessfulProcess(result: DshProcessResult, secrets: readonly string[]): void {
  if (result.exitCode !== 0 || result.signal !== null) {
    throw new DshProcessError(
      result.exitCode,
      result.signal,
      redactKnownSecrets(result.stderr.trim(), secrets),
    );
  }
}

/** The install process has only package acquisition authority; its outputs never become instructions. */
function setupExecutor(context: DshRunContext, scope: DshRunScope, execute: DshProcessExecutor) {
  return async (
    spec: DshProcessSpec,
    capMs: number,
    cleanup?: BestEffortCleanupTask,
  ): Promise<DshProcessResult> => {
    const timeoutMs = scope.remaining(capMs);
    let result: DshProcessResult;
    try {
      const run = async () =>
        execute(spec, {
          timeoutMs,
          maxStdoutBytes: context.request.maxOutputBytes,
          maxStderrBytes: Math.min(context.request.maxOutputBytes, 2 * 1024 * 1024),
          maxCombinedBytes: context.request.maxOutputBytes,
          ...(scope.signal === undefined ? {} : { signal: scope.signal }),
        });
      result =
        cleanup === undefined
          ? await scope.phase(run, capMs)
          : await scope.effect(run, capMs, cleanup);
    } catch (error: unknown) {
      if (context.request.isolation === "docker" && error instanceof DshSpawnError) {
        throw new DshIsolationUnavailableError("Docker could not be started", { cause: error });
      }
      throw error;
    }
    assertSuccessfulProcess(result, context.secrets);
    return result;
  };
}

async function prepareWorkerNetwork(
  context: DshRunContext,
  execute: DshProcessExecutor,
  executeSetup: ReturnType<typeof setupExecutor>,
): Promise<{ readonly name: string; readonly gateway: string }> {
  const name = context.extensions.network ? "bridge" : `dsh-action-internal-${randomUUID()}`;
  if (!context.extensions.network) {
    const cleanup: BestEffortCleanupTask = {
      label: "Docker network",
      // The caller may have removed its workspace before a late create settles.
      run: async () => {
        const result = await execute(
          dockerNetworkSpec("remove", name, tmpdir(), context.environment),
          {
            timeoutMs: PHASE_TIMEOUTS.cleanupMs,
            maxStdoutBytes: 64 * 1024,
            maxStderrBytes: 64 * 1024,
            maxCombinedBytes: 128 * 1024,
          },
        );
        assertSuccessfulProcess(result, context.secrets);
      },
    };
    await executeSetup(
      dockerNetworkSpec("create", name, context.workspace, context.environment),
      PHASE_TIMEOUTS.setupMs,
      cleanup,
    );
  }
  const inspected = await executeSetup(
    dockerNetworkInspectSpec(name, context.workspace, context.environment),
    PHASE_TIMEOUTS.setupMs,
  );
  return { name, gateway: parseInternalNetworkGateway(inspected.stdout) };
}

/** Install/audit the bound runtime, then delegate policy-bearing artifacts to its composition. */
export async function prepareWorkerRuntime(
  context: DshRunContext,
  runtime: DshRuntime,
  scope: DshRunScope,
  execute: DshProcessExecutor,
): Promise<PreparedWorkerRuntime> {
  await bindRuntime(context, runtime, scope);
  const { request, environment, workspace, extensions, composition } = context;
  const docker = request.isolation === "docker";
  const executeSetup = setupExecutor(context, scope, execute);
  if (docker) {
    try {
      await scope.setup(async () =>
        executeSetup(
          {
            command: "docker",
            args: ["info", "--format", "{{.ServerVersion}}"],
            cwd: workspace,
            env: dockerControllerEnvironment(
              environment,
              buildChildEnvironment(environment, DSH_WORKER_ENV_ALLOWLIST),
            ),
          },
          10_000,
        ),
      );
    } catch (error: unknown) {
      if (error instanceof DshProcessError || error instanceof DshIsolationUnavailableError) {
        throw new DshIsolationUnavailableError(
          "Docker CLI/daemon is unavailable; verify docker info on this runner before starting the Action",
          { cause: error },
        );
      }
      throw error;
    }
  }
  let manifestBase: Record<string, unknown> | undefined;
  if (docker && runtime.installedVersion === undefined) {
    manifestBase = await scope.setup(async () =>
      prepareLockedRuntimeFiles(runtime, request.dshVersion, context.actionRoot),
    );
    await executeSetup(
      dockerInstallerSpec({
        kind: "runtime",
        containerImage: request.containerImage,
        workspace,
        packageRoot: runtime.packageRoot,
        npmCache: runtime.npmCache,
        environment,
      }),
      PHASE_TIMEOUTS.runtimeInstallMs,
    );
    runtime.installedVersion = request.dshVersion;
    await scope.setup(async () => captureExtensionInstallBaseline(runtime, extensions));
  }
  if (docker) {
    await scope.setup(async () => rm(join(runtime.dshHome, ".env"), { force: true }));
    manifestBase ??= await scope.setup(async () =>
      readDshManifest(join(runtime.packageRoot, "package.json")),
    );
  }
  let prepared = await scope.setup(async () =>
    composition.prepare({
      isolation: request.isolation,
      assetsDirectory: context.assetsDirectory,
      runtime,
      plan: extensions,
      nativeTools: context.nativeTools,
      trust: request.trust,
      workspaceWrite: context.workspaceWrite,
      expectedOperation: request.operation,
      task: context.prompt,
      workspacePath: workspace,
      ...(manifestBase === undefined ? {} : { manifestBase }),
      ...(context.dshExecutableIdentity === undefined
        ? {}
        : { dshExecutableIdentity: context.dshExecutableIdentity }),
    }),
  );
  if (prepared.isolation !== request.isolation) {
    throw new DshConfigurationError(
      "DSH composition prepared a launch plan for the wrong isolation backend",
    );
  }
  if (!docker) return { composition: prepared };
  if (runtime.installedExtensionDigest === undefined) {
    if (Object.keys(extensions.packageDependencies).length > 0) {
      assertExtensionInstallBaseline(runtime, extensions);
      await executeSetup(
        dockerInstallerSpec({
          kind: "extension",
          containerImage: request.containerImage,
          workspace,
          packageRoot: runtime.packageRoot,
          npmCache: runtime.npmCache,
          environment,
        }),
        PHASE_TIMEOUTS.extensionInstallMs,
      );
      await scope.setup(async () => auditFreshExtensionInstallation(runtime, extensions));
    }
    runtime.installedExtensionDigest = extensions.configurationDigest;
  } else if (Object.keys(extensions.packageDependencies).length > 0) {
    await scope.setup(async () => auditReusedExtensionInstallation(runtime, extensions));
  }
  if (prepared.isolation !== "docker") {
    throw new DshConfigurationError("DSH composition was not prepared for Docker isolation");
  }
  if (prepared.finalizeAfterInstall !== undefined) {
    prepared = await prepared.finalizeAfterInstall(async (run) => scope.setup(run));
  }
  return {
    composition: prepared,
    network: await prepareWorkerNetwork(context, execute, executeSetup),
  };
}
