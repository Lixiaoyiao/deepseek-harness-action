import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import {
  dependencyReplacementReasons,
  lockReplacementReasons,
  manifestControlChanges,
} from "../validation/toolchain-integrity.js";
import {
  buildValidationCommandGraph,
  recordScripts,
  type PackageGraphDetail,
} from "../validation/validation-command-graph.js";

import {
  runValidationCommandsInDocker,
  ValidationFailureError,
  type ValidationResult,
} from "./validate.js";
import {
  isIgnoredGeneratedRootEntry,
  inspectWorkspaceChanges,
  type WorkspaceChanges,
  type WorkspaceSnapshot,
} from "./workspace.js";

export type ValidationIntegrityMode = "off" | "warn" | "strict";
export type ValidationIntegrityStatus = "clean" | "changed" | "warned" | "blocked";
export type ValidationDefinitionChangeType = "added" | "modified" | "deleted" | "renamed";
export type ValidationDefinitionCategory =
  | "entrypoint"
  | "test-source"
  | "test-config"
  | "lint-config"
  | "typecheck-config"
  | "build-config"
  | "validation-runtime";
export type ValidationDefinitionRisk = "informational" | "suspicious" | "dangerous";

export interface ValidationDefinitionChange {
  readonly path: string;
  readonly previousPath?: string;
  readonly change: ValidationDefinitionChangeType;
  readonly category: ValidationDefinitionCategory;
  readonly risk: ValidationDefinitionRisk;
  readonly controlPlane: boolean;
  readonly reasons: readonly string[];
}

export interface ValidationBaselineReplaySummary {
  readonly status: "passed" | "failed";
  readonly commandCount: number;
}

/** Bounded, JSON-safe Controller audit suitable for result-json and step summaries. */
export interface ValidationIntegritySummary {
  readonly schemaVersion: 1;
  readonly mode: ValidationIntegrityMode;
  readonly status: ValidationIntegrityStatus;
  readonly changeCount: number;
  readonly dangerousChangeCount: number;
  readonly controlPlaneChangeCount: number;
  readonly testChangeCount: number;
  readonly changes: readonly ValidationDefinitionChange[];
  readonly truncated: boolean;
  readonly baselineReplay?: ValidationBaselineReplaySummary;
}

export interface InspectValidationIntegrityInput {
  readonly snapshot: WorkspaceSnapshot;
  readonly changes: WorkspaceChanges;
  readonly commands: readonly (readonly string[])[];
  readonly mode: ValidationIntegrityMode;
  readonly maxReportedChanges?: number;
}

export type ValidationIntegrityRunner = (
  cwd: string,
  commands: readonly (readonly string[])[],
  containerImage: string,
  timeoutMs?: number,
  signal?: AbortSignal,
) => Promise<readonly ValidationResult[]>;

export interface ValidationBaselineReplayOptions {
  readonly containerImage: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly runner?: ValidationIntegrityRunner;
}

const defaultValidationIntegrityRunner: ValidationIntegrityRunner = async (
  cwd,
  commands,
  containerImage,
  timeoutMs,
  signal,
) =>
  await runValidationCommandsInDocker(cwd, commands, containerImage, timeoutMs, undefined, signal);

export interface EnforceValidationIntegrityInput {
  readonly snapshot: WorkspaceSnapshot;
  readonly commands: readonly (readonly string[])[];
  readonly audit: ValidationIntegritySummary;
  /** Omit only when the Controller deliberately wants classification-only strict enforcement. */
  readonly baselineReplay?: ValidationBaselineReplayOptions;
}

type ClassifiedChange = ValidationDefinitionChange;

const DEFAULT_MAX_REPORTED_CHANGES = 50;
const MAX_REPORTED_CHANGES = 200;
const MAX_REASON_COUNT = 4;

const TEST_FILE_PATTERN =
  /(?:^|\/)(?:__tests__|tests?|spec)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$|(?:^|\/)[^/]+_test\.(?:go|py|rb|rs)$|(?:^|\/)test_[^/]+\.py$/iu;
