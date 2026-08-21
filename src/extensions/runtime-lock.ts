import { createHash } from "node:crypto";

import { DshConfigurationError } from "../dsh/errors.js";

const MAX_RUNTIME_LOCK_BYTES = 32 * 1024 * 1024;
const SHA512_INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const PINNED_GITHUB_HTTPS_RESOLUTION_PATTERN =
  /^git\+https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git#([0-9a-f]{40})$/u;
const PINNED_GITHUB_NPM_SSH_RESOLUTION_PATTERN =
  /^git\+ssh:\/\/git@github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\.git#([0-9a-f]{40})$/u;

type JsonRecord = Readonly<Record<string, unknown>>;

export interface ExtensionRuntimeLockAudit {
  readonly schemaVersion: 1;
  readonly algorithm: "sha256";
  /** Digest of the complete, canonical package-lock.json, including resolved and integrity. */
  readonly digest: string;
  readonly lockfileVersion: 3;
  /** All non-root package entries in the resulting runtime lock. */
  readonly packageCount: number;
  /** Package entries added to the Controller baseline by the allowed extensions. */
  readonly extensionPackageCount: number;
}

/** Opaque Controller snapshot captured before any third-party package is installed. */
export interface RuntimeLockBaseline {
  readonly lockfileVersion: 3;
  readonly topLevelMetadata: string;
  readonly rootMetadata: string;
  readonly rootDependencies: Readonly<Record<string, string>>;
  readonly packageEntries: Readonly<Record<string, string>>;
  readonly topLevelPackageNames: readonly string[];
}

export interface AuditExtensionRuntimeLockOptions {
  readonly lockText: string;
  readonly baseline: RuntimeLockBaseline;
  readonly extensionDependencies: Readonly<Record<string, string>>;
  readonly expectedRootName: string;
}

interface ParsedRuntimeLock {
  readonly document: JsonRecord;
  readonly packages: Readonly<Record<string, JsonRecord>>;
  readonly root: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DshConfigurationError("Runtime lock contains a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new DshConfigurationError("Runtime lock contains a non-JSON value");
}

function withoutKeys(value: JsonRecord, excluded: ReadonlySet<string>): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !excluded.has(key)));
}

function stringMap(value: unknown, description: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) throw new DshConfigurationError(`${description} must be an object`);
  const result = Object.create(null) as Record<string, string>;
  for (const [name, source] of Object.entries(value)) {
    if (typeof source !== "string" || source.length === 0) {
      throw new DshConfigurationError(`${description}.${name} must be a non-empty string`);
    }
    result[name] = source;
  }
  return Object.freeze(result);
}

function validPackageLockPath(path: string): boolean {
  if (path === "" || path.includes("\\") || path.startsWith("/") || path.endsWith("/")) {
    return path === "";
  }
  const parts = path.split("/");
  let index = 0;
  while (index < parts.length) {
    if (parts[index] !== "node_modules") return false;
    const name = parts[index + 1];
    if (name === undefined || name === "" || name === "." || name === "..") return false;
    if (name.startsWith("@")) {
      const scopedName = parts[index + 2];
      if (
        name.length === 1 ||
        scopedName === undefined ||
        scopedName === "" ||
        scopedName === "." ||
        scopedName === ".."
      ) {
        return false;
      }
      index += 3;
    } else {
      index += 2;
    }
  }
  return true;
}

function packageParentPath(path: string): string | undefined {
  const marker = path.lastIndexOf("/node_modules/");
  return marker < 0 ? undefined : path.slice(0, marker);
}

function validIntegrity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.split(/\s+/u).every((token) => {
      if (!SHA512_INTEGRITY_PATTERN.test(token)) return false;
      const encoded = token.slice("sha512-".length);
      const digest = Buffer.from(encoded, "base64");
      return digest.byteLength === 64 && digest.toString("base64") === encoded;
    })
  );
}

/**
 * npm normalizes an exact git+https GitHub dependency to git+ssh://git@github.com in
 * package-lock.json. Accept only those two immutable spellings and compare their canonical
 * repository/commit identity; no generic SSH URL, alternate user, host, port, or mutable ref is
 * allowed.
 */
function pinnedGitHubResolutionIdentity(
  resolved: string,
  allowNpmSshNormalization: boolean,
): string | undefined {
  const match =
    PINNED_GITHUB_HTTPS_RESOLUTION_PATTERN.exec(resolved) ??
    (allowNpmSshNormalization ? PINNED_GITHUB_NPM_SSH_RESOLUTION_PATTERN.exec(resolved) : null);
  if (match === null) return undefined;
  const [, owner, repository, commit] = match;
  if (owner === undefined || repository === undefined || commit === undefined) return undefined;
  return `${owner.toLowerCase()}/${repository.toLowerCase()}#${commit}`;
}

