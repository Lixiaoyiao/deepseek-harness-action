import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { isIP } from "node:net";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assertSafeArgv } from "../security/argv.js";
import {
  assertNoGitHubCredentials,
  assertNoSecretOutput,
  assertSecretAbsent,
  buildDshWorkerEnvironment,
  collectControllerSecrets,
  redactKnownSecrets,
} from "../security/env.js";
import {
  DshAbortedError,
  DshConfigurationError,
  DshIsolationUnavailableError,
  DshOutputLimitError,
  DshProcessError,
  DshSpawnError,
  DshTimeoutError,
} from "./errors.js";
import { DshError } from "./errors.js";
import { buildDshPrompt, DEFAULT_MAX_PROMPT_BYTES, WINDOWS_MAX_PROMPT_BYTES } from "./prompt.js";
import { startDeepSeekProxy } from "./proxy.js";
import type { DeepSeekProxyHandle, DeepSeekProxyOptions } from "./proxy.js";
import { parseDshOutput } from "./schema.js";
import type { DshOperation, DshOutput } from "./schema.js";
import type { AgentToolManifest } from "../agent/contracts.js";
import {
  configuredHttpSecrets,
  configuredPluginSecrets,
  configuredStdioSecrets,
} from "../extensions/plan.js";
import type { EffectiveExtensionPlan, ExtensionAudit } from "../extensions/plan.js";
import {
  CONTROLLED_PROFILE_NAME,
  prepareControlledProfile,
  resolveInstalledPluginModuleSpecifiers,
  type ControlledProfilePaths,
  type DshPolicyRule,
} from "../extensions/profile.js";
import {
  assertExtensionPackagesAbsentFromRuntimeLock,
  auditExtensionRuntimeLock,
  snapshotRuntimeLock,
  type ExtensionRuntimeLockAudit,
  type RuntimeLockBaseline,
} from "../extensions/runtime-lock.js";
import type { WorkspaceToolId } from "../tools/schema.js";

