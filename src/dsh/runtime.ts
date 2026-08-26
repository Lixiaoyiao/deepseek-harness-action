import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

import type { ExtensionRuntimeLockAudit, RuntimeLockBaseline } from "../extensions/runtime-lock.js";
import { validatedControllerBaseUrl } from "./base-url.js";
import { DshConfigurationError } from "./errors.js";

export type DshRuntimeIsolation = "docker" | "none";
export const DSH_RUNTIME_PROFILE_NAME = "github-action" as const;

/** Controller-owned inputs that must remain fixed while a runtime is reused. */
export interface DshRuntimeBinding {
  readonly compositionId: string;
  readonly dshVersion: string;
  readonly containerImage: string;
  readonly isolation: DshRuntimeIsolation;
  readonly workspacePath: string;
  readonly chatBaseUrl: string;
  readonly webSearchProxy: boolean;
  readonly webSearchBaseUrl?: string;
  readonly dshExecutableIdentity?: string;
  readonly extensionConfigurationDigest: string;
  readonly nativeRuntimeTools: readonly string[];
  readonly workspaceWrite: boolean;
  readonly network: boolean;
  readonly profileSchemaVersion: number;
}

export interface DshRuntimeBindingState {
  readonly fingerprint: string;
  readonly binding: DshRuntimeBinding;
}

/** Run-scoped installation/home reused across fresh headless turns. */
export interface DshRuntime {
  readonly root: string;
  readonly dshHome: string;
  readonly packageRoot: string;
  /** Controller-installer-only npm cache. Never mount this into the Agent worker. */
  readonly npmCache: string;
  /** Immutable after the first successful call to bindDshRuntime. */
  readonly binding?: DshRuntimeBindingState;
  installedVersion?: string;
  installedExtensionDigest?: string;
  installedPackageInventory?: Readonly<Record<string, string>>;
  installedPackageLockBaseline?: RuntimeLockBaseline;
  installedExtensionRuntimeLock?: ExtensionRuntimeLockAudit;
  /** Controller-verified worker-side entries, safe to reuse only under binding. */
  verifiedPluginModuleSpecifiers?: Readonly<Record<string, string>>;
}

type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
interface JsonObject {
  readonly [key: string]: JsonValue;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function canonicalJson(value: JsonValue): string {
  const normalize = (candidate: JsonValue): JsonValue => {
    if (candidate === null || typeof candidate !== "object") return candidate;
    if (isJsonArray(candidate)) return candidate.map((item) => normalize(item));
    return Object.fromEntries(
      Object.entries(candidate)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  };
  return JSON.stringify(normalize(value));
}

function nonEmptyString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DshConfigurationError(`DSH runtime binding ${field} must be non-empty`);
  }
  return value;
}

function normalizedAbsolutePath(value: string, field: string): string {
  const path = nonEmptyString(value, field);
  if (!isAbsolute(path)) {
    throw new DshConfigurationError(`DSH runtime binding ${field} must be an absolute path`);
  }
  return normalize(path);
}

function normalizedBaseUrl(value: string, field: string): string {
  const raw = nonEmptyString(value, field);
  const base = validatedControllerBaseUrl(raw, `DSH runtime binding ${field}`);
  base.pathname = base.pathname.replace(/\/+$/u, "") || "/";
  base.search = "";
  base.hash = "";
  return base.href;
}