function validateHttpsResolution(resolved: string, integrity: unknown, path: string): void {
  let url: URL;
  try {
    url = new URL(resolved);
  } catch (error: unknown) {
    throw new DshConfigurationError(`Runtime lock package ${path} has an invalid resolved URL`, {
      cause: error,
    });
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") {
    throw new DshConfigurationError(
      `Runtime lock package ${path} must use an unauthenticated HTTPS tarball URL without a fragment`,
    );
  }
  if (!validIntegrity(integrity)) {
    throw new DshConfigurationError(
      `Runtime lock package ${path} must include a sha512 integrity value`,
    );
  }
}

function validateResolvedPackage(
  path: string,
  entry: JsonRecord,
  packages: Readonly<Record<string, JsonRecord>>,
): void {
  if (typeof entry.version !== "string" || entry.version.length === 0) {
    throw new DshConfigurationError(`Runtime lock package ${path} has no exact version`);
  }
  if (entry.link !== undefined && typeof entry.link !== "boolean") {
    throw new DshConfigurationError(`Runtime lock package ${path} has an invalid link marker`);
  }
  if (entry.link === true) {
    throw new DshConfigurationError(`Runtime lock package ${path} must not be a mutable link`);
  }
  if (entry.inBundle !== undefined && typeof entry.inBundle !== "boolean") {
    throw new DshConfigurationError(`Runtime lock package ${path} has an invalid inBundle marker`);
  }

  if (typeof entry.resolved === "string" && entry.resolved.startsWith("git+")) {
    if (pinnedGitHubResolutionIdentity(entry.resolved, true) === undefined) {
      throw new DshConfigurationError(
        `Runtime lock package ${path} must pin a supported GitHub resolution to a 40-character commit`,
      );
    }
    if (entry.integrity !== undefined && !validIntegrity(entry.integrity)) {
      throw new DshConfigurationError(
        `Runtime lock package ${path} has an invalid integrity value`,
      );
    }
    return;
  }

  if (typeof entry.resolved === "string" && entry.resolved.length > 0) {
    validateHttpsResolution(entry.resolved, entry.integrity, path);
    return;
  }

  const parentPath = packageParentPath(path);
  if (entry.inBundle === true && parentPath !== undefined && packages[parentPath] !== undefined) {
    return;
  }
  throw new DshConfigurationError(
    `Runtime lock package ${path} has neither an immutable resolution nor bundled provenance`,
  );
}

function parseRuntimeLock(lockText: string): ParsedRuntimeLock {
  if (Buffer.byteLength(lockText, "utf8") > MAX_RUNTIME_LOCK_BYTES) {
    throw new DshConfigurationError(
      `Runtime package-lock.json exceeds ${String(MAX_RUNTIME_LOCK_BYTES)} bytes`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lockText) as unknown;
  } catch (error: unknown) {
    throw new DshConfigurationError("Runtime package-lock.json is not valid JSON", {
      cause: error,
    });
  }
  if (!isRecord(parsed)) {
    throw new DshConfigurationError("Runtime package-lock.json must contain an object");
  }
  if (parsed.lockfileVersion !== 3) {
    throw new DshConfigurationError("Runtime package-lock.json must use lockfileVersion 3");
  }
  if (!isRecord(parsed.packages)) {
    throw new DshConfigurationError("Runtime package-lock.json must contain a packages graph");
  }
  const packages: Record<string, JsonRecord> = {};
  for (const [path, entry] of Object.entries(parsed.packages)) {
    if (!validPackageLockPath(path)) {
      throw new DshConfigurationError(`Runtime lock contains an invalid package path: ${path}`);
    }
    if (!isRecord(entry)) {
      throw new DshConfigurationError(`Runtime lock package ${path || "<root>"} must be an object`);
    }
    packages[path] = entry;
  }
  const root = packages[""];
  if (root === undefined) {
    throw new DshConfigurationError("Runtime package-lock.json has no root package entry");
  }
  for (const [path, entry] of Object.entries(packages)) {
    if (path !== "") validateResolvedPackage(path, entry, packages);
  }
  return { document: parsed, packages: Object.freeze(packages), root };
}

function directPackageName(path: string): string | undefined {
  const parts = path.split("/");
  if (parts.length === 2 && parts[0] === "node_modules") return parts[1];
  if (parts.length === 3 && parts[0] === "node_modules" && parts[1]?.startsWith("@")) {
    return parts.slice(1).join("/");
  }
  return undefined;
}

export function snapshotRuntimeLock(lockText: string): RuntimeLockBaseline {
  const parsed = parseRuntimeLock(lockText);
  const rootDependencies = stringMap(parsed.root.dependencies ?? {}, "Runtime lock dependencies");
  const packageEntries = Object.freeze(
    Object.fromEntries(
      Object.entries(parsed.packages)
        .filter(([path]) => path !== "")
        .map(([path, entry]) => [path, canonicalJson(entry)]),
    ),
  );
  const topLevelPackageNames = Object.keys(packageEntries)
    .map((path) => directPackageName(path))
    .filter((name): name is string => name !== undefined)
    .sort();
  return Object.freeze({
    lockfileVersion: 3,
    topLevelMetadata: canonicalJson(withoutKeys(parsed.document, new Set(["name", "packages"]))),
    rootMetadata: canonicalJson(withoutKeys(parsed.root, new Set(["name", "dependencies"]))),
    rootDependencies,
    packageEntries,
    topLevelPackageNames: Object.freeze(topLevelPackageNames),
  });
}

