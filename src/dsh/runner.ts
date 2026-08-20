import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
import type { DshError } from "./errors.js";
import { buildDshPrompt, DEFAULT_MAX_PROMPT_BYTES, WINDOWS_MAX_PROMPT_BYTES } from "./prompt.js";
import { startDeepSeekProxy } from "./proxy.js";
import type { DeepSeekProxyHandle, DeepSeekProxyOptions } from "./proxy.js";
import { parseDshOutput } from "./schema.js";
import type { DshOperation, DshOutput } from "./schema.js";
import type { AgentToolManifest } from "../agent/contracts.js";
import type { WorkspaceToolId } from "../tools/schema.js";

const DSH_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/u;
export const SUPPORTED_DSH_VERSIONS = ["0.1.0-rc.6"] as const;
const PINNED_CONTAINER_IMAGE_PATTERN = /^[^\s@\0]+@sha256:[a-f0-9]{64}$/u;
const DEFAULT_KILL_GRACE_MS = 2_000;
const MAX_STDERR_BYTES = 2 * 1024 * 1024;
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_DSH_HOME = "/dsh-home";
const CONTAINER_PATCH = "/opt/dsh-action/policy.patch.yml";
const CONTAINER_TOOL_POLICY = "/opt/dsh-action/tool-policy.patch.yml";
const CONTAINER_PACKAGE_ROOT = "/opt/dsh-action/package";
const CONTAINER_DSH_BIN = `${CONTAINER_PACKAGE_ROOT}/node_modules/@deepseek-ai/dsh/lib/bin.js`;

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
  readonly signal?: AbortSignal;
}

/** Run-scoped installation/home reused across fresh headless turns. */
export interface DshRuntime {
  readonly root: string;
  readonly dshHome: string;
  readonly packageRoot: string;
  installedVersion?: string;
}

export interface DshIsolationReport {
  readonly backend: DshIsolation;
  readonly credentialMediated: true;
  readonly repoToolsEnabled: boolean;
  readonly processIsolated: boolean;
  readonly networkIsolated: false;
  readonly workspaceAccess: "read-only" | "read-write";
  readonly limitations: readonly string[];
}