const EXECUTABLE_TEST_EXTENSION = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|kts|cs|php|swift)$/iu;
const TEST_CONFIG_PATTERN =
  /(?:^|\/)(?:vitest|jest|playwright|cypress|karma|ava|wdio|mocha)\.config\.[^/]+$|(?:^|\/)(?:pytest\.ini|tox\.ini|noxfile\.py|conftest\.py|phpunit\.xml(?:\.dist)?|\.mocharc(?:\.[^/]+)?)$/iu;
const LINT_CONFIG_PATTERN =
  /(?:^|\/)(?:eslint\.config\.[^/]+|\.eslintrc(?:\.[^/]+)?|biome\.jsonc?|ruff\.toml|\.ruff\.toml|\.golangci\.ya?ml|stylelint\.config\.[^/]+|\.stylelintrc(?:\.[^/]+)?)$/iu;
const TYPECHECK_CONFIG_PATTERN =
  /(?:^|\/)(?:tsconfig(?:\.[^/]+)?\.json|jsconfig\.json|pyrightconfig\.json|mypy\.ini)$/iu;
const BUILD_CONFIG_PATTERN =
  /(?:^|\/)(?:vite|webpack|rollup|esbuild|next|nuxt|astro)\.config\.[^/]+$|(?:^|\/)(?:turbo\.json|nx\.json|lerna\.json|Makefile|GNUmakefile|justfile|Taskfile\.ya?ml)$/iu;
const VALIDATION_RUNTIME_PATTERN =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock)$/iu;
const PACKAGE_MANIFEST_PATTERN = /(?:^|\/)package\.json$/iu;

function normalizePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\//u, "");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//u.test(normalized) ||
    normalized.includes("\0") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return undefined;
  }
  return normalized;
}

function safePath(root: string, path: string): string {
  const normalized = normalizePath(path);
  if (normalized === undefined) throw new Error(`Unsafe validation definition path: ${path}`);
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, ...normalized.split("/"));
  if (!candidate.startsWith(rootPath + sep)) {
    throw new Error(`Validation definition path escaped the workspace: ${path}`);
  }
  return candidate;
}

async function textIfPresent(root: string, path: string): Promise<string | undefined> {
  try {
    return await readFile(safePath(root, path), "utf8");
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error.code === "ENOENT" || error.code === "EISDIR")
    ) {
      return undefined;
    }
    throw error;
  }
}

function buildCommandDependencyGraph(
  snapshot: WorkspaceSnapshot,
  commands: readonly (readonly string[])[],
  additionalPaths: readonly string[] = [],
) {
  return buildValidationCommandGraph(
    {
      baselinePaths: snapshot.baseline.keys(),
      additionalPaths,
      readBaseline: async (path) => await textIfPresent(snapshot.sourceRoot, path),
      readCandidate: async (path) => await textIfPresent(snapshot.workerRoot, path),
    },
    commands,
  );
}

function changeType(
  path: string,
  changes: WorkspaceChanges,
): Exclude<ValidationDefinitionChangeType, "renamed"> {
  if (changes.added.includes(path)) return "added";
  if (changes.deleted.includes(path)) return "deleted";
  return "modified";
}

function categoryForPath(path: string): ValidationDefinitionCategory | undefined {
  if (TEST_CONFIG_PATTERN.test(path)) return "test-config";
  if (LINT_CONFIG_PATTERN.test(path)) return "lint-config";
  if (TYPECHECK_CONFIG_PATTERN.test(path)) return "typecheck-config";
  if (BUILD_CONFIG_PATTERN.test(path)) return "build-config";
  if (VALIDATION_RUNTIME_PATTERN.test(path)) return "validation-runtime";
  if (TEST_FILE_PATTERN.test(path)) return "test-source";
  return undefined;
}

function testExecutionShape(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(lower)) return "javascript-discovery";
  if (/(?:^|\/)__tests__\/.*\.[cm]?[jt]sx?$/u.test(lower)) return "javascript-discovery";
  if (/(?:^|\/)(?:test_[^/]+|[^/]+_test)\.py$/u.test(lower)) return "python-discovery";
  if (/(?:^|\/)[^/]+_test\.go$/u.test(lower)) return "go-discovery";
  if (/(?:^|\/)[^/]+_test\.(?:rb|rs)$/u.test(lower)) return "native-suffix-discovery";
  if (TEST_FILE_PATTERN.test(path) && EXECUTABLE_TEST_EXTENSION.test(path)) {
    return `test-directory:${posix.extname(lower)}`;
  }
  return undefined;
}