/** Reject extension package names that would reuse any Controller-locked top-level path. */
export function assertExtensionPackagesAbsentFromRuntimeLock(
  baseline: RuntimeLockBaseline,
  extensionDependencies: Readonly<Record<string, string>>,
): void {
  const baselineNames = new Set(baseline.topLevelPackageNames);
  const collision = Object.keys(extensionDependencies).find((name) => baselineNames.has(name));
  if (collision !== undefined) {
    throw new DshConfigurationError(
      `Extension package ${collision} would shadow a Controller-owned package-lock entry`,
    );
  }
}

function assertBaselineEntriesUnchanged(
  parsed: ParsedRuntimeLock,
  baseline: RuntimeLockBaseline,
): void {
  const topLevelMetadata = canonicalJson(
    withoutKeys(parsed.document, new Set(["name", "packages"])),
  );
  if (topLevelMetadata !== baseline.topLevelMetadata) {
    throw new DshConfigurationError("Extension installation changed Controller lockfile metadata");
  }
  const rootMetadata = canonicalJson(withoutKeys(parsed.root, new Set(["name", "dependencies"])));
  if (rootMetadata !== baseline.rootMetadata) {
    throw new DshConfigurationError("Extension installation changed Controller root lock metadata");
  }
  for (const [path, expected] of Object.entries(baseline.packageEntries)) {
    const installed = parsed.packages[path];
    if (installed === undefined || canonicalJson(installed) !== expected) {
      throw new DshConfigurationError(
        `Extension installation changed Controller package-lock entry ${path}`,
      );
    }
  }
}

function assertDirectExtensionLocks(
  parsed: ParsedRuntimeLock,
  baseline: RuntimeLockBaseline,
  extensionDependencies: Readonly<Record<string, string>>,
  expectedRootName: string,
): void {
  if (parsed.document.name !== expectedRootName || parsed.root.name !== expectedRootName) {
    throw new DshConfigurationError(
      "Runtime lock is not bound to the Controller-owned DSH Profile",
    );
  }
  assertExtensionPackagesAbsentFromRuntimeLock(baseline, extensionDependencies);
  const expectedDependencies = { ...baseline.rootDependencies, ...extensionDependencies };
  const installedDependencies = stringMap(
    parsed.root.dependencies ?? {},
    "Runtime lock dependencies",
  );
  if (canonicalJson(installedDependencies) !== canonicalJson(expectedDependencies)) {
    throw new DshConfigurationError(
      "Runtime lock root dependencies do not exactly match the Controller extension plan",
    );
  }

  for (const [packageName, source] of Object.entries(extensionDependencies)) {
    const path = `node_modules/${packageName}`;
    const entry = parsed.packages[path];
    if (entry === undefined) {
      throw new DshConfigurationError(`Runtime lock has no direct entry for ${packageName}`);
    }
    if (/^\d/u.test(source)) {
      if (entry.version !== source) {
        throw new DshConfigurationError(
          `Runtime lock resolved ${packageName} to ${String(entry.version)}, expected ${source}`,
        );
      }
    } else {
      const expectedIdentity = pinnedGitHubResolutionIdentity(source, false);
      const installedIdentity =
        typeof entry.resolved === "string"
          ? pinnedGitHubResolutionIdentity(entry.resolved, true)
          : undefined;
      if (expectedIdentity === undefined || installedIdentity !== expectedIdentity) {
        throw new DshConfigurationError(
          `Runtime lock did not preserve the pinned git source for ${packageName}`,
        );
      }
    }
  }
}

export function auditExtensionRuntimeLock(
  options: AuditExtensionRuntimeLockOptions,
): ExtensionRuntimeLockAudit {
  const parsed = parseRuntimeLock(options.lockText);
  assertBaselineEntriesUnchanged(parsed, options.baseline);
  assertDirectExtensionLocks(
    parsed,
    options.baseline,
    options.extensionDependencies,
    options.expectedRootName,
  );
  const canonical = canonicalJson(parsed.document);
  const packagePaths = Object.keys(parsed.packages).filter((path) => path !== "");
  const extensionPackageCount = packagePaths.filter(
    (path) => options.baseline.packageEntries[path] === undefined,
  ).length;
  return Object.freeze({
    schemaVersion: 1,
    algorithm: "sha256",
    digest: createHash("sha256").update(canonical, "utf8").digest("hex"),
    lockfileVersion: 3,
    packageCount: packagePaths.length,
    extensionPackageCount,
  });
}
