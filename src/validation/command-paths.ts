import { posix } from "node:path";

export interface WorkspaceCommandDependencies {
  readonly entrypoints: readonly string[];
  readonly reliable: boolean;
}

export interface CommandDependencyAnalysisOptions {
  /** Union of baseline and candidate repository files, used for exact module resolution. */
  readonly knownWorkspacePaths?: ReadonlySet<string>;
  /** Observe nested commands after supported wrappers are removed. */
  readonly onCommand?: (argv: readonly string[], baseDirectory: string) => void;
}

export interface CommandDependencyRecursor {
  readonly analyzeArgv: (
    argv: readonly string[],
    baseDirectory: string,
    analysis?: CommandDependencyAnalysisOptions,
  ) => WorkspaceCommandDependencies;
  readonly analyzeShellText: (
    value: string,
    baseDirectory: string,
    analysis?: CommandDependencyAnalysisOptions,
  ) => WorkspaceCommandDependencies;
}

export function commandName(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? "";
}

export function normalizeWorkspacePath(value: string): string | undefined {
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

export function resolveWorkspacePath(baseDirectory: string, value: string): string | undefined {
  const candidate = value.replaceAll("\\", "/");
  if (
    candidate === "" ||
    candidate === "-" ||
    candidate.startsWith("/") ||
    /^[A-Za-z]:\//u.test(candidate) ||
    candidate.includes("\0")
  ) {
    return undefined;
  }
  const combined = posix.normalize(posix.join(baseDirectory, candidate));
  if (combined === "." || combined === ".." || combined.startsWith("../")) return undefined;
  return normalizeWorkspacePath(combined);
}

export function looksLikeScriptPath(value: string, allowBareSubpath = true): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    (allowBareSubpath && value.includes("/")) ||
    /\.(?:[cm]?[jt]s|py|rb|pl|sh|ps1)$/iu.test(value)
  );
}

const MODULE_RESOLUTION_SUFFIXES = [
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".json",
  ".node",
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
] as const;

export interface AddPathOptions {
  readonly allowBareSubpath?: boolean;
  readonly allowMissing?: boolean;
  readonly requireScriptShape?: boolean;
  readonly resolveModule?: boolean;
}

function moduleCandidates(path: string): readonly string[] {
  if (posix.extname(path) !== "") return [path];
  return [
    path,
    ...MODULE_RESOLUTION_SUFFIXES.map((suffix) => `${path}${suffix}`),
    ...MODULE_RESOLUTION_SUFFIXES.map((suffix) => `${path}/index${suffix}`),
  ];
}

export function addPath(
  result: Set<string>,
  baseDirectory: string,
  value: string | undefined,
  analysis: CommandDependencyAnalysisOptions | undefined,
  options: AddPathOptions = {},
): boolean {
  const allowBareSubpath = options.allowBareSubpath ?? true;
  if (value === undefined) return false;
  const workspaceAbsolute = value.startsWith("/workspace/");
  const workspaceValue = workspaceAbsolute ? value.slice("/workspace/".length) : value;
  if (
    (options.requireScriptShape ?? true) &&
    !looksLikeScriptPath(workspaceValue, allowBareSubpath)
  ) {
    return true;
  }
  const path = resolveWorkspacePath(workspaceAbsolute ? "" : baseDirectory, workspaceValue);
  if (path === undefined) {
    return (
      workspaceValue === "-" ||
      (!workspaceValue.startsWith("/") &&
        !/^[A-Za-z]:[\\/]/u.test(workspaceValue) &&
        /^[a-z][a-z0-9+.-]*:/iu.test(workspaceValue))
    );
  }
  const known = analysis?.knownWorkspacePaths;
  if (known === undefined) {
    result.add(path);
    return true;
  }
  const candidates = options.resolveModule === true ? moduleCandidates(path) : [path];
  const matches = candidates.filter((candidate) => known.has(candidate));
  if (matches.length === 0 && options.allowMissing === true) return true;
  if (matches.length !== 1) return false;
  const match = matches[0];
  if (match === undefined) return false;
  result.add(match);
  return true;
}

export function optionValue(argument: string, name: string): string | undefined {
  return argument.startsWith(`${name}=`) ? argument.slice(name.length + 1) : undefined;
}

export interface Redirection {
  readonly consumed: number;
  readonly input?: string;
  readonly matched: boolean;
  readonly reliable: boolean;
}

export interface StrippedRedirections {
  readonly argv: readonly string[];
  readonly inputs: readonly string[];
  readonly reliable: boolean;
}

export function redirectionAt(argv: readonly string[], index: number): Redirection {
  const argument = argv[index];
  if (argument === undefined) return { consumed: 0, matched: false, reliable: true };
  if (/^(?:[0-9]*)(?:<<|<<<)/u.test(argument)) {
    return { consumed: 0, matched: true, reliable: false };
  }
  const separated = /^(?:[0-9]*)([<>])$/u.exec(argument);
  if (separated !== null) {
    const target = argv[index + 1];
    return {
      consumed: target === undefined ? 0 : 1,
      ...(separated[1] === "<" && target !== undefined ? { input: target } : {}),
      matched: true,
      reliable: target !== undefined,
    };
  }
  const attached = /^(?:[0-9]*)([<>])(?![<>&])(.+)$/u.exec(argument);
  if (attached !== null) {
    return {
      consumed: 0,
      ...(attached[1] === "<" && attached[2] !== undefined ? { input: attached[2] } : {}),
      matched: true,
      reliable: true,
    };
  }
  if (/^(?:[0-9]*)(?:>>|>&|<&)/u.test(argument)) {
    return { consumed: 0, matched: true, reliable: true };
  }
  return { consumed: 0, matched: false, reliable: true };
}

export function stripRedirections(argv: readonly string[]): StrippedRedirections {
  const command: string[] = [];
  const inputs: string[] = [];
  let reliable = true;
  for (let index = 0; index < argv.length; index += 1) {
    const redirection = redirectionAt(argv, index);
    if (!redirection.matched) {
      const argument = argv[index];
      if (argument !== undefined) command.push(argument);
      continue;
    }
    reliable &&= redirection.reliable;
    if (redirection.input !== undefined) inputs.push(redirection.input);
    index += redirection.consumed;
  }
  if (inputs.length > 1) reliable = false;
  return { argv: command, inputs, reliable };
}

export function mergeDependencies(
  ...values: readonly WorkspaceCommandDependencies[]
): WorkspaceCommandDependencies {
  return {
    entrypoints: [...new Set(values.flatMap(({ entrypoints }) => entrypoints))],
    reliable: values.every(({ reliable }) => reliable),
  };
}
