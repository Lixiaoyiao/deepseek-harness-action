import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { assertNoGitHubCredentials } from "../security/env.js";
import { CONTROLLED_PROFILE_NAME } from "../extensions/profile.js";
import { DshConfigurationError } from "./errors.js";
import type { DshProcessSpec } from "./process.js";
import type { DeepSeekProxyHandle } from "./proxy.js";
import type { DshDockerLaunchPlan } from "./composition.js";

const CONTAINER_IMAGE_REFERENCE_PATTERN =
  /^(?=.{1,512}$)[A-Za-z0-9][A-Za-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/u;
const PINNED_CONTAINER_IMAGE_PATTERN =
  /^(?=.{1,512}$)[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;

export const CONTAINER_WORKSPACE = "/workspace";
export const CONTAINER_DSH_HOME = "/dsh-home";
export const CONTAINER_PACKAGE_ROOT = "/opt/dsh-action/package";
export const CONTAINER_LAUNCHER = `${CONTAINER_PACKAGE_ROOT}/action-launcher.mjs`;
export const CONTAINER_PROFILE_ROOT = `${CONTAINER_DSH_HOME}/profiles/${CONTROLLED_PROFILE_NAME}`;
export const CONTAINER_POLICY_PLUGIN = "/opt/dsh-action/action-policy.mjs";
export const CONTAINER_WORKSPACE_PLUGIN = "/opt/dsh-action/action-workspace.mjs";
export const CONTAINER_ACTION_STATE = `${CONTAINER_DSH_HOME}/action-state`;
export const CONTAINER_SESSIONS = `${CONTAINER_DSH_HOME}/sessions`;
export const CONTAINER_ATTACHMENTS = `${CONTAINER_DSH_HOME}/attachments`;
export const CONTAINER_STATE = `${CONTAINER_ACTION_STATE}/tool-counts.json`;
export const CONTAINER_AUDIT = `${CONTAINER_ACTION_STATE}/tool-receipts.jsonl`;

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

function hostUserForContainer(): string {
  return process.platform === "win32"
    ? "0:0"
    : `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
}

export function dockerControllerEnvironment(
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
    ...(proxy.workerWebSearchBaseUrl === undefined
      ? {}
      : { DEEPSEEK_SEARCH_BASE_URL: proxy.workerWebSearchBaseUrl }),
  };
}

interface DockerWorkerSpecOptions {
  readonly containerImage: string;
  readonly dshExecutable?: string;
  readonly workspace: string;
  readonly dshHome: string;
  readonly packageRoot: string;
  readonly launchPlan: DshDockerLaunchPlan;
  readonly networkName: string;
  readonly hostGateway: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly workerEnvironment: NodeJS.ProcessEnv;
  readonly proxy: DeepSeekProxyHandle;
  readonly workspaceWrite: boolean;
}

export function dockerWorkerSpec(options: DockerWorkerSpecOptions): DshProcessSpec {
  assertContainerImageReference(options.containerImage);
  if (options.dshExecutable !== undefined && options.dshExecutable !== "") {
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
    options.networkName,
    "--add-host",
    `host.docker.internal:${options.hostGateway}`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=536870912",
    "--volume",
    `${options.workspace}:${CONTAINER_WORKSPACE}:${options.workspaceWrite ? "rw" : "ro"}`,
    "--volume",
    `${options.dshHome}:${CONTAINER_DSH_HOME}:ro`,
    "--volume",
    `${join(options.dshHome, "action-state")}:${CONTAINER_ACTION_STATE}:rw`,
    "--volume",
    `${join(options.dshHome, "sessions")}:${CONTAINER_SESSIONS}:rw`,
    "--volume",
    `${join(options.dshHome, "attachments")}:${CONTAINER_ATTACHMENTS}:rw`,
    "--volume",
    `${options.packageRoot}:${CONTAINER_PACKAGE_ROOT}:ro`,
    "--workdir",
    options.launchPlan.workdir,
  ];
  for (const mount of options.launchPlan.mounts) {
    if (
      !isAbsolute(mount.sourcePath) ||
      !mount.destinationPath.startsWith("/") ||
      mount.sourcePath.includes("\0") ||
      mount.destinationPath.includes("\0")
    ) {
      throw new DshConfigurationError("DSH composition supplied an invalid Docker mount");
    }
    args.push(
      "--volume",
      `${mount.sourcePath}:${mount.destinationPath}:${mount.readOnly ? "ro" : "rw"}`,
    );
  }
  for (const [name, value] of Object.entries(
    containerEnvironment(options.proxy, options.workspaceWrite),
  )) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(options.containerImage, options.launchPlan.command, ...options.launchPlan.args);

  const nameIndex = args.indexOf("--name") + 1;
  const containerName = args[nameIndex];
  if (containerName === undefined) {
    throw new DshConfigurationError("Docker container name is missing");
  }
  const controllerEnv = dockerControllerEnvironment(options.environment, options.workerEnvironment);
  return {
    command: "docker",
    args,
    cwd: options.workspace,
    env: controllerEnv,
    termination: {
      command: "docker",
      args: ["kill", containerName],
      cwd: options.workspace,
      env: controllerEnv,
    },
  };
}

interface DockerInstallerSpecOptions {
  readonly kind: "runtime" | "extension";
  readonly containerImage: string;
  readonly workspace: string;
  readonly packageRoot: string;
  readonly npmCache: string;
  readonly environment: NodeJS.ProcessEnv;
}

export function dockerInstallerSpec(options: DockerInstallerSpecOptions): DshProcessSpec {
  const containerName = `dsh-action-${options.kind === "runtime" ? "install" : "extension-install"}-${randomUUID()}`;
  const controllerEnv = dockerControllerEnvironment(options.environment, {});
  const npmArgs =
    options.kind === "runtime"
      ? ["ci", "--no-audit", "--no-fund", "--omit=dev", "--ignore-scripts", "--loglevel=error"]
      : [
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
        ];
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
      `${options.packageRoot}:${CONTAINER_PACKAGE_ROOT}:rw`,
      "--volume",
      `${options.npmCache}:/tmp/npm-cache:rw`,
      "--workdir",
      CONTAINER_PACKAGE_ROOT,
      "--env",
      "HOME=/tmp",
      "--env",
      "npm_config_cache=/tmp/npm-cache",
      ...(options.kind === "runtime" ? ["--env", "NODE_OPTIONS=--max-old-space-size=3072"] : []),
      options.containerImage,
      "npm",
      ...npmArgs,
    ],
    cwd: options.workspace,
    env: controllerEnv,
    termination: {
      command: "docker",
      args: ["kill", containerName],
      cwd: options.workspace,
      env: controllerEnv,
    },
  };
}