function isSafeTestRename(previousPath: string, nextPath: string): boolean {
  const previousShape = testExecutionShape(previousPath);
  return previousShape !== undefined && previousShape === testExecutionShape(nextPath);
}

function manifestTestDiscoveryPatterns(value: string | undefined): readonly string[] | undefined {
  const manifest = jsonObject(parseJson(value));
  if (manifest === undefined) return undefined;
  const jest = jsonObject(manifest.jest);
  if (jest !== undefined && Object.hasOwn(jest, "testMatch")) {
    return Array.isArray(jest.testMatch) &&
      jest.testMatch.every((entry) => typeof entry === "string")
      ? jest.testMatch
      : [];
  }
  const vitest = jsonObject(manifest.vitest);
  const include = vitest?.include ?? jsonObject(vitest?.test)?.include;
  if (include !== undefined) {
    return Array.isArray(include) && include.every((entry) => typeof entry === "string")
      ? include
      : [];
  }
  return undefined;
}

function discoveryPatternAllowsPath(pattern: string, path: string): boolean {
  const normalized = pattern.toLowerCase().replaceAll("\\", "/");
  const lowerPath = path.toLowerCase();
  const suffix = /\.(test|spec)\./u.exec(lowerPath)?.[1];
  if (suffix !== undefined) {
    return (
      normalized.includes(`.${suffix}.`) ||
      normalized.includes(`{test,spec}`) ||
      normalized.includes(`{spec,test}`)
    );
  }
  if (lowerPath.includes("/__tests__/")) return normalized.includes("__tests__");
  if (/(?:^|\/)test_[^/]+\.py$/u.test(lowerPath)) return normalized.includes("test_");
  if (/(?:^|\/)[^/]+_test\./u.test(lowerPath)) return normalized.includes("_test");
  return false;
}

function configuredDiscoveryAllowsRename(
  packageDetails: ReadonlyMap<string, PackageGraphDetail>,
  nextPath: string,
): boolean {
  for (const detail of packageDetails.values()) {
    for (const manifest of [detail.baseline, detail.candidate]) {
      const patterns = manifestTestDiscoveryPatterns(manifest);
      if (
        patterns !== undefined &&
        !patterns.some((pattern) => discoveryPatternAllowsPath(pattern, nextPath))
      ) {
        return false;
      }
    }
  }
  return true;
}