export interface DshRunResult {
  readonly output: DshOutput;
  readonly rawStdout?: string;
  readonly durationMs: number;
  readonly isolationReport: DshIsolationReport;
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
  const packageRoot = join(root, "package");
  await mkdir(dshHome, { recursive: true });
  await mkdir(packageRoot, { recursive: true });
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
      "Trusted-write requires containerImage to be an immutable name@sha256:<64 lowercase hex> reference",
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

function killWindowsTree(child: ChildProcessWithoutNullStreams): void {
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
  if (platform === "win32") killWindowsTree(child);
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
  trust: DshTrust,
): Readonly<Record<string, string>> {
  return {
    CI: "true",
    HOME: CONTAINER_DSH_HOME,
    npm_config_cache: `${CONTAINER_DSH_HOME}/npm-cache`,
    DSH_HOME: CONTAINER_DSH_HOME,
    DSH_PERMISSION_MODE: trust === "trusted-write" ? "workspace-write" : "read-only",
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
  patchPath: string,
  toolPolicyPath: string,
  prompt: string,
  environment: NodeJS.ProcessEnv,
  workerEnvironment: NodeJS.ProcessEnv,
  proxy: DeepSeekProxyHandle,
): DshProcessSpec {
  if (request.containerImage.trim() === "" || request.containerImage.includes("\0")) {
    throw new DshConfigurationError("containerImage must be non-empty and contain no NUL bytes");
  }
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
    "bridge",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=536870912",
    "--volume",
    `${workspace}:${CONTAINER_WORKSPACE}:${request.trust === "trusted-write" ? "rw" : "ro"}`,
    "--volume",
    `${dshHome}:${CONTAINER_DSH_HOME}:rw`,
    "--volume",
    `${patchPath}:${CONTAINER_PATCH}:ro`,
    "--volume",
    `${toolPolicyPath}:${CONTAINER_TOOL_POLICY}:ro`,
    "--volume",
    `${packageRoot}:${CONTAINER_PACKAGE_ROOT}:ro`,
    "--workdir",
    CONTAINER_WORKSPACE,
  ];
  for (const [name, value] of Object.entries(containerEnvironment(proxy, request.trust))) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(
    request.containerImage,
    "node",
    "--expose-internals",
    CONTAINER_DSH_BIN,
    "--profile",
    "headless",
    "--patch",
    CONTAINER_PATCH,
    "--patch",
    CONTAINER_TOOL_POLICY,
    prompt,
  );

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
      "2g",
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
      "--save=false",
      "--loglevel=error",
      `@deepseek-ai/dsh@${request.dshVersion}`,
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

function isolationReport(request: DshRunRequest): DshIsolationReport {
  const repoToolsEnabled = effectiveWorkspaceTools(request).length > 0;
  if (request.isolation === "docker") {
    return {
      backend: "docker",
      credentialMediated: true,
      repoToolsEnabled,
      processIsolated: true,
      networkIsolated: false,
      workspaceAccess: request.trust === "trusted-write" ? "read-write" : "read-only",
      limitations: [
        "The worker uses a Docker bridge to reach the controller proxy; destination-level egress isolation is not yet enforced.",
        "The configured container image is supplied by the workflow and should be pinned by digest.",
        "The pinned DSH npm package is installed inside the ephemeral container at run time.",
      ],
    };
  }
  return {
    backend: "none",
    credentialMediated: true,
    repoToolsEnabled,
    processIsolated: false,
    networkIsolated: false,
    workspaceAccess: request.trust === "trusted-write" ? "read-write" : "read-only",
    limitations: [
      "No operating-system or container boundary surrounds the DSH process.",
      "DSH may load a repository .env during bootstrap; controller-provided security variables take precedence.",
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
  return [...new Set([request.apiKey, ...collectControllerSecrets(environment)])].filter(
    (secret) => secret.length >= 4,
  );
}

/** Execute one DSH headless turn behind a controller-side credential proxy. */
export async function runDsh(
  request: DshRunRequest,
  dependencies: DshRunDependencies = {},
): Promise<DshRunResult> {
  assertSupportedDshVersion(request.dshVersion);
  positiveInteger(request.timeoutMs, "timeoutMs");
  positiveInteger(request.maxOutputBytes, "maxOutputBytes");
  if (request.apiKey.trim() === "") throw new DshConfigurationError("apiKey must be non-empty");
  if (request.isolation === "none" && request.trust === "untrusted") {
    throw new DshIsolationUnavailableError("Untrusted DSH execution requires Docker isolation");
  }
  if (request.trust === "trusted-write" && request.isolation !== "docker") {
    throw new DshIsolationUnavailableError("Trusted-write DSH execution requires Docker isolation");
  }
  if (request.trust === "trusted-write") assertPinnedContainerImage(request.containerImage);

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
  let proxy: DeepSeekProxyHandle | undefined;
  const secrets = controllerSecrets(request, environment);
  try {
    const docker = request.isolation === "docker";
    const proxyFactory = dependencies.startProxy ?? startDeepSeekProxy;
    proxy = await proxyFactory({
      apiKey: request.apiKey,
      baseUrl: request.baseUrl,
      bindHost: docker ? "0.0.0.0" : "127.0.0.1",
      workerHost: docker ? "host.docker.internal" : "127.0.0.1",
      requestTimeoutMs: request.timeoutMs,
      maxResponseBytes: request.maxOutputBytes,
    });

    const localDshHome = runtime.dshHome;
    const packageRoot = runtime.packageRoot;
    const toolPolicyPath = await writeToolPolicy(runtime, request);
    const workerEnvironment = buildDshWorkerEnvironment({
      source: environment,
      dshHome: localDshHome,
      permissionMode: request.trust === "trusted-write" ? "workspace-write" : "read-only",
      proxyBaseUrl: proxy.workerBaseUrl,
      proxyToken: proxy.workerToken,
      realDeepSeekApiKey: request.apiKey,
    });
    assertSecretAbsent(workerEnvironment, request.apiKey, "real DeepSeek API key");

    const execute =
      dependencies.executeProcess ??
      ((processSpec, limits) => executeBoundedDshProcess(processSpec, limits, platform));
    if (docker && runtime.installedVersion === undefined) {
      const elapsedBeforeInstall = Math.max(0, now() - startedAt);
      const installRemainingMs = request.timeoutMs - elapsedBeforeInstall;
      if (installRemainingMs <= 0) throw new DshTimeoutError(request.timeoutMs);
      let installResult: DshProcessResult;
      try {
        installResult = await execute(
          dockerInstallSpec(request, workspace, packageRoot, environment),
          {
            timeoutMs: installRemainingMs,
            maxStdoutBytes: request.maxOutputBytes,
            maxStderrBytes: Math.min(request.maxOutputBytes, MAX_STDERR_BYTES),
            maxCombinedBytes: request.maxOutputBytes,
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
        );
      } catch (error: unknown) {
        if (error instanceof DshSpawnError) {
          throw new DshIsolationUnavailableError("Docker could not be started", { cause: error });
        }
        throw error;
      }
      if (installResult.exitCode !== 0 || installResult.signal !== null) {
        throw new DshProcessError(
          installResult.exitCode,
          installResult.signal,
          redactKnownSecrets(installResult.stderr.trim(), secrets),
        );
      }
      runtime.installedVersion = request.dshVersion;
    }

    const spec = docker
      ? dockerSpec(
          request,
          workspace,
          localDshHome,
          packageRoot,
          patchPath,
          toolPolicyPath,
          prompt,
          environment,
          workerEnvironment,
          proxy,
        )
      : localSpec(request, workspace, patchPath, toolPolicyPath, prompt, workerEnvironment);
    assertSecretAbsent(spec.env, request.apiKey, "real DeepSeek API key");
    if (spec.args.some((argument) => argument.includes(request.apiKey))) {
      throw new DshConfigurationError("Real DeepSeek API key was found in DSH argv");
    }

    const elapsedBeforeSpawn = Math.max(0, now() - startedAt);
    const remainingMs = request.timeoutMs - elapsedBeforeSpawn;
    if (remainingMs <= 0) throw new DshTimeoutError(request.timeoutMs);

    let processResult: DshProcessResult;
    try {
      processResult = await execute(spec, {
        timeoutMs: remainingMs,
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

    assertNoSecretOutput("stdout", processResult.stdout, secrets);
    assertNoSecretOutput("stderr", processResult.stderr, secrets);
    if (processResult.exitCode !== 0 || processResult.signal !== null) {
      throw new DshProcessError(
        processResult.exitCode,
        processResult.signal,
        redactKnownSecrets(processResult.stderr.trim(), secrets),
      );
    }

    const output = parseDshOutput(processResult.stdout, request.operation);
    return {
      output,
      rawStdout: processResult.stdout,
      durationMs: Math.max(0, now() - startedAt),
      isolationReport: isolationReport(request),
    };
  } finally {
    try {
      await proxy?.close();
    } finally {
      if (ownsRuntime) await disposeDshRuntime(runtime);
    }
  }
}
