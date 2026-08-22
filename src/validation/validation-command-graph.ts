import { posix } from "node:path";

import {
  analyzeCommandArgv,
  commandUsesPackageManifest,
  parseShellCommands,
} from "./command-dependencies.js";
import { commandName, normalizeWorkspacePath } from "./command-paths.js";
import { commandUsesDynamicWorkspaceSelection, SCRIPT_MANAGERS } from "./command-wrappers.js";

interface PackageScriptTarget {
  readonly manifestPath: string;
  readonly script: string;
}

interface PackageScriptResolution {
  readonly manifestPath?: string;
  readonly target?: PackageScriptTarget;
  readonly reliable: boolean;
}

interface ShellEntrypoint {
  readonly baseDirectory: string;
  readonly path: string;
}

export interface PackageGraphDetail {
  readonly baseline: string | undefined;
  readonly candidate: string | undefined;
  readonly scripts: Set<string>;
}

export interface CommandDependencyGraph {
  readonly packageDetails: ReadonlyMap<string, PackageGraphDetail>;
  readonly entrypoints: ReadonlySet<string>;
  readonly reliable: boolean;
}

export interface ValidationCommandGraphWorkspace {
  readonly baselinePaths: Iterable<string>;
  readonly additionalPaths?: readonly string[];
  readonly readBaseline: (path: string) => Promise<string | undefined>;
  readonly readCandidate: (path: string) => Promise<string | undefined>;
}

function optionValue(argv: readonly string[], names: readonly string[]): string | undefined {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") break;
    if (names.includes(argument)) return argv[index + 1];
    for (const name of names) {
      if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    }
  }
  return undefined;
}

function workspaceDirectory(baseDirectory: string, value: string): string | undefined {
  const candidate = value.replaceAll("\\", "/");
  if (candidate.startsWith("/") || /^[A-Za-z]:\//u.test(candidate) || candidate.includes("\0")) {
    return undefined;
  }
  const normalized = posix.normalize(posix.join(baseDirectory, candidate));
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalizeWorkspacePath(normalized);
}

function resolvePackageScript(
  argv: readonly string[],
  baseDirectory = "",
): PackageScriptResolution {
  const executable = argv[0] === undefined ? "" : commandName(argv[0]);
  if (!SCRIPT_MANAGERS.has(executable)) return { reliable: true };
  if (commandUsesDynamicWorkspaceSelection(argv)) {
    return { reliable: false };
  }
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--") break;
    if (!["--prefix", "--dir", "--cwd", "-C"].includes(option ?? "")) continue;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("-")) {
      return { reliable: false };
    }
  }
  const cwd = optionValue(argv, ["--prefix", "--dir", "--cwd", "-C"]);
  const normalizedCwd = workspaceDirectory(baseDirectory, cwd ?? ".");
  if (normalizedCwd === undefined) return { reliable: false };
  const manifestPath = normalizedCwd === "" ? "package.json" : `${normalizedCwd}/package.json`;
  const ignoredWithValue = new Set(["--prefix", "--dir", "--cwd", "-C", "--workspace", "-w"]);
  const positional: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === undefined) continue;
    if (ignoredWithValue.has(value)) {
      index += 1;
      continue;
    }
    if (value.startsWith("-")) continue;
    positional.push(value);
  }
  const operation = positional[0];
  if (operation === undefined) return { manifestPath, reliable: true };
  if (operation === "workspaces" || operation === "recursive") {
    return { manifestPath, reliable: false };
  }
  if (executable.startsWith("npx") || executable.startsWith("bunx")) {
    return { manifestPath, reliable: true };
  }
  if (operation === "run" || operation === "run-script") positional.shift();
  else if (executable.startsWith("npm")) {
    const npmLifecycle = new Map([
      ["t", "test"],
      ["test", "test"],
      ["start", "start"],
      ["stop", "stop"],
      ["restart", "restart"],
    ]);
    const script = npmLifecycle.get(operation);
    if (script === undefined) return { manifestPath, reliable: true };
    positional[0] = script;
  } else if (new Set(["add", "ci", "dlx", "exec", "install", "remove", "update"]).has(operation)) {
    return { manifestPath, reliable: true };
  }
  const script = positional[0];
  if (script === undefined) return { manifestPath, reliable: true };
  return {
    manifestPath,
    target: { manifestPath, script },
    reliable: true,
  };
}

export function recordScripts(value: string | undefined): Record<string, string> {
  if (value === undefined) return {};
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded !== "object" || decoded === null || !("scripts" in decoded)) return {};
    const scripts = decoded.scripts;
    if (typeof scripts !== "object" || scripts === null) return {};
    return Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

function scriptsAreReadable(value: string | undefined): boolean {
  if (value === undefined) return true;
  try {
    const decoded: unknown = JSON.parse(value);
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return false;
    const scripts = "scripts" in decoded ? decoded.scripts : undefined;
    return (
      scripts === undefined ||
      (typeof scripts === "object" &&
        scripts !== null &&
        !Array.isArray(scripts) &&
        Object.values(scripts).every((entry) => typeof entry === "string"))
    );
  } catch {
    return false;
  }
}