function allNoOpSegments(command: string): boolean {
  const whole = command.trim().toLowerCase();
  if (
    /^node(?:\.exe)?\s+(?:--eval|-e)\s+["']process\.exit\(0\);?["']$/u.test(whole) ||
    /^(?:true|:|exit\s+0)$/u.test(whole)
  ) {
    return true;
  }
  const segments = command
    .split(/&&|;/u)
    .map((part) => part.trim())
    .filter(Boolean);
  if (segments.length === 0) return true;
  return segments.every((segment) => {
    const normalized = segment
      .replace(/^\([^)]*\)\s*/u, "")
      .trim()
      .toLowerCase();
    return (
      normalized === ":" ||
      normalized === "true" ||
      normalized === "exit 0" ||
      /^(?:echo|printf)\b(?![\s\S]*\bexit\s+[1-9]\d*)/u.test(normalized) ||
      /^node(?:\.exe)?\s+(?:--eval|-e)\s+["']?process\.exit\(0\);?["']?$/u.test(normalized)
    );
  });
}

function directEntrypointIsNoOp(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return (
    allNoOpSegments(value) ||
    /^(?:process\.)?exit\s*\(\s*0\s*\)\s*;?$/u.test(normalized) ||
    /^sys\.exit\s*\(\s*0\s*\)\s*$/u.test(normalized)
  );
}

function explicitNoTestsAllowance(command: string): boolean {
  return /(?:--pass-?with-?no-?tests|--allow-?empty|--if-present)\b/iu.test(command);
}

function skipCount(value: string | undefined): number {
  if (value === undefined) return 0;
  const patterns = [
    /\b(?:describe|it|test)\s*\.\s*(?:skip|todo|only)\s*\(/gu,
    /\b(?:xdescribe|xit|xtest)\s*\(/gu,
    /@pytest\.mark\.(?:skip|skipif)\b/gu,
    /\bpytest\.skip\s*\(/gu,
    /@(?:unittest\.)?skip(?:If|Unless)?\b/gu,
    /@Disabled\b/gu,
    /\bt\.Skip(?:f|Now)?\s*\(/gu,
    /#\s*\[\s*ignore\s*\]/gu,
  ];
  return patterns.reduce((count, pattern) => count + [...value.matchAll(pattern)].length, 0);
}

function parseJson(value: string | undefined): unknown {
  if (value === undefined) return undefined;
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

function nested(object: Record<string, unknown> | undefined, ...path: readonly string[]): unknown {
  let current: unknown = object;
  for (const part of path) current = jsonObject(current)?.[part];
  return current;
}

function explicitConfigWeakening(
  category: ValidationDefinitionCategory,
  baseline: string | undefined,
  candidate: string | undefined,
): readonly string[] {
  if (candidate === undefined) return ["A validation configuration file was deleted"];
  const reasons: string[] = [];
  if (
    /\bpassWithNoTests\s*:\s*true\b/iu.test(candidate) &&
    !/\bpassWithNoTests\s*:\s*true\b/iu.test(baseline ?? "")
  ) {
    reasons.push("The test configuration newly permits an empty test suite");
  }
  if (
    /\ballowOnly\s*:\s*true\b/iu.test(candidate) &&
    !/\ballowOnly\s*:\s*true\b/iu.test(baseline ?? "")
  ) {
    reasons.push("The test configuration newly permits focused-only tests");
  }
  if (category === "test-config") {
    for (const key of ["lines", "functions", "statements", "branches"] as const) {
      const expression = new RegExp(`\\b${key}\\s*:\\s*(\\d+(?:\\.\\d+)?)`, "iu");
      const before = expression.exec(baseline ?? "")?.[1];
      const after = expression.exec(candidate)?.[1];
      if (before !== undefined && (after === undefined || Number(after) < Number(before))) {
        reasons.push(`Coverage threshold ${key} was removed or lowered`);
      }
    }
  }
  if (category === "typecheck-config") {
    const before = jsonObject(parseJson(baseline));
    const after = jsonObject(parseJson(candidate));
    for (const key of [
      "strict",
      "noEmitOnError",
      "noImplicitAny",
      "noUncheckedIndexedAccess",
      "exactOptionalPropertyTypes",
      "noFallthroughCasesInSwitch",
      "noUnusedLocals",
      "noUnusedParameters",
    ]) {
      const baselineEnabled = new RegExp(`["']?${key}["']?\\s*:\\s*true\\b`, "iu").test(
        baseline ?? "",
      );
      const candidateDisabled = new RegExp(`["']?${key}["']?\\s*:\\s*false\\b`, "iu").test(
        candidate,
      );
      if (
        (nested(before, "compilerOptions", key) === true || baselineEnabled) &&
        (nested(after, "compilerOptions", key) === false || candidateDisabled)
      ) {
        reasons.push(`Type-check option ${key} was disabled`);
      }
    }
  }
  if (category === "lint-config" && baseline !== undefined) {
    const rule = /["']([^"']+)["']\s*:\s*["'](error|warn|off)["']/giu;
    const baselineRules = new Map<string, string>();
    const candidateRules = new Map<string, string>();
    for (const match of baseline.matchAll(rule)) {
      if (match[1] !== undefined && match[2] !== undefined) baselineRules.set(match[1], match[2]);
    }
    for (const match of candidate.matchAll(rule)) {
      if (match[1] !== undefined && match[2] !== undefined) candidateRules.set(match[1], match[2]);
    }
    for (const [name, severity] of baselineRules) {
      const next = candidateRules.get(name);
      if (severity === "error" && (next === "warn" || next === "off")) {
        reasons.push(`Lint rule ${name} was lowered from error`);
      }
    }
  }
  return reasons;
}

function commandEvidence(
  commands: readonly (readonly string[])[],
  packageCommands: readonly string[],
): string {
  return [...commands.flat(), ...packageCommands].join(" ").toLowerCase();
}

function configIsRelevant(category: ValidationDefinitionCategory, evidence: string): boolean {
  if (category === "test-config")
    return /\b(?:test|vitest|jest|playwright|cypress|pytest|mocha|ava)\b/u.test(evidence);
  if (category === "lint-config")
    return /\b(?:lint|eslint|biome|ruff|stylelint|golangci)\b/u.test(evidence);
  if (category === "typecheck-config") return /\b(?:typecheck|tsc|mypy|pyright)\b/u.test(evidence);
  if (category === "build-config")
    return /\b(?:build|vite|webpack|rollup|esbuild|next|turbo|nx|make)\b/u.test(evidence);
  return false;
}

function baseRisk(reasons: readonly string[]): ValidationDefinitionRisk {
  return reasons.length === 0 ? "suspicious" : "dangerous";
}

function boundedReasons(reasons: readonly string[]): readonly string[] {
  return [...new Set(reasons)].slice(0, MAX_REASON_COUNT);
}

function summaryStatus(
  mode: ValidationIntegrityMode,
  count: number,
  dangerous: number,
): ValidationIntegrityStatus {
  if (count === 0) return "clean";
  if (mode === "strict" && dangerous > 0) return "blocked";
  if (mode === "warn") return "warned";
  return "changed";
}

function digest(value: string | undefined): string | undefined {
  return value === undefined ? undefined : createHash("sha256").update(value, "utf8").digest("hex");
}

export async function inspectValidationIntegrity(
  input: InspectValidationIntegrityInput,
): Promise<ValidationIntegritySummary> {
  const maximum = Math.min(
    MAX_REPORTED_CHANGES,
    Math.max(1, input.maxReportedChanges ?? DEFAULT_MAX_REPORTED_CHANGES),
  );
  const graph = await buildCommandDependencyGraph(
    input.snapshot,
    input.commands,
    input.changes.added,
  );
  const directTargets = graph.entrypoints;
  const packageCommands: string[] = [];
  for (const detail of graph.packageDetails.values()) {
    const baselineScripts = recordScripts(detail.baseline);
    const candidateScripts = recordScripts(detail.candidate);
    for (const name of detail.scripts) {
      if (baselineScripts[name] !== undefined) packageCommands.push(baselineScripts[name]);
      if (candidateScripts[name] !== undefined) packageCommands.push(candidateScripts[name]);
    }
  }
  const evidence = commandEvidence(input.commands, packageCommands);
  const classified: ClassifiedChange[] = [];

  for (const [path, detail] of graph.packageDetails) {
    const changedScripts = [...detail.scripts].filter(
      (name) => recordScripts(detail.baseline)[name] !== recordScripts(detail.candidate)[name],
    );
    if (changedScripts.length === 0) continue;
    const reasons: string[] = [];
    const baselineScripts = recordScripts(detail.baseline);
    const candidateScripts = recordScripts(detail.candidate);
    for (const name of changedScripts) {
      const before = baselineScripts[name];
      const after = candidateScripts[name];
      if (before !== undefined && after === undefined) {
        reasons.push(`Configured package script ${name} was removed`);
      } else if (
        after !== undefined &&
        (before === undefined || !allNoOpSegments(before)) &&
        (allNoOpSegments(after) || explicitNoTestsAllowance(after))
      ) {
        reasons.push(
          `Configured package script ${name} was changed to a no-op or empty-suite command`,
        );
      }
    }
    classified.push({
      path,
      change: changeType(path, input.changes),
      category: "entrypoint",
      risk: baseRisk(reasons),
      controlPlane: true,
      reasons: boundedReasons(
        reasons.length === 0
          ? ["A configured package validation script changed and requires baseline replay"]
          : reasons,
      ),
    });
  }

  const addedTestPaths = input.changes.added.filter((path) => TEST_FILE_PATTERN.test(path));
  const addedTestDigests = new Map<string, string>();
  for (const path of addedTestPaths) {
    const candidate = await textIfPresent(input.snapshot.workerRoot, path);
    const candidateDigest = digest(candidate);
    if (candidateDigest !== undefined) addedTestDigests.set(candidateDigest, path);
  }
  const renamedTests = new Map<string, string>();
  const consumedAddedTests = new Set<string>();
  for (const path of input.changes.deleted.filter((candidate) =>
    TEST_FILE_PATTERN.test(candidate),
  )) {
    const baseline = await textIfPresent(input.snapshot.sourceRoot, path);
    const baselineDigest = digest(baseline);
    const renamedTo =
      baselineDigest === undefined ? undefined : addedTestDigests.get(baselineDigest);
    if (
      renamedTo !== undefined &&
      isSafeTestRename(path, renamedTo) &&
      configuredDiscoveryAllowsRename(graph.packageDetails, renamedTo) &&
      !consumedAddedTests.has(renamedTo)
    ) {
      renamedTests.set(path, renamedTo);
      consumedAddedTests.add(renamedTo);
    }
  }

  for (const path of input.changes.all) {
    const packageDetail = graph.packageDetails.get(path);
    if (packageDetail !== undefined && PACKAGE_MANIFEST_PATTERN.test(path)) {
      const dependencyReasons = dependencyReplacementReasons(
        packageDetail.baseline,
        packageDetail.candidate,
      );
      const control = manifestControlChanges(packageDetail.baseline, packageDetail.candidate);
      const reasons = boundedReasons([...dependencyReasons, ...control.reasons]);
      if (reasons.length > 0) {
        classified.push({
          path,
          change: changeType(path, input.changes),
          category: "validation-runtime",
          risk: dependencyReasons.length > 0 ? "dangerous" : "suspicious",
          controlPlane: true,
          reasons,
        });
      }
      continue;
    } else if (packageDetail !== undefined) {
      continue;
    }
    const configuredDirect = directTargets.has(path);
    const category = configuredDirect ? "entrypoint" : categoryForPath(path);
    if (category === undefined) continue;
    const change = changeType(path, input.changes);
    const baseline = await textIfPresent(input.snapshot.sourceRoot, path);
    const candidate = await textIfPresent(input.snapshot.workerRoot, path);
    if (category === "test-source") {
      const renamedTo = change === "deleted" ? renamedTests.get(path) : undefined;
      if (renamedTo !== undefined) {
        classified.push({
          path: renamedTo,
          previousPath: path,
          change: "renamed",
          category,
          risk: "informational",
          controlPlane: false,
          reasons: ["A test file moved without changing its contents"],
        });
        continue;
      }
      if (change === "added" && consumedAddedTests.has(path)) continue;
      const beforeSkips = skipCount(baseline);
      const afterSkips = skipCount(candidate);
      const reasons: string[] = [];
      if (afterSkips > beforeSkips)
        reasons.push("The number of explicit skipped or focused-only tests increased");
      if (change === "deleted") {
        reasons.push("A test file was deleted without an identical-content rename");
      }
      classified.push({
        path,
        change,
        category,
        risk: reasons.length === 0 ? "informational" : "dangerous",
        controlPlane: false,
        reasons: boundedReasons(reasons.length === 0 ? ["Test coverage changed"] : reasons),
      });
      continue;
    }
    if (category === "validation-runtime") {
      const reasons = lockReplacementReasons(baseline, candidate);
      classified.push({
        path,
        change,
        category,
        risk: reasons.length > 0 ? "dangerous" : "informational",
        controlPlane: reasons.length > 0,
        reasons: reasons.length > 0 ? reasons : ["The dependency lock used by validation changed"],
      });
      continue;
    }
    const relevant = configuredDirect || configIsRelevant(category, evidence);
    const reasons = configuredDirect
      ? [
          ...(change === "deleted"
            ? ["A configured direct validation entrypoint was deleted"]
            : []),
          ...(directEntrypointIsNoOp(candidate)
            ? ["A configured direct validation entrypoint was changed to a no-op"]
            : []),
        ]
      : explicitConfigWeakening(category, baseline, candidate);
    classified.push({
      path,
      change,
      category,
      risk: reasons.length > 0 ? "dangerous" : relevant ? "suspicious" : "informational",
      controlPlane: relevant,
      reasons: boundedReasons(
        reasons.length > 0
          ? reasons
          : relevant
            ? ["A validation control file changed and requires baseline replay"]
            : ["A validation-related configuration changed"],
      ),
    });
  }

  if (!graph.reliable && input.changes.all.length > 0) {
    const path = input.changes.all[0];
    if (path !== undefined) {
      const existing = classified.findIndex(
        (change) => change.path === path && change.category === "entrypoint",
      );
      const reason =
        "A configured validation command could not be resolved conservatively; strict mode fails closed";
      if (existing === -1) {
        classified.push({
          path,
          change: changeType(path, input.changes),
          category: "entrypoint",
          risk: "dangerous",
          controlPlane: true,
          reasons: [reason],
        });
      } else {
        const previous = classified[existing];
        if (previous !== undefined) {
          classified[existing] = {
            ...previous,
            risk: "dangerous",
            controlPlane: true,
            reasons: boundedReasons([...previous.reasons, reason]),
          };
        }
      }
    }
  }

  classified.sort((left, right) =>
    left.path === right.path
      ? left.category.localeCompare(right.category)
      : left.path.localeCompare(right.path),
  );
  const dangerousChangeCount = classified.filter(({ risk }) => risk === "dangerous").length;
  const controlPlaneChangeCount = classified.filter(({ controlPlane }) => controlPlane).length;
  const testChangeCount = classified.filter(({ category }) => category === "test-source").length;
  const changes = classified.slice(0, maximum);
  return {
    schemaVersion: 1,
    mode: input.mode,
    status: summaryStatus(input.mode, classified.length, dangerousChangeCount),
    changeCount: classified.length,
    dangerousChangeCount,
    controlPlaneChangeCount,
    testChangeCount,
    changes,
    truncated: classified.length > changes.length,
  };
}

function failedResult(results: readonly ValidationResult[]): ValidationResult | undefined {
  return results.find(({ result }) => result.exitCode !== 0 || result.timedOut);
}

function blockedAudit(
  audit: ValidationIntegritySummary,
  baselineReplay?: ValidationBaselineReplaySummary,
): ValidationIntegritySummary {
  return {
    ...audit,
    status: "blocked",
    ...(baselineReplay === undefined ? {} : { baselineReplay }),
  };
}

function syntheticFailure(audit: ValidationIntegritySummary): ValidationResult {
  const paths = audit.changes
    .filter(({ risk }) => risk === "dangerous")
    .map(({ path }) => path)
    .slice(0, 10);
  return {
    argv: ["validation-integrity", "strict"],
    result: {
      exitCode: 1,
      stdout: "",
      stderr: `Strict validation integrity blocked ${String(audit.dangerousChangeCount)} high-confidence weakening change(s)${paths.length === 0 ? "" : `: ${paths.join(", ")}`}.`,
      timedOut: false,
      outputTruncated: audit.truncated,
    },
  };
}

export class ValidationIntegrityError extends ValidationFailureError {
  public readonly integrityCode = "VALIDATION_INTEGRITY" as const;
  public readonly audit: ValidationIntegritySummary;

  public constructor(
    audit: ValidationIntegritySummary,
    failure: ValidationResult = syntheticFailure(audit),
  ) {
    super(failure);
    this.name = "ValidationIntegrityError";
    this.audit = audit;
  }
}

function includeInReplayCopy(workspaceRoot: string, source: string): boolean {
  const path = relative(workspaceRoot, source);
  if (path === "") return true;
  const rootEntry = path.split(sep)[0];
  return rootEntry !== undefined && !isIgnoredGeneratedRootEntry(rootEntry);
}

async function restoreRegularFile(
  sourceRoot: string,
  replayRoot: string,
  path: string,
): Promise<void> {
  const source = safePath(sourceRoot, path);
  const target = safePath(replayRoot, path);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  await chmod(target, (await stat(source)).mode & 0o777);
}

async function restorePackageValidationControls(
  sourceRoot: string,
  replayRoot: string,
  path: string,
  scriptNames: readonly string[],
  controlKeys: readonly string[],
): Promise<void> {
  const baselineText = await textIfPresent(sourceRoot, path);
  const candidateText = await textIfPresent(replayRoot, path);
  if (baselineText === undefined) {
    await rm(safePath(replayRoot, path), { force: true });
    return;
  }
  if (candidateText === undefined) {
    await restoreRegularFile(sourceRoot, replayRoot, path);
    return;
  }
  const baselineValue = jsonObject(parseJson(baselineText));
  const candidateValue = jsonObject(parseJson(candidateText));
  if (baselineValue === undefined || candidateValue === undefined) {
    await restoreRegularFile(sourceRoot, replayRoot, path);
    return;
  }
  const baselineScripts = recordScripts(baselineText);
  const candidateScripts = { ...recordScripts(candidateText) };
  for (const name of scriptNames) {
    const value = baselineScripts[name];
    if (value === undefined) Reflect.deleteProperty(candidateScripts, name);
    else candidateScripts[name] = value;
  }
  const merged: Record<string, unknown> = { ...candidateValue };
  if (scriptNames.length > 0) merged.scripts = candidateScripts;
  for (const key of controlKeys) {
    if (Object.hasOwn(baselineValue, key)) merged[key] = baselineValue[key];
    else Reflect.deleteProperty(merged, key);
  }
  await writeFile(safePath(replayRoot, path), `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}

async function prepareBaselineReplayWorkspace(
  snapshot: WorkspaceSnapshot,
  audit: ValidationIntegritySummary,
  commands: readonly (readonly string[])[],
): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "dsh-action-integrity-"));
  const root = join(parent, "workspace");
  try {
    await cp(snapshot.workerRoot, root, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (source) => includeInReplayCopy(snapshot.workerRoot, source),
    });
    const replayChanges = await inspectWorkspaceChanges(snapshot);
    const graph = await buildCommandDependencyGraph(snapshot, commands, replayChanges.added);
    for (const [manifestPath, detail] of graph.packageDetails) {
      await restorePackageValidationControls(
        snapshot.sourceRoot,
        root,
        manifestPath,
        [...detail.scripts].sort((left, right) => left.localeCompare(right)),
        manifestControlChanges(detail.baseline, detail.candidate).keys,
      );
    }
    for (const change of audit.changes) {
      if (!change.controlPlane || change.category === "entrypoint") continue;
      if (PACKAGE_MANIFEST_PATTERN.test(change.path) && graph.packageDetails.has(change.path)) {
        continue;
      }
      if (change.change === "added") await rm(safePath(root, change.path), { force: true });
      else await restoreRegularFile(snapshot.sourceRoot, root, change.path);
    }
    for (const path of graph.entrypoints) {
      const baseline = await textIfPresent(snapshot.sourceRoot, path);
      if (baseline === undefined) await rm(safePath(root, path), { force: true });
      else await restoreRegularFile(snapshot.sourceRoot, root, path);
    }
    return { parent, root };
  } catch (error: unknown) {
    await rm(parent, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Enforce a previously inspected audit. The optional replay runs only for
 * control-plane changes and keeps candidate code, tests, and dependencies.
 */
export async function enforceValidationIntegrity(
  input: EnforceValidationIntegrityInput,
): Promise<ValidationIntegritySummary> {
  if (input.audit.mode !== "strict") return input.audit;
  if (input.audit.truncated || input.audit.dangerousChangeCount > 0) {
    const audit = blockedAudit(input.audit);
    throw new ValidationIntegrityError(audit);
  }
  if (input.audit.controlPlaneChangeCount === 0 || input.baselineReplay === undefined) {
    return input.audit;
  }
  const replay = await prepareBaselineReplayWorkspace(input.snapshot, input.audit, input.commands);
  try {
    const runner = input.baselineReplay.runner ?? defaultValidationIntegrityRunner;
    const results = await runner(
      replay.root,
      input.commands,
      input.baselineReplay.containerImage,
      input.baselineReplay.timeoutMs,
      input.baselineReplay.signal,
    );
    const failure = failedResult(results);
    const replaySummary: ValidationBaselineReplaySummary = {
      status: failure === undefined ? "passed" : "failed",
      commandCount: results.length,
    };
    if (failure !== undefined) {
      throw new ValidationIntegrityError(blockedAudit(input.audit, replaySummary), failure);
    }
    return { ...input.audit, baselineReplay: replaySummary };
  } finally {
    await rm(replay.parent, { recursive: true, force: true });
  }
}