function normalizedBinding(binding: DshRuntimeBinding): DshRuntimeBinding {
  const compositionId = nonEmptyString(binding.compositionId, "compositionId");
  const dshVersion = nonEmptyString(binding.dshVersion, "dshVersion");
  const containerImage = nonEmptyString(binding.containerImage, "containerImage");
  const isolation: unknown = binding.isolation;
  if (isolation !== "docker" && isolation !== "none") {
    throw new DshConfigurationError("DSH runtime binding isolation must be either docker or none");
  }
  const workspacePath = normalizedAbsolutePath(binding.workspacePath, "workspacePath");
  const chatBaseUrl = normalizedBaseUrl(binding.chatBaseUrl, "chatBaseUrl");
  if (!/^[a-f0-9]{64}$/u.test(binding.extensionConfigurationDigest)) {
    throw new DshConfigurationError(
      "DSH runtime binding extensionConfigurationDigest must be a SHA-256 digest",
    );
  }
  if (!Array.isArray(binding.nativeRuntimeTools)) {
    throw new DshConfigurationError("DSH runtime binding nativeRuntimeTools must be an array");
  }
  const nativeRuntimeTools = [...new Set(binding.nativeRuntimeTools)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  if (
    nativeRuntimeTools.some(
      (tool) => typeof tool !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(tool),
    )
  ) {
    throw new DshConfigurationError(
      "DSH runtime binding nativeRuntimeTools contains an invalid runtime tool name",
    );
  }
  if (typeof binding.webSearchProxy !== "boolean") {
    throw new DshConfigurationError("DSH runtime binding webSearchProxy must be boolean");
  }
  if (binding.webSearchProxy !== (binding.webSearchBaseUrl !== undefined)) {
    throw new DshConfigurationError(
      "DSH runtime binding webSearchBaseUrl must be present exactly when the composition requires its proxy",
    );
  }
  const webSearchBaseUrl =
    binding.webSearchBaseUrl === undefined
      ? undefined
      : normalizedBaseUrl(binding.webSearchBaseUrl, "webSearchBaseUrl");
  if (isolation === "none" && binding.dshExecutableIdentity === undefined) {
    throw new DshConfigurationError(
      "DSH runtime binding dshExecutableIdentity is required for host isolation",
    );
  }
  if (isolation === "docker" && binding.dshExecutableIdentity !== undefined) {
    throw new DshConfigurationError("DSH runtime binding dshExecutableIdentity is host-only");
  }
  const dshExecutableIdentity =
    binding.dshExecutableIdentity === undefined
      ? undefined
      : normalizedAbsolutePath(binding.dshExecutableIdentity, "dshExecutableIdentity");
  if (typeof binding.workspaceWrite !== "boolean") {
    throw new DshConfigurationError("DSH runtime binding workspaceWrite must be boolean");
  }
  if (typeof binding.network !== "boolean") {
    throw new DshConfigurationError("DSH runtime binding network must be boolean");
  }
  if (!Number.isSafeInteger(binding.profileSchemaVersion) || binding.profileSchemaVersion <= 0) {
    throw new DshConfigurationError(
      "DSH runtime binding profileSchemaVersion must be a positive integer",
    );
  }
  return Object.freeze({
    compositionId,
    dshVersion,
    containerImage,
    isolation,
    workspacePath,
    chatBaseUrl,
    webSearchProxy: binding.webSearchProxy,
    ...(webSearchBaseUrl === undefined ? {} : { webSearchBaseUrl }),
    ...(dshExecutableIdentity === undefined ? {} : { dshExecutableIdentity }),
    extensionConfigurationDigest: binding.extensionConfigurationDigest,
    nativeRuntimeTools: Object.freeze(nativeRuntimeTools),
    workspaceWrite: binding.workspaceWrite,
    network: binding.network,
    profileSchemaVersion: binding.profileSchemaVersion,
  });
}

function bindingJson(binding: DshRuntimeBinding): JsonObject {
  return {
    compositionId: binding.compositionId,
    dshVersion: binding.dshVersion,
    containerImage: binding.containerImage,
    isolation: binding.isolation,
    workspacePath: binding.workspacePath,
    chatBaseUrl: binding.chatBaseUrl,
    webSearchProxy: binding.webSearchProxy,
    ...(binding.webSearchBaseUrl === undefined
      ? {}
      : { webSearchBaseUrl: binding.webSearchBaseUrl }),
    ...(binding.dshExecutableIdentity === undefined
      ? {}
      : { dshExecutableIdentity: binding.dshExecutableIdentity }),
    extensionConfigurationDigest: binding.extensionConfigurationDigest,
    nativeRuntimeTools: binding.nativeRuntimeTools,
    workspaceWrite: binding.workspaceWrite,
    network: binding.network,
    profileSchemaVersion: binding.profileSchemaVersion,
  };
}

/** Compute the stable identity used to authorize reuse of one run-scoped runtime. */
export function fingerprintDshRuntimeBinding(binding: DshRuntimeBinding): string {
  const normalized = normalizedBinding(binding);
  return createHash("sha256")
    .update(canonicalJson(bindingJson(normalized)), "utf8")
    .digest("hex");
}

function changedBindingFields(
  previous: DshRuntimeBinding,
  requested: DshRuntimeBinding,
): readonly string[] {
  const comparisons: readonly [keyof DshRuntimeBinding, boolean][] = [
    ["compositionId", previous.compositionId !== requested.compositionId],
    ["dshVersion", previous.dshVersion !== requested.dshVersion],
    ["containerImage", previous.containerImage !== requested.containerImage],
    ["isolation", previous.isolation !== requested.isolation],
    ["workspacePath", previous.workspacePath !== requested.workspacePath],
    ["chatBaseUrl", previous.chatBaseUrl !== requested.chatBaseUrl],
    ["webSearchProxy", previous.webSearchProxy !== requested.webSearchProxy],
    ["webSearchBaseUrl", previous.webSearchBaseUrl !== requested.webSearchBaseUrl],
    ["dshExecutableIdentity", previous.dshExecutableIdentity !== requested.dshExecutableIdentity],
    [
      "extensionConfigurationDigest",
      previous.extensionConfigurationDigest !== requested.extensionConfigurationDigest,
    ],
    [
      "nativeRuntimeTools",
      canonicalJson(previous.nativeRuntimeTools) !== canonicalJson(requested.nativeRuntimeTools),
    ],
    ["workspaceWrite", previous.workspaceWrite !== requested.workspaceWrite],
    ["network", previous.network !== requested.network],
    ["profileSchemaVersion", previous.profileSchemaVersion !== requested.profileSchemaVersion],
  ];
  return comparisons.filter(([, changed]) => changed).map(([field]) => field);
}

/**
 * Bind a runtime on first use and fail closed if a later turn changes any
 * authorization-relevant runtime or Profile input.
 */
export function bindDshRuntime(
  runtime: DshRuntime,
  requestedBinding: DshRuntimeBinding,
): DshRuntimeBindingState {
  const binding = normalizedBinding(requestedBinding);
  const fingerprint = fingerprintDshRuntimeBinding(binding);
  const current = runtime.binding;
  if (current !== undefined) {
    const currentBinding = normalizedBinding(current.binding);
    const currentFingerprint = fingerprintDshRuntimeBinding(currentBinding);
    if (current.fingerprint !== currentFingerprint) {
      throw new DshConfigurationError("Reused DSH runtime has an invalid binding fingerprint");
    }
    if (currentFingerprint !== fingerprint) {
      const changed = changedBindingFields(currentBinding, binding);
      throw new DshConfigurationError(
        `Reused DSH runtime binding changed: ${changed.join(", ") || "unknown field"}`,
      );
    }
    return current;
  }

  const state = Object.freeze({ fingerprint, binding });
  try {
    Object.defineProperty(runtime, "binding", {
      value: state,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  } catch (error: unknown) {
    throw new DshConfigurationError("DSH runtime binding could not be fixed on first use", {
      cause: error,
    });
  }
  return state;
}

export async function createDshRuntime(temporaryDirectory = tmpdir()): Promise<DshRuntime> {
  const root = await mkdtemp(join(temporaryDirectory, "dsh-action-"));
  const dshHome = join(root, "home");
  const packageRoot = join(dshHome, "profiles", DSH_RUNTIME_PROFILE_NAME);
  const npmCache = join(root, "npm-cache");
  const directoryResults = await Promise.allSettled(
    [
      packageRoot,
      npmCache,
      join(dshHome, "action-state"),
      join(dshHome, "sessions"),
      join(dshHome, "attachments"),
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  const failed = directoryResults.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failed !== undefined) {
    // All mkdir operations have settled before rollback, so none can recreate a
    // partially initialized runtime after the root is removed.
    await rm(root, { force: true, recursive: true }).catch(() => undefined);
    throw failed.reason;
  }
  return { root, dshHome, packageRoot, npmCache };
}

export async function disposeDshRuntime(runtime: DshRuntime): Promise<void> {
  await rm(runtime.root, { force: true, recursive: true });
}