function manifestDirectory(path: string): string {
  const directory = posix.dirname(path);
  return directory === "." ? "" : directory;
}

export async function buildValidationCommandGraph(
  workspace: ValidationCommandGraphWorkspace,
  commands: readonly (readonly string[])[],
): Promise<CommandDependencyGraph> {
  const packageDetails = new Map<string, PackageGraphDetail>();
  const manifestPaths = new Set<string>();
  const entrypoints = new Set<string>();
  const pending: PackageScriptTarget[] = [];
  const pendingShellEntrypoints: ShellEntrypoint[] = [];
  const visited = new Set<string>();
  const visitedShellEntrypoints = new Set<string>();
  const knownWorkspacePaths = new Set([
    ...workspace.baselinePaths,
    ...(workspace.additionalPaths ?? []),
  ]);
  let reliable = true;

  const enqueue = (target: PackageScriptTarget): void => {
    for (const script of [`pre${target.script}`, target.script, `post${target.script}`]) {
      const key = `${target.manifestPath}\0${script}`;
      if (visited.has(key)) continue;
      visited.add(key);
      pending.push({ manifestPath: target.manifestPath, script });
    }
  };

  const nearestManifestPath = (baseDirectory: string): string | undefined => {
    let directory = baseDirectory;
    for (;;) {
      const candidate = directory === "" ? "package.json" : `${directory}/package.json`;
      if (knownWorkspacePaths.has(candidate)) return candidate;
      if (directory === "") return undefined;
      const parent = posix.dirname(directory);
      directory = parent === "." ? "" : parent;
    }
  };

  const observeCommand = (argv: readonly string[], baseDirectory: string): void => {
    const packageResolution = resolvePackageScript(argv, baseDirectory);
    reliable &&= packageResolution.reliable;
    if (packageResolution.manifestPath !== undefined) {
      manifestPaths.add(packageResolution.manifestPath);
    } else if (commandUsesPackageManifest(argv)) {
      const manifestPath = nearestManifestPath(baseDirectory);
      if (manifestPath !== undefined) manifestPaths.add(manifestPath);
    }
    if (packageResolution.target !== undefined) enqueue(packageResolution.target);
  };

  const analyzeArgv = (argv: readonly string[], baseDirectory: string): void => {
    const dependency = analyzeCommandArgv(argv, baseDirectory, {
      knownWorkspacePaths,
      onCommand: observeCommand,
    });
    reliable &&= dependency.reliable;
    const shellEntrypoint = ["bash", "sh", "zsh"].includes(commandName(argv[0] ?? ""));
    for (const path of dependency.entrypoints) {
      entrypoints.add(path);
      if (shellEntrypoint && /\.sh$/iu.test(path)) {
        const key = `${baseDirectory}\0${path}`;
        if (!visitedShellEntrypoints.has(key)) {
          visitedShellEntrypoints.add(key);
          pendingShellEntrypoints.push({ baseDirectory, path });
        }
      }
      if (commandUsesPackageManifest(argv)) {
        const directory = posix.dirname(path);
        const manifestPath = nearestManifestPath(directory === "." ? "" : directory);
        if (manifestPath !== undefined) manifestPaths.add(manifestPath);
      }
    }
  };

  const loadPackageDetail = async (manifestPath: string): Promise<PackageGraphDetail> => {
    const existing = packageDetails.get(manifestPath);
    if (existing !== undefined) return existing;
    const baseline = await workspace.readBaseline(manifestPath);
    const candidate = await workspace.readCandidate(manifestPath);
    reliable &&= scriptsAreReadable(baseline) && scriptsAreReadable(candidate);
    const detail = { baseline, candidate, scripts: new Set<string>() };
    packageDetails.set(manifestPath, detail);
    return detail;
  };

  for (const argv of commands) analyzeArgv(argv, "");
  while (pending.length > 0 || pendingShellEntrypoints.length > 0) {
    const target = pending.shift();
    if (target !== undefined) {
      const detail = await loadPackageDetail(target.manifestPath);
      detail.scripts.add(target.script);
      const baseDirectory = manifestDirectory(target.manifestPath);
      const baselineScripts = recordScripts(detail.baseline);
      const candidateScripts = recordScripts(detail.candidate);
      for (const command of [baselineScripts[target.script], candidateScripts[target.script]]) {
        if (command === undefined) continue;
        const parsed = parseShellCommands(command);
        reliable &&= parsed.reliable;
        for (const argv of parsed.commands) analyzeArgv(argv, baseDirectory);
      }
      continue;
    }
    const shellEntrypoint = pendingShellEntrypoints.shift();
    if (shellEntrypoint === undefined) continue;
    for (const content of [
      await workspace.readBaseline(shellEntrypoint.path),
      await workspace.readCandidate(shellEntrypoint.path),
    ]) {
      if (content === undefined) continue;
      const parsed = parseShellCommands(content.replace(/^#![^\r\n]*(?:\r?\n|$)/u, ""));
      reliable &&= parsed.reliable;
      for (const argv of parsed.commands) analyzeArgv(argv, shellEntrypoint.baseDirectory);
    }
  }
  for (const manifestPath of manifestPaths) await loadPackageDetail(manifestPath);
  return { packageDetails, entrypoints, reliable };
}