const DSH_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u;
export const SUPPORTED_DSH_VERSIONS = ["0.1.0-rc.8"] as const;
const CONTAINER_IMAGE_REFERENCE_PATTERN =
  /^(?=.{1,512}$)[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/u;
const PINNED_CONTAINER_IMAGE_PATTERN =
  /^(?=.{1,512}$)[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_LOG_BYTES = 16 * 1024 * 1024;
const MAX_INVOCATION_STATE_BYTES = 1024 * 1024;
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_DSH_HOME = "/dsh-home";
const CONTAINER_PACKAGE_ROOT = "/opt/dsh-action/package";
const CONTAINER_LAUNCHER = `${CONTAINER_PACKAGE_ROOT}/action-launcher.mjs`;
const CONTAINER_PROFILE_ROOT = `${CONTAINER_DSH_HOME}/profiles/${CONTROLLED_PROFILE_NAME}`;
const CONTAINER_POLICY_PLUGIN = "/opt/dsh-action/action-policy.mjs";
const CONTAINER_WORKSPACE_PLUGIN = "/opt/dsh-action/action-workspace.mjs";
const CONTAINER_ACTION_STATE = `${CONTAINER_DSH_HOME}/action-state`;
const CONTAINER_SESSIONS = `${CONTAINER_DSH_HOME}/sessions`;
const CONTAINER_ATTACHMENTS = `${CONTAINER_DSH_HOME}/attachments`;
const CONTAINER_STATE = `${CONTAINER_DSH_HOME}/action-state/tool-counts.json`;
const CONTAINER_AUDIT = `${CONTAINER_DSH_HOME}/action-state/tool-receipts.jsonl`;

function hostUserForContainer(): string {
  return process.platform === "win32"
    ? "0:0"
    : `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
}

export type DshTrust = "untrusted" | "trusted-read" | "trusted-write";
export type DshIsolation = "docker" | "none";

export interface DshRunRequest {
  readonly operation: DshOperation;
  readonly prompt: string;
  readonly trustedInstructions?: string;
  readonly workspacePath?: string;
  readonly trust: DshTrust;
  readonly isolation: DshIsolation;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  /** Controller-only credential. It is never put in a worker env or argv. */
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly dshVersion: string;
  /** Absolute path to @deepseek-ai/dsh/lib/bin.js for isolation=none. */
  readonly dshExecutable?: string;
  readonly containerImage: string;
  readonly toolCatalog?: readonly AgentToolManifest[];
  readonly workspaceTools?: readonly WorkspaceToolId[];
  readonly extensions?: EffectiveExtensionPlan;
  readonly signal?: AbortSignal;
}

/** Run-scoped installation/home reused across fresh headless turns. */
export interface DshRuntime {
  readonly root: string;
  readonly dshHome: string;
  readonly packageRoot: string;
  installedVersion?: string;
  installedExtensionDigest?: string;
  installedPackageInventory?: Readonly<Record<string, string>>;
  installedPackageLockBaseline?: RuntimeLockBaseline;
  installedExtensionRuntimeLock?: ExtensionRuntimeLockAudit;
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

export interface DshToolReceipt {
  readonly schemaVersion: 1;
  readonly callId: string;
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: string;
  /** Whether the policy charged this invocation against tool and owner limits. */
  readonly counted: boolean;
  /** False only when the worker stopped after durable admission but before final observation. */
  readonly completed: boolean;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code?: string;
}

interface DshInvocationCounts {
  readonly tools: Readonly<Record<string, number>>;
  readonly groups: Readonly<Record<string, number>>;
}

export interface DshRunResult {
  readonly output: DshOutput;
  readonly rawStdout?: string;
  readonly durationMs: number;
  readonly isolationReport: DshIsolationReport;
  readonly extensionAudit?: ExtensionAudit;
  readonly toolReceipts?: readonly DshToolReceipt[];
}

export interface DshProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Optional backend cleanup command, e.g. docker kill <random-name>. */
  readonly termination?: Omit<DshProcessSpec, "termination">;
}

export interface DshProcessResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface DshProcessLimits {
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
  readonly maxCombinedBytes: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
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
}

export async function createDshRuntime(temporaryDirectory = tmpdir()): Promise<DshRuntime> {
  const root = await mkdtemp(join(temporaryDirectory, "dsh-action-"));
  const dshHome = join(root, "home");
  const packageRoot = join(dshHome, "profiles", CONTROLLED_PROFILE_NAME);
  await Promise.all(
    [
      packageRoot,
      join(dshHome, "action-state"),
      join(dshHome, "sessions"),
      join(dshHome, "attachments"),
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  return { root, dshHome, packageRoot };
}

export async function disposeDshRuntime(runtime: DshRuntime): Promise<void> {
  await rm(runtime.root, { force: true, recursive: true });
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

/** Require an immutable OCI/Docker image reference for code-writing processes. */
export function assertPinnedContainerImage(containerImage: string): void {
  if (!PINNED_CONTAINER_IMAGE_PATTERN.test(containerImage)) {
    throw new DshConfigurationError(
      "Docker extensions and trusted-write require containerImage to be an immutable name@sha256:<64 lowercase hex> reference",
    );
  }
}

/** Prevent an input value from being reinterpreted as a docker run option. */
export function assertContainerImageReference(containerImage: string): void {
  if (!CONTAINER_IMAGE_REFERENCE_PATTERN.test(containerImage)) {
    throw new DshConfigurationError(
      "containerImage must be a single Docker/OCI image reference and must not begin with an option",
    );
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshConfigurationError(`${name} must be a positive integer`);
  }
}

function killPosixTree(child: ChildProcessWithoutNullStreams, graceMs: number): void {
  const pid = child.pid;
  try {
    if (pid === undefined) child.kill("SIGTERM");
    else process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (pid === undefined) child.kill("SIGKILL");
      else process.kill(-pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, graceMs);
  forceTimer.unref();
}

function killWindowsTree(child: ChildProcessWithoutNullStreams, graceMs: number): void {
  if (child.pid === undefined) {
    child.kill();
    return;
  }
  const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  killer.once("error", () => child.kill());
  killer.unref();
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
  }, graceMs);
  forceTimer.unref();
}

function terminateTree(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
  platform: NodeJS.Platform,
  termination?: Omit<DshProcessSpec, "termination">,
): void {
  if (termination !== undefined) {
    const cleanup = spawn(termination.command, [...termination.args], {
      cwd: termination.cwd,
      env: termination.env,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    cleanup.once("error", () => undefined);
    cleanup.unref();
  }
  if (platform === "win32") killWindowsTree(child, graceMs);
  else killPosixTree(child, graceMs);
}

/**
 * Spawn one argv-only process with independent stdout/stderr and aggregate
 * caps. Timeout state is controller-owned because DSH exits 0 on SIGTERM.
 */
export async function executeBoundedDshProcess(
  spec: DshProcessSpec,
  limits: DshProcessLimits,
  platform: NodeJS.Platform = process.platform,
): Promise<DshProcessResult> {
  positiveInteger(limits.timeoutMs, "timeoutMs");
  positiveInteger(limits.maxStdoutBytes, "maxStdoutBytes");
  positiveInteger(limits.maxStderrBytes, "maxStderrBytes");
  positiveInteger(limits.maxCombinedBytes, "maxCombinedBytes");
  assertSafeArgv(spec.command, spec.args);

  if (limits.signal?.aborted === true) throw new DshAbortedError();

  return await new Promise<DshProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: spec.env,
        detached: platform !== "win32",
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stdin.end();
    } catch (error: unknown) {
      rejectPromise(new DshSpawnError("Failed to spawn DSH", { cause: error }));
      return;
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminalError: DshError | undefined;
    const graceMs = limits.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

    const stop = (error: DshError): void => {
      if (terminalError !== undefined) return;
      terminalError = error;
      terminateTree(child, graceMs, platform, spec.termination);
    };

    const capture = (stream: "stdout" | "stderr", value: unknown): void => {
      if (terminalError !== undefined) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
      if (stream === "stdout") stdoutBytes += chunk.byteLength;
      else stderrBytes += chunk.byteLength;

      const streamBytes = stream === "stdout" ? stdoutBytes : stderrBytes;
      const streamLimit = stream === "stdout" ? limits.maxStdoutBytes : limits.maxStderrBytes;
      if (streamBytes > streamLimit) {
        stop(new DshOutputLimitError(stream, streamLimit));
        return;
      }
      if (stdoutBytes + stderrBytes > limits.maxCombinedBytes) {
        stop(new DshOutputLimitError("combined", limits.maxCombinedBytes));
        return;
      }
      (stream === "stdout" ? stdoutChunks : stderrChunks).push(chunk);
    };

    child.stdout.on("data", (value: unknown) => capture("stdout", value));
    child.stderr.on("data", (value: unknown) => capture("stderr", value));

    const timeout = setTimeout(() => stop(new DshTimeoutError(limits.timeoutMs)), limits.timeoutMs);
    timeout.unref();
    const abort = (): void => stop(new DshAbortedError());
    limits.signal?.addEventListener("abort", abort, { once: true });

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      limits.signal?.removeEventListener("abort", abort);
    };

    child.once("error", (error: Error) => {
      finish();
      rejectPromise(
        terminalError ??
          new DshSpawnError("Failed to spawn or communicate with DSH", { cause: error }),
      );
    });
    child.once("close", (exitCode, signal) => {
      finish();
      if (terminalError !== undefined) {
        rejectPromise(terminalError);
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
        exitCode,
        signal,
      });
    });
  });
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

async function prepareLockedRuntimeFiles(
  runtime: DshRuntime,
  version: string,
): Promise<Record<string, unknown>> {
  const actionRoot = defaultActionRoot();
  const manifestSource = join(actionRoot, "package.json");
  const lockSource = join(actionRoot, "package-lock.json");
  const manifest = JSON.parse(await readFile(manifestSource, "utf8")) as Record<string, unknown>;
  const lock = JSON.parse(await readFile(lockSource, "utf8")) as {
    readonly packages?: Readonly<Record<string, { readonly version?: string }>>;
  };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/u.test(path)) continue;
    if (entry.version !== version) {
      throw new DshConfigurationError(
        `DSH lockfile drift at ${path}: expected ${version}, found ${entry.version ?? "unknown"}`,
      );
    }
  }
  await copyFile(manifestSource, join(runtime.packageRoot, "package.json"));
  await copyFile(lockSource, join(runtime.packageRoot, "package-lock.json"));
  return manifest;
}

function insideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function verifyInstalledExtensions(
  packageRoot: string,
  plan: EffectiveExtensionPlan,
): Promise<void> {
  const installed = [
    ...plan.bundles.map((extension) => ({ extension, bundle: true })),
    ...plan.plugins.map((extension) => ({ extension, bundle: false })),
  ];
  for (const { extension, bundle } of installed) {
    const packageDirectory = join(
      packageRoot,
      "node_modules",
      ...extension.definition.package.split("/"),
    );
    const packageReal = await realpath(packageDirectory);
    const manifestPath = join(packageReal, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      readonly name?: string;
      readonly version?: string;
      readonly gitHead?: string;
      readonly dsh?: { readonly bundle?: { readonly patch?: string } };
    };
    if (manifest.name !== extension.definition.package) {
      throw new DshConfigurationError(
        `Installed extension package identity mismatch: ${extension.definition.id}`,
      );
    }
    const source = extension.definition.source;
    if (/^\d/u.test(source) && manifest.version !== source) {
      throw new DshConfigurationError(
        `Installed extension ${extension.definition.package} is ${manifest.version ?? "unknown"}, expected ${source}`,
      );
    }
    // npm does not guarantee that a git install rewrites package.json with
    // gitHead. The package-lock resolved URL is verified against the approved
    // 40-character commit immediately after this identity/manifest check.
    if (
      source.startsWith("git+") &&
      manifest.gitHead !== undefined &&
      manifest.gitHead !== source.slice(source.lastIndexOf("#") + 1)
    ) {
      throw new DshConfigurationError(
        `Installed extension ${extension.definition.package} reports a different git commit`,
      );
    }
    if (bundle) {
      const patch = manifest.dsh?.bundle?.patch;
      if (typeof patch !== "string" || patch.trim() === "") {
        throw new DshConfigurationError(
          `Bundle ${extension.definition.package} has no dsh.bundle.patch`,
        );
      }
      const patchReal = await realpath(resolve(packageReal, patch));
      if (!insideDirectory(packageReal, patchReal)) {
        throw new DshConfigurationError(
          `Bundle ${extension.definition.package} patch escapes the installed package`,
        );
      }
    }
  }
}

/** @internal Supply-chain invariant used by the Docker extension installer. */
export async function installedTopLevelPackageInventory(
  packageRoot: string,
): Promise<Readonly<Record<string, string>>> {
  const modulesRoot = join(packageRoot, "node_modules");
  const packagePaths: string[] = [];
  for (const entry of await readdir(modulesRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(modulesRoot, entry.name);
    if (entry.name.startsWith("@")) {
      if (!entry.isDirectory()) {
        throw new DshConfigurationError(`Invalid scoped package directory: ${entry.name}`);
      }
      for (const child of await readdir(entryPath, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) {
          packagePaths.push(join(entryPath, child.name));
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) packagePaths.push(entryPath);
  }

  const inventory: Record<string, string> = {};
  for (const packagePath of packagePaths) {
    const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new DshConfigurationError(`Installed package has invalid identity: ${packagePath}`);
    }
    if (inventory[manifest.name] !== undefined) {
      throw new DshConfigurationError(`Duplicate top-level package identity: ${manifest.name}`);
    }
    inventory[manifest.name] = manifest.version;
  }
  return Object.freeze(inventory);
}

/** @internal Reject direct extension identities that collide with the locked runtime. */
export function assertExtensionPackagesDoNotShadowRuntime(
  plan: Pick<EffectiveExtensionPlan, "packageDependencies">,
  inventory: Readonly<Record<string, string>>,
): void {
  const collision = Object.keys(plan.packageDependencies).find(
    (packageName) => inventory[packageName] !== undefined,
  );
  if (collision !== undefined) {
    throw new DshConfigurationError(
      `Extension package ${collision} would shadow a Controller-owned runtime dependency`,
    );
  }
}

/** @internal Verify npm did not replace or remove any pre-existing runtime package. */
export function assertInstalledRuntimeInventoryUnchanged(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): void {
  for (const [packageName, version] of Object.entries(before)) {
    if (after[packageName] !== version) {
      throw new DshConfigurationError(
        `Extension installation changed runtime package ${packageName}: expected ${version}, found ${after[packageName] ?? "missing"}`,
      );
    }
  }
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

function dockerControllerEnvironment(
  source: NodeJS.ProcessEnv,
  worker: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...worker };
  for (const name of [
    "DOCKER_CONFIG",
    "DOCKER_CONTEXT",
    "DOCKER_HOST",
    "DOCKER_TLS_VERIFY",
    "DOCKER_CERT_PATH",
  ]) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  assertNoGitHubCredentials(result);
  return result;
}

function containerEnvironment(
  proxy: DeepSeekProxyHandle,
  workspaceWrite: boolean,
): Readonly<Record<string, string>> {
  return {
    CI: "true",
    HOME: CONTAINER_DSH_HOME,
    npm_config_cache: "/tmp/npm-cache",
    DSH_HOME: CONTAINER_DSH_HOME,
    DSH_PERMISSION_MODE: workspaceWrite ? "workspace-write" : "read-only",
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TOOLS_MODE: "native",
    DEEPSEEK_API_KEY: proxy.workerToken,
    DEEPSEEK_BASE_URL: proxy.workerBaseUrl,
  };
}

function dockerSpec(
  request: DshRunRequest,
  workspace: string,
  dshHome: string,
  packageRoot: string,
  launcherPath: string,
  policyPluginPath: string,
  workspacePluginPath: string,
  networkName: string,
  hostGateway: string,
  prompt: string,
  environment: NodeJS.ProcessEnv,
  workerEnvironment: NodeJS.ProcessEnv,
  proxy: DeepSeekProxyHandle,
): DshProcessSpec {
  assertContainerImageReference(request.containerImage);
  assertSupportedDshVersion(request.dshVersion);
  if (request.dshExecutable !== undefined && request.dshExecutable !== "") {
    throw new DshConfigurationError(
      "dshExecutable is host-only and cannot be used with Docker isolation",
    );
  }

  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    `dsh-action-${randomUUID()}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "256",
    "--memory",
    "2g",
    "--cpus",
    "2",
    "--user",
    hostUserForContainer(),
    "--network",
    networkName,
    "--add-host",
    `host.docker.internal:${hostGateway}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=536870912",
    "--volume",
    `${workspace}:${CONTAINER_WORKSPACE}:${workerWorkspaceWrite(request) ? "rw" : "ro"}`,
    "--volume",
    `${dshHome}:${CONTAINER_DSH_HOME}:ro`,
    "--volume",
    `${join(dshHome, "action-state")}:${CONTAINER_ACTION_STATE}:rw`,
    "--volume",
    `${join(dshHome, "sessions")}:${CONTAINER_SESSIONS}:rw`,
    "--volume",
    `${join(dshHome, "attachments")}:${CONTAINER_ATTACHMENTS}:rw`,
    "--volume",
    `${packageRoot}:${CONTAINER_PROFILE_ROOT}:ro`,
    "--volume",
    `${policyPluginPath}:${CONTAINER_POLICY_PLUGIN}:ro`,
    "--volume",
    `${workspacePluginPath}:${CONTAINER_WORKSPACE_PLUGIN}:ro`,
    "--volume",
    `${packageRoot}:${CONTAINER_PACKAGE_ROOT}:ro`,
    "--volume",
    `${launcherPath}:${CONTAINER_LAUNCHER}:ro`,
    "--workdir",
    "/tmp",
  ];
  for (const [name, value] of Object.entries(
    containerEnvironment(proxy, workerWorkspaceWrite(request)),
  )) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(request.containerImage, "node", "--expose-internals", CONTAINER_LAUNCHER, prompt);

  const nameIndex = args.indexOf("--name") + 1;
  const containerName = args[nameIndex];
  if (containerName === undefined)
    throw new DshConfigurationError("Docker container name is missing");
  const controllerEnv = dockerControllerEnvironment(environment, workerEnvironment);

  return {
    command: "docker",
    args,
    cwd: workspace,
    env: controllerEnv,
    termination: {
      command: "docker",
      args: ["kill", containerName],
      cwd: workspace,
      env: controllerEnv,
    },
  };
}

function dockerInstallSpec(
  request: DshRunRequest,
  workspace: string,
  packageRoot: string,
  environment: NodeJS.ProcessEnv,
): DshProcessSpec {
  const containerName = `dsh-action-install-${randomUUID()}`;
  const controllerEnv = dockerControllerEnvironment(environment, {});
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--network",
      "bridge",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=536870912",
      "--user",
      hostUserForContainer(),
      "--volume",
      `${packageRoot}:${CONTAINER_PACKAGE_ROOT}:rw`,
      "--workdir",
      CONTAINER_PACKAGE_ROOT,
      "--env",
      "HOME=/tmp",
      "--env",
      "npm_config_cache=/tmp/npm-cache",
      "--env",
      "NODE_OPTIONS=--max-old-space-size=3072",
      request.containerImage,
      "npm",
      "ci",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--ignore-scripts",
      "--loglevel=error",
    ],
    cwd: workspace,
    env: controllerEnv,
    termination: {
      command: "docker",
      args: ["kill", containerName],
      cwd: workspace,
      env: controllerEnv,
    },
  };
}

function dockerExtensionInstallSpec(
  request: DshRunRequest,
  workspace: string,
  packageRoot: string,
  environment: NodeJS.ProcessEnv,
): DshProcessSpec {
  const containerName = `dsh-action-extension-install-${randomUUID()}`;
  const controllerEnv = dockerControllerEnvironment(environment, {});
  return {
    command: "docker",
    args: [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "256",
      "--memory",
      "4g",
      "--cpus",
      "2",
      "--network",
      "bridge",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=536870912",
      "--user",
      hostUserForContainer(),
      "--volume",
      `${packageRoot}:${CONTAINER_PACKAGE_ROOT}:rw`,
      "--workdir",
      CONTAINER_PACKAGE_ROOT,
      "--env",
      "HOME=/tmp",
      "--env",
      "npm_config_cache=/tmp/npm-cache",
      request.containerImage,
      "npm",
      "install",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--ignore-scripts",
      "--install-strategy=nested",
      "--package-lock=true",
      "--package-lock-only=false",
      "--lockfile-version=3",
      "--omit-lockfile-registry-resolved=false",
      "--save=true",
      "--loglevel=error",
    ],
    cwd: workspace,
    env: controllerEnv,
    termination: {
      command: "docker",
      args: ["kill", containerName],
      cwd: workspace,
      env: controllerEnv,
    },
  };
}

function localSpec(
  request: DshRunRequest,
  workspace: string,
  patchPath: string,
  toolPolicyPath: string,
  prompt: string,
  workerEnvironment: NodeJS.ProcessEnv,
): DshProcessSpec {
  const executable =
    request.dshExecutable === undefined || request.dshExecutable === ""
      ? resolveInstalledDshBin()
      : request.dshExecutable;
  if (!isAbsolute(executable)) {
    throw new DshConfigurationError("dshExecutable must be an absolute path to lib/bin.js");
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

function dockerNetworkSpec(
  action: "create" | "remove",
  name: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
): DshProcessSpec {
  const controllerEnv = dockerControllerEnvironment(environment, {});
  return {
    command: "docker",
    args: action === "create" ? ["network", "create", "--internal", name] : ["network", "rm", name],
    cwd: workspace,
    env: controllerEnv,
  };
}

function dockerNetworkInspectSpec(
  name: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
): DshProcessSpec {
  return {
    command: "docker",
    args: ["network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", name],
    cwd: workspace,
    env: dockerControllerEnvironment(environment, {}),
  };
}

function parseInternalNetworkGateway(stdout: string): string {
  const gateway = stdout.trim();
  if (isIP(gateway) !== 4) {
    throw new DshIsolationUnavailableError(
      "Docker did not report a valid IPv4 gateway for the internal worker network",
    );
  }
  return gateway;
}

function isolationReport(request: DshRunRequest): DshIsolationReport {
  const repoToolsEnabled = effectiveWorkspaceTools(request).length > 0;
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

function defaultWorkspaceTools(request: DshRunRequest): readonly WorkspaceToolId[] {
  if (request.trust === "trusted-write") {
    return ["workspace.read", "workspace.search", "workspace.edit"];
  }
  if (request.trust === "trusted-read" && request.isolation === "docker") {
    return ["workspace.read", "workspace.search"];
  }
  return [];
}

function effectiveWorkspaceTools(request: DshRunRequest): readonly WorkspaceToolId[] {
  const requested = request.workspaceTools ?? defaultWorkspaceTools(request);
  if (request.trust === "untrusted") return [];
  if (request.trust === "trusted-read" && request.isolation !== "docker") return [];
  return requested.filter((tool) => tool !== "workspace.edit" || request.trust === "trusted-write");
}

function workerWorkspaceWrite(request: DshRunRequest): boolean {
  return (
    effectiveWorkspaceTools(request).includes("workspace.edit") ||
    effectiveExtensionPlan(request).tools.some((tool) =>
      tool.permissions.includes("workspace-write"),
    )
  );
}

async function writeToolPolicy(runtime: DshRuntime, request: DshRunRequest): Promise<string> {
  const enabled = new Set(effectiveWorkspaceTools(request));
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
    ...new Set([request.apiKey, ...collectControllerSecrets(environment), ...extensionValues]),
  ].filter((secret) => secret.length >= 4);
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

interface RawDshToolReceipt {
  readonly schemaVersion: 1;
  readonly phase: "started" | "completed";
  readonly callId: string;
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: "builtin" | "mcp" | "plugin" | "denied";
  readonly counted: boolean;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly code?: string;
}

function parseRawToolReceipt(line: string): RawDshToolReceipt {
  let value: Partial<RawDshToolReceipt> & Readonly<Record<string, unknown>>;
  try {
    value = JSON.parse(line) as Partial<RawDshToolReceipt> & Readonly<Record<string, unknown>>;
  } catch {
    throw new DshConfigurationError("DSH emitted a malformed tool receipt");
  }
  const allowedKeys = new Set([
    "schemaVersion",
    "phase",
    "callId",
    "id",
    "runtimeName",
    "provider",
    "counted",
    "ok",
    "durationMs",
    "code",
  ]);
  if (
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    value.schemaVersion !== 1 ||
    (value.phase !== "started" && value.phase !== "completed") ||
    typeof value.callId !== "string" ||
    value.callId.length === 0 ||
    value.callId.length > 256 ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > 256 ||
    typeof value.runtimeName !== "string" ||
    !/^[A-Za-z0-9_-]{1,64}$/u.test(value.runtimeName) ||
    !["builtin", "mcp", "plugin", "denied"].includes(value.provider ?? "") ||
    typeof value.counted !== "boolean" ||
    typeof value.ok !== "boolean" ||
    !Number.isSafeInteger(value.durationMs) ||
    (value.durationMs ?? -1) < 0 ||
    (value.code !== undefined &&
      (typeof value.code !== "string" || value.code.length === 0 || value.code.length > 128))
  ) {
    throw new DshConfigurationError("DSH emitted a malformed tool receipt");
  }
  if (
    value.phase === "started" &&
    (!value.counted ||
      value.ok ||
      value.durationMs !== 0 ||
      value.code !== "ACTION_TOOL_INCOMPLETE")
  ) {
    throw new DshConfigurationError("DSH emitted a malformed tool admission receipt");
  }
  return value as RawDshToolReceipt;
}

async function readToolReceipts(path: string, offset: number): Promise<readonly DshToolReceipt[]> {
  const size = await fileSize(path);
  if (size > MAX_RECEIPT_LOG_BYTES || size - offset > MAX_RECEIPT_LOG_BYTES) {
    throw new DshConfigurationError("DSH tool receipt log exceeded the Controller limit");
  }
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (offset > buffer.byteLength) {
    throw new DshConfigurationError("DSH tool receipt log was truncated during a turn");
  }
  const text = buffer.subarray(offset).toString("utf8").trim();
  if (text === "") return [];
  const events = text.split("\n").map((line) => parseRawToolReceipt(line));
  const started = new Map<string, RawDshToolReceipt>();
  const completed = new Map<string, RawDshToolReceipt>();
  const order: string[] = [];
  for (const event of events) {
    const target = event.phase === "started" ? started : completed;
    if (target.has(event.callId)) {
      throw new DshConfigurationError(`DSH emitted duplicate ${event.phase} tool receipts`);
    }
    target.set(event.callId, event);
    if (!order.includes(event.callId)) order.push(event.callId);
  }
  return order.map((callId) => {
    const admission = started.get(callId);
    const result = completed.get(callId);
    if (result !== undefined) {
      if (result.counted) {
        if (
          admission?.id !== result.id ||
          admission.runtimeName !== result.runtimeName ||
          admission.provider !== result.provider
        ) {
          throw new DshConfigurationError(
            "DSH emitted a completed counted receipt without a matching admission",
          );
        }
      } else if (admission !== undefined) {
        throw new DshConfigurationError("DSH changed whether a tool invocation was counted");
      }
      return {
        schemaVersion: 1,
        callId: result.callId,
        id: result.id,
        runtimeName: result.runtimeName,
        provider: result.provider,
        counted: result.counted,
        completed: true,
        ok: result.ok,
        durationMs: result.durationMs,
        ...(result.code === undefined ? {} : { code: result.code }),
      };
    }
    if (admission === undefined) {
      throw new DshConfigurationError("DSH tool receipt sequence is malformed");
    }
    return {
      schemaVersion: 1,
      callId: admission.callId,
      id: admission.id,
      runtimeName: admission.runtimeName,
      provider: admission.provider,
      counted: true,
      completed: false,
      ok: false,
      durationMs: 0,
      code: "ACTION_TOOL_INCOMPLETE",
    };
  });
}

function emptyInvocationCounts(): DshInvocationCounts {
  return { tools: {}, groups: {} };
}

function parseInvocationRecord(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): Readonly<Record<string, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DshConfigurationError(`DSH invocation ${label} state is malformed`);
  }
  const parsed: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (!allowedKeys.has(key) || !Number.isSafeInteger(count) || (count as number) < 0) {
      throw new DshConfigurationError(`DSH invocation ${label} state is malformed`);
    }
    parsed[key] = count as number;
  }
  return parsed;
}

async function readInvocationCounts(
  path: string,
  rules: readonly DshPolicyRule[],
): Promise<DshInvocationCounts> {
  let text: string;
  try {
    const details = await stat(path);
    if (details.size > MAX_INVOCATION_STATE_BYTES) {
      throw new DshConfigurationError("DSH invocation state exceeded the Controller limit");
    }
    text = await readFile(path, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyInvocationCounts();
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new DshConfigurationError("DSH invocation state is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DshConfigurationError("DSH invocation state is malformed");
  }
  const state = value as Readonly<Record<string, unknown>>;
  if (
    state.schemaVersion !== 1 ||
    Object.keys(state).some((key) => !["schemaVersion", "tools", "groups"].includes(key))
  ) {
    throw new DshConfigurationError("DSH invocation state is malformed");
  }
  return {
    tools: parseInvocationRecord(state.tools, new Set(rules.map((rule) => rule.id)), "tool"),
    groups: parseInvocationRecord(
      state.groups,
      new Set(rules.map((rule) => rule.groupId)),
      "group",
    ),
  };
}

function invocationDelta(
  before: Readonly<Record<string, number>>,
  after: Readonly<Record<string, number>>,
): number {
  let total = 0;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0);
    if (!Number.isSafeInteger(delta) || delta < 0 || !Number.isSafeInteger(total + delta)) {
      throw new DshConfigurationError("DSH invocation counters moved backwards or overflowed");
    }
    total += delta;
  }
  return total;
}

function reconcileToolAudit(
  before: DshInvocationCounts,
  after: DshInvocationCounts,
  receipts: readonly DshToolReceipt[],
  requireCompleted: boolean,
): void {
  const toolDelta = invocationDelta(before.tools, after.tools);
  const groupDelta = invocationDelta(before.groups, after.groups);
  const counted = receipts.filter((receipt) => receipt.counted).length;
  if (toolDelta !== groupDelta || toolDelta !== counted) {
    throw new DshConfigurationError(
      "DSH invocation counters and durable tool receipts do not reconcile",
    );
  }
  if (requireCompleted && receipts.some((receipt) => receipt.counted && !receipt.completed)) {
    throw new DshConfigurationError("DSH completed with an unfinished tool receipt");
  }
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

  const environment = dependencies.environment ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const workspace = resolve(request.workspacePath ?? process.cwd());
  await assertDirectory(workspace, "workspacePath");

  const assets = dependencies.assetsDirectory ?? defaultAssetsDirectory();
  const patchName =
    request.trust === "trusted-write"
      ? "trusted-write.patch.yml"
      : request.trust === "trusted-read" && request.isolation === "docker"
        ? "trusted-read.patch.yml"
        : "strict-untrusted.patch.yml";
  const patchPath = join(assets, patchName);
  await assertFile(patchPath, "DSH patch profile");

  const prompt = buildDshPrompt({
    operation: request.operation,
    prompt: request.prompt,
    ...(request.trustedInstructions === undefined
      ? {}
      : { trustedInstructions: request.trustedInstructions }),
    trust: request.trust,
    toolCatalog: request.toolCatalog ?? [],
    maxBytes: platform === "win32" ? WINDOWS_MAX_PROMPT_BYTES : DEFAULT_MAX_PROMPT_BYTES,
  });

  const ownsRuntime = dependencies.runtime === undefined;
  const runtime =
    dependencies.runtime ?? (await createDshRuntime(dependencies.temporaryDirectory ?? tmpdir()));
  if (runtime.installedVersion !== undefined && runtime.installedVersion !== request.dshVersion) {
    throw new DshConfigurationError("A reused DSH runtime cannot change dshVersion");
  }
  if (
    runtime.installedExtensionDigest !== undefined &&
    runtime.installedExtensionDigest !== extensions.configurationDigest
  ) {
    throw new DshConfigurationError("A reused DSH runtime cannot change its extension lock");
  }
  let proxy: DeepSeekProxyHandle | undefined;
  let internalNetwork: string | undefined;
  let internalNetworkGateway: string | undefined;
  let controlledProfile: ControlledProfilePaths | undefined;
  let turnReceipts: readonly DshToolReceipt[] = [];
  let executeForCleanup:
    ((spec: DshProcessSpec, limits: DshProcessLimits) => Promise<DshProcessResult>) | undefined;
  const secrets = controllerSecrets(request, environment);
  try {
    const docker = request.isolation === "docker";
    const localDshHome = runtime.dshHome;
    const packageRoot = runtime.packageRoot;
    const execute =
      dependencies.executeProcess ??
      ((processSpec, limits) => executeBoundedDshProcess(processSpec, limits, platform));
    executeForCleanup = execute;
    const executeSetup = async (spec: DshProcessSpec): Promise<DshProcessResult> => {
      const elapsed = Math.max(0, now() - startedAt);
      const remaining = request.timeoutMs - elapsed;
      if (remaining <= 0) throw new DshTimeoutError(request.timeoutMs);
      let result: DshProcessResult;
      try {
        result = await execute(spec, {
          timeoutMs: remaining,
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
      manifestBase = await prepareLockedRuntimeFiles(runtime, request.dshVersion);
      await executeSetup(dockerInstallSpec(request, workspace, packageRoot, environment));
      runtime.installedVersion = request.dshVersion;
      if (Object.keys(extensions.packageDependencies).length > 0) {
        runtime.installedPackageInventory = await installedTopLevelPackageInventory(packageRoot);
        runtime.installedPackageLockBaseline = snapshotRuntimeLock(
          await readFile(join(packageRoot, "package-lock.json"), "utf8"),
        );
      }
    }

    const policyPluginPath = join(assets, "action-policy.mjs");
    const workspacePluginPath = join(assets, "action-workspace.mjs");
    const launcherPath = join(assets, "action-launcher.mjs");
    await assertFile(policyPluginPath, "DSH Action policy plugin");
    await assertFile(workspacePluginPath, "DSH Action workspace plugin");
    await assertFile(launcherPath, "DSH Action launcher");
    if (docker) {
      await rm(join(localDshHome, ".env"), { force: true });
      manifestBase ??= JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const profileOptions = {
        dshHome: localDshHome,
        plan: extensions,
        workspaceTools: effectiveWorkspaceTools(request),
        workspaceWrite: workerWorkspaceWrite(request),
        task: prompt,
        workerWorkspacePath: CONTAINER_WORKSPACE,
        policyPluginPath: CONTAINER_POLICY_PLUGIN,
        workspacePluginPath: CONTAINER_WORKSPACE_PLUGIN,
        workerStatePath: CONTAINER_STATE,
        workerAuditPath: CONTAINER_AUDIT,
        manifestBase,
      } as const;
      controlledProfile = await prepareControlledProfile(profileOptions);
      if (resolve(controlledProfile.profileDir) !== resolve(packageRoot)) {
        throw new DshConfigurationError(
          "Controlled Profile and extension installation must share one package root",
        );
      }
      if (runtime.installedExtensionDigest === undefined) {
        if (Object.keys(extensions.packageDependencies).length > 0) {
          const baseline = runtime.installedPackageInventory;
          const lockBaseline = runtime.installedPackageLockBaseline;
          if (baseline === undefined || lockBaseline === undefined) {
            throw new DshConfigurationError(
              "Extension installation requires a Controller-owned runtime package and lock inventory",
            );
          }
          assertExtensionPackagesDoNotShadowRuntime(extensions, baseline);
          assertExtensionPackagesAbsentFromRuntimeLock(
            lockBaseline,
            extensions.packageDependencies,
          );
          await executeSetup(
            dockerExtensionInstallSpec(request, workspace, packageRoot, environment),
          );
          assertInstalledRuntimeInventoryUnchanged(
            baseline,
            await installedTopLevelPackageInventory(packageRoot),
          );
          await verifyInstalledExtensions(packageRoot, extensions);
          runtime.installedExtensionRuntimeLock = auditExtensionRuntimeLock({
            lockText: await readFile(join(packageRoot, "package-lock.json"), "utf8"),
            baseline: lockBaseline,
            extensionDependencies: extensions.packageDependencies,
            expectedRootName: "dsh-profile-github-action",
          });
        }
        runtime.installedExtensionDigest = extensions.configurationDigest;
      } else if (Object.keys(extensions.packageDependencies).length > 0) {
        const lockBaseline = runtime.installedPackageLockBaseline;
        const installedLock = runtime.installedExtensionRuntimeLock;
        if (lockBaseline === undefined || installedLock === undefined) {
          throw new DshConfigurationError(
            "Reused extension runtime has no Controller-verified package-lock audit",
          );
        }
        const currentLock = auditExtensionRuntimeLock({
          lockText: await readFile(join(packageRoot, "package-lock.json"), "utf8"),
          baseline: lockBaseline,
          extensionDependencies: extensions.packageDependencies,
          expectedRootName: "dsh-profile-github-action",
        });
        if (currentLock.digest !== installedLock.digest) {
          throw new DshConfigurationError("Reused extension runtime package-lock digest changed");
        }
      }
      if (extensions.plugins.length > 0) {
        let pluginModuleSpecifiers: Readonly<Record<string, string>>;
        try {
          pluginModuleSpecifiers = await resolveInstalledPluginModuleSpecifiers({
            packageRoot,
            workerProfilePath: CONTAINER_PROFILE_ROOT,
            plan: extensions,
          });
        } catch (error: unknown) {
          throw new DshConfigurationError(
            "Installed direct Plugin entry failed Controller containment validation",
            { cause: error },
          );
        }
        controlledProfile = await prepareControlledProfile({
          ...profileOptions,
          pluginModuleSpecifiers,
        });
      }
      if (!extensions.network) {
        internalNetwork = `dsh-action-internal-${randomUUID()}`;
        await executeSetup(dockerNetworkSpec("create", internalNetwork, workspace, environment));
        const inspected = await executeSetup(
          dockerNetworkInspectSpec(internalNetwork, workspace, environment),
        );
        internalNetworkGateway = parseInternalNetworkGateway(inspected.stdout);
      }
    }

    const proxyFactory = dependencies.startProxy ?? startDeepSeekProxy;
    proxy = await proxyFactory({
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      bindHost: docker ? "0.0.0.0" : "127.0.0.1",
      workerHost: docker ? (internalNetworkGateway ?? "host.docker.internal") : "127.0.0.1",
      requestTimeoutMs: request.timeoutMs,
      maxResponseBytes: request.maxOutputBytes,
    });
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
    const toolPolicyPath = docker ? undefined : await writeToolPolicy(runtime, request);
    const auditOffset =
      controlledProfile === undefined ? 0 : await fileSize(controlledProfile.auditPath);
    const invocationCountsBefore =
      controlledProfile === undefined
        ? emptyInvocationCounts()
        : await readInvocationCounts(controlledProfile.statePath, controlledProfile.rules);

    const spec = docker
      ? dockerSpec(
          request,
          workspace,
          localDshHome,
          packageRoot,
          launcherPath,
          policyPluginPath,
          workspacePluginPath,
          internalNetwork ?? "bridge",
          internalNetworkGateway ?? "host-gateway",
          prompt,
          environment,
          workerEnvironment,
          proxy,
        )
      : localSpec(
          request,
          workspace,
          patchPath,
          toolPolicyPath ?? patchPath,
          prompt,
          workerEnvironment,
        );
    assertSecretAbsent(spec.env, request.apiKey, "real DeepSeek API key");
    if (spec.args.some((argument) => argument.includes(request.apiKey))) {
      throw new DshConfigurationError("Real DeepSeek API key was found in DSH argv");
    }

    const elapsedBeforeSpawn = Math.max(0, now() - startedAt);
    const remainingMs = request.timeoutMs - elapsedBeforeSpawn;
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
        output = parseDshOutput(processResult.stdout, request.operation);
      } catch (error: unknown) {
        executionFailure = error;
      }
    }

    if (controlledProfile !== undefined) {
      try {
        turnReceipts = await readToolReceipts(controlledProfile.auditPath, auditOffset);
        assertNoSecretOutput("tool receipt", JSON.stringify(turnReceipts), workerSecrets);
        const countsAfter = await readInvocationCounts(
          controlledProfile.statePath,
          controlledProfile.rules,
        );
        reconcileToolAudit(
          invocationCountsBefore,
          countsAfter,
          turnReceipts,
          executionFailure === undefined,
        );
      } catch (error: unknown) {
        executionFailure = error;
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
    try {
      await proxy?.close();
    } finally {
      try {
        if (internalNetwork !== undefined && executeForCleanup !== undefined) {
          await executeForCleanup(
            dockerNetworkSpec("remove", internalNetwork, workspace, environment),
            {
              timeoutMs: 10_000,
              maxStdoutBytes: 64 * 1024,
              maxStderrBytes: 64 * 1024,
              maxCombinedBytes: 128 * 1024,
            },
          ).catch(() => undefined);
        }
      } finally {
        if (ownsRuntime) await disposeDshRuntime(runtime);
      }
    }
  }
}
