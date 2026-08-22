const MAX_REASON_COUNT = 4;
const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const RUNTIME_DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const MANIFEST_CONTROL_KEYS = [
  "ava",
  "babel",
  "bin",
  "browserslist",
  "bundledDependencies",
  "bundleDependencies",
  "c8",
  "config",
  "cpu",
  "devEngines",
  "engines",
  "eslintConfig",
  "eslintIgnore",
  "exports",
  "imports",
  "jest",
  "main",
  "mocha",
  "module",
  "nyc",
  "os",
  "peerDependenciesMeta",
  "pnpm",
  "prettier",
  "stylelint",
  "ts-node",
  "type",
  "vitest",
  "volta",
  "workspaces",
  "xo",
] as const;

const LOCK_EXECUTION_KEYS = [
  "bin",
  "bundleDependencies",
  "bundledDependencies",
  "dependencies",
  "dev",
  "devOptional",
  "engines",
  "hasInstallScript",
  "inBundle",
  "optional",
  "optionalDependencies",
  "os",
  "cpu",
  "peerDependencies",
  "peerDependenciesMeta",
] as const;

export interface ManifestControlChanges {
  readonly keys: readonly string[];
  readonly reasons: readonly string[];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nested(object: Record<string, unknown>, ...path: readonly string[]): unknown {
  let current: unknown = object;
  for (const part of path) current = jsonObject(current)?.[part];
  return current;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const object = jsonObject(value);
  if (object !== undefined) {
    return `{${Object.keys(object)
      .sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function dependencyMap(value: unknown): Readonly<Record<string, unknown>> {
  return jsonObject(value) ?? {};
}

function boundedReasons(reasons: readonly string[]): readonly string[] {
  return [...new Set(reasons)].slice(0, MAX_REASON_COUNT);
}

/** Detect replacement/removal of an existing validator dependency, not benign additions. */
export function dependencyReplacementReasons(
  baselineText: string | undefined,
  candidateText: string | undefined,
): readonly string[] {
  if (baselineText === undefined) return [];
  if (candidateText === undefined) return ["The validation package manifest was deleted"];
  const baseline = jsonObject(parseJson(baselineText));
  const candidate = jsonObject(parseJson(candidateText));
  if (baseline === undefined || candidate === undefined) {
    return ["The validation package manifest could not be parsed reliably"];
  }
  const reasons: string[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const before = dependencyMap(baseline[section]);
    const after = dependencyMap(candidate[section]);
    for (const [name, version] of Object.entries(before)) {
      if (!(name in after)) {
        reasons.push(`Validation dependency ${name} was removed from ${section}`);
      } else if (stableJson(version) !== stableJson(after[name])) {
        reasons.push(`Validation dependency ${name} was replaced in ${section}`);
      }
    }
  }
  for (const key of ["overrides", "resolutions", "packageManager"] as const) {
    if (stableJson(baseline[key]) !== stableJson(candidate[key])) {
      reasons.push(`Validation package control ${key} changed`);
    }
  }
  if (
    stableJson(nested(baseline, "pnpm", "overrides")) !==
    stableJson(nested(candidate, "pnpm", "overrides"))
  ) {
    reasons.push("Validation package control pnpm.overrides changed");
  }
  return boundedReasons(reasons);
}

/** Detect package.json fields that can change validator discovery or execution. */
export function manifestControlChanges(
  baselineText: string | undefined,
  candidateText: string | undefined,
): ManifestControlChanges {
  if (baselineText === undefined && candidateText === undefined) {
    return { keys: [], reasons: [] };
  }
  if (baselineText === undefined) {
    const candidate = jsonObject(parseJson(candidateText ?? ""));
    const keys =
      candidate === undefined
        ? []
        : MANIFEST_CONTROL_KEYS.filter((key) => Object.hasOwn(candidate, key));
    return {
      keys,
      reasons: boundedReasons([
        "The validation package manifest was added",
        ...keys.map((key) => `Validation package control ${key} was added`),
      ]),
    };
  }
  if (candidateText === undefined) {
    return { keys: [], reasons: ["The validation package manifest was deleted"] };
  }
  const baseline = jsonObject(parseJson(baselineText));
  const candidate = jsonObject(parseJson(candidateText));
  if (baseline === undefined || candidate === undefined) {
    return {
      keys: [],
      reasons: ["The validation package manifest could not be parsed reliably"],
    };
  }
  const keys = MANIFEST_CONTROL_KEYS.filter(
    (key) => stableJson(baseline[key]) !== stableJson(candidate[key]),
  );
  return {
    keys,
    reasons: boundedReasons(keys.map((key) => `Validation package control ${key} changed`)),
  };
}

function hasBaselinePackageAncestor(
  path: string,
  baselinePackages: Readonly<Record<string, unknown>>,
): boolean {
  let boundary = path.lastIndexOf("/node_modules/");
  while (boundary !== -1) {
    if (Object.hasOwn(baselinePackages, path.slice(0, boundary))) return true;
    boundary = path.lastIndexOf("/node_modules/", boundary - 1);
  }
  return false;
}

function lockResolutionCandidates(ownerPath: string, dependencyName: string): readonly string[] {
  const candidates: string[] = [];
  let owner = ownerPath;
  for (;;) {
    candidates.push(
      owner === "" ? `node_modules/${dependencyName}` : `${owner}/node_modules/${dependencyName}`,
    );
    if (owner === "") break;
    const nestedBoundary = owner.lastIndexOf("/node_modules/");
    owner = nestedBoundary === -1 ? "" : owner.slice(0, nestedBoundary);
  }
  return [...new Set(candidates)];
}

function resolveLockEdge(
  packages: Readonly<Record<string, unknown>>,
  ownerPath: string,
  dependencyName: string,
): string | undefined {
  return lockResolutionCandidates(ownerPath, dependencyName).find((path) =>
    Object.hasOwn(packages, path),
  );
}

function baselineReachablePackagePaths(
  baselinePackages: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const reachable = new Set<string>([""]);
  const pending = [""];
  while (pending.length > 0) {
    const ownerPath = pending.shift();
    if (ownerPath === undefined) continue;
    const ownerPackage = jsonObject(baselinePackages[ownerPath]);
    if (ownerPackage === undefined) continue;
    const sections = ownerPath === "" ? DEPENDENCY_SECTIONS : RUNTIME_DEPENDENCY_SECTIONS;
    for (const section of sections) {
      for (const dependencyName of Object.keys(dependencyMap(ownerPackage[section]))) {
        const target = resolveLockEdge(baselinePackages, ownerPath, dependencyName);
        if (target === undefined || reachable.has(target)) continue;
        reachable.add(target);
        pending.push(target);
      }
    }
  }
  return reachable;
}

function newlyMaterializedLockEdgeReasons(
  baselinePackages: Readonly<Record<string, unknown>>,
  candidatePackages: Readonly<Record<string, unknown>>,
): readonly string[] {
  const reasons: string[] = [];
  for (const ownerPath of baselineReachablePackagePaths(baselinePackages)) {
    const ownerPackage = jsonObject(baselinePackages[ownerPath]);
    if (ownerPackage === undefined) continue;
    for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
      for (const dependencyName of Object.keys(dependencyMap(ownerPackage[section]))) {
        const baselineTarget = resolveLockEdge(baselinePackages, ownerPath, dependencyName);
        const candidateTarget = resolveLockEdge(candidatePackages, ownerPath, dependencyName);
        if (
          baselineTarget === undefined &&
          candidateTarget !== undefined &&
          !Object.hasOwn(baselinePackages, candidateTarget)
        ) {
          reasons.push(
            `Validation lock newly materialized ${section} ${dependencyName} for ${ownerPath || "<root>"}`,
          );
          if (reasons.length >= MAX_REASON_COUNT) return reasons;
        }
      }
    }
  }
  return reasons;
}

function lockPackageReplacementReasons(
  baselinePackages: Readonly<Record<string, unknown>>,
  candidatePackages: Readonly<Record<string, unknown>>,
): readonly string[] {
  const reasons: string[] = [];
  for (const [path, baselineValue] of Object.entries(baselinePackages)) {
    const candidateValue = candidatePackages[path];
    if (candidateValue === undefined) {
      reasons.push(`Validation lock package ${path || "<root>"} was removed`);
      continue;
    }
    const baselinePackage = jsonObject(baselineValue);
    const candidatePackage = jsonObject(candidateValue);
    if (baselinePackage === undefined || candidatePackage === undefined) {
      if (stableJson(baselineValue) !== stableJson(candidateValue)) {
        reasons.push(`Validation lock package ${path || "<root>"} was replaced`);
      }
      continue;
    }
    for (const key of ["version", "resolved", "integrity", "link"] as const) {
      if (stableJson(baselinePackage[key]) !== stableJson(candidatePackage[key])) {
        reasons.push(`Validation lock package ${path || "<root>"} changed ${key}`);
      }
    }
    for (const key of LOCK_EXECUTION_KEYS) {
      if (
        path === "" &&
        ["dependencies", "optionalDependencies", "peerDependencies"].includes(key)
      ) {
        continue;
      }
      if (stableJson(baselinePackage[key]) !== stableJson(candidatePackage[key])) {
        reasons.push(`Validation lock package ${path || "<root>"} changed ${key}`);
      }
    }
    if (path === "") {
      for (const section of DEPENDENCY_SECTIONS) {
        const before = dependencyMap(baselinePackage[section]);
        const after = dependencyMap(candidatePackage[section]);
        for (const [name, version] of Object.entries(before)) {
          if (!(name in after) || stableJson(version) !== stableJson(after[name])) {
            reasons.push(`Validation lock root dependency ${name} was replaced`);
          }
        }
      }
    }
    if (reasons.length >= MAX_REASON_COUNT) break;
  }
  if (reasons.length < MAX_REASON_COUNT) {
    for (const path of Object.keys(candidatePackages)) {
      if (
        !Object.hasOwn(baselinePackages, path) &&
        hasBaselinePackageAncestor(path, baselinePackages)
      ) {
        reasons.push(`Validation lock added nested package ${path} under an existing toolchain`);
        if (reasons.length >= MAX_REASON_COUNT) break;
      }
    }
  }
  if (reasons.length < MAX_REASON_COUNT) {
    reasons.push(
      ...newlyMaterializedLockEdgeReasons(baselinePackages, candidatePackages).slice(
        0,
        MAX_REASON_COUNT - reasons.length,
      ),
    );
  }
  return boundedReasons(reasons);
}

/** Detect lock replacement; unsupported/malformed lock formats fail closed. */
export function lockReplacementReasons(
  baselineText: string | undefined,
  candidateText: string | undefined,
): readonly string[] {
  if (baselineText === undefined) return [];
  if (candidateText === undefined) return ["The validation dependency lock was deleted"];
  const baseline = jsonObject(parseJson(baselineText));
  const candidate = jsonObject(parseJson(candidateText));
  if (baseline === undefined || candidate === undefined) {
    return ["The validation dependency lock could not be parsed reliably"];
  }
  if (stableJson(baseline.lockfileVersion) !== stableJson(candidate.lockfileVersion)) {
    return ["The validation dependency lock format changed"];
  }
  const packageReasons = lockPackageReplacementReasons(
    dependencyMap(baseline.packages),
    dependencyMap(candidate.packages),
  );
  if (packageReasons.length > 0) return packageReasons;
  const baselineDependencies = dependencyMap(baseline.dependencies);
  const candidateDependencies = dependencyMap(candidate.dependencies);
  if (stableJson(baselineDependencies) !== stableJson(candidateDependencies)) {
    return ["The legacy validation dependency lock graph changed"];
  }
  return [];
}
