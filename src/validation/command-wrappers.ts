import { analyzeNode } from "./command-interpreters.js";
import {
  addPath,
  commandName,
  mergeDependencies,
  redirectionAt,
  resolveWorkspacePath,
  type CommandDependencyAnalysisOptions,
  type CommandDependencyRecursor,
  type WorkspaceCommandDependencies,
} from "./command-paths.js";
import { parseShellCommands } from "./shell-command-parser.js";

export const SCRIPT_MANAGERS = new Set([
  "npm",
  "npm.cmd",
  "npx",
  "npx.cmd",
  "pnpm",
  "pnpm.cmd",
  "yarn",
  "yarn.cmd",
  "bun",
  "bun.exe",
  "bunx",
  "bunx.exe",
]);

const PACKAGE_VALIDATOR_EXECUTABLES = new Set([
  "ava",
  "biome",
  "c8",
  "cypress",
  "eslint",
  "jest",
  "karma",
  "mocha",
  "next",
  "nyc",
  "playwright",
  "prettier",
  "rollup",
  "stylelint",
  "ts-node",
  "tsc",
  "tsx",
  "vite",
  "vitest",
  "webpack",
  "wdio",
]);

const KNOWN_VALIDATOR_EXECUTABLES = new Set([
  ...PACKAGE_VALIDATOR_EXECUTABLES,
  "cargo",
  "cmake",
  "composer",
  "ctest",
  "dotnet",
  "go",
  "golangci-lint",
  "gradle",
  "gradlew",
  "make",
  "mvn",
  "mvnw",
  "mypy",
  "nox",
  "phpunit",
  "pyright",
  "pytest",
  "rspec",
  "rubocop",
  "ruff",
  "tox",
]);

const PASSIVE_COMMANDS = new Set(["[", ":", "echo", "exit", "false", "printf", "test", "true"]);
const CROSS_ENV_WRAPPERS = new Set(["cross-env", "cross-env-shell"]);

/** Whether this command is controlled by the nearest package.json. */
export function commandUsesPackageManifest(argv: readonly string[]): boolean {
  let offset = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[offset] ?? "")) offset += 1;
  const executable = commandName(argv[offset] ?? "");
  return (
    SCRIPT_MANAGERS.has(executable) ||
    PACKAGE_VALIDATOR_EXECUTABLES.has(executable) ||
    executable === "node" ||
    executable === "node.exe"
  );
}

export function commandUsesDynamicWorkspaceSelection(argv: readonly string[]): boolean {
  const executable = commandName(argv[0] ?? "");
  const beforeSeparator = argv.includes("--") ? argv.slice(1, argv.indexOf("--")) : argv.slice(1);
  if (
    (executable === "yarn" || executable === "yarn.cmd") &&
    beforeSeparator.includes("workspace") &&
    !beforeSeparator.includes("run") &&
    !beforeSeparator.includes("run-script")
  ) {
    return true;
  }
  for (const value of argv.slice(1)) {
    if (value === "--") return false;
    if (
      value === "--workspace" ||
      value === "-w" ||
      value === "--workspaces" ||
      value === "--recursive" ||
      value === "-r" ||
      value === "--filter" ||
      value === "-F" ||
      value.startsWith("--workspace=") ||
      value.startsWith("--filter=") ||
      (/^-(?:w|F)./u.test(value) && value !== "-w" && value !== "-F")
    ) {
      return true;
    }
  }
  return false;
}

export function isCrossEnvWrapper(executable: string): boolean {
  return CROSS_ENV_WRAPPERS.has(executable);
}

export function isKnownValidatorExecutable(executable: string): boolean {
  return KNOWN_VALIDATOR_EXECUTABLES.has(executable);
}

export function isPassiveCommand(executable: string): boolean {
  return PASSIVE_COMMANDS.has(executable);
}

export function analyzeScriptManager(
  argv: readonly string[],
  baseDirectory: string,
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const entrypoints = new Set<string>();
  let reliable = !commandUsesDynamicWorkspaceSelection(argv);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (["--package", "-p"].includes(argument)) {
      const packageSpec = argv[index + 1];
      if (
        packageSpec === undefined ||
        /^(?:\.{0,2}[\\/]|file:|link:|workspace:)/iu.test(packageSpec)
      ) {
        reliable = false;
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--package=") || (/^-p./u.test(argument) && argument !== "-p")) {
      const packageSpec = argument.startsWith("--package=")
        ? argument.slice("--package=".length)
        : argument.slice(2);
      if (/^(?:\.{0,2}[\\/]|file:|link:|workspace:)/iu.test(packageSpec)) reliable = false;
      continue;
    }
    if (argument === "--userconfig") {
      reliable &&= addPath(entrypoints, baseDirectory, argv[index + 1], analysis, {
        requireScriptShape: false,
      });
      index += 1;
      continue;
    }
    if (argument.startsWith("--userconfig=")) {
      reliable &&= addPath(
        entrypoints,
        baseDirectory,
        argument.slice("--userconfig=".length),
        analysis,
        { requireScriptShape: false },
      );
      continue;
    }
    if (
      ["--cache", "--dir", "--prefix", "--registry", "--workspace", "--cwd", "-C", "-w"].includes(
        argument,
      )
    ) {
      index += 1;
      continue;
    }
    if (
      !argument.startsWith("-") &&
      (argument.startsWith("./") ||
        argument.startsWith("../") ||
        /\.(?:[cm]?[jt]s|py|rb|pl|sh|ps1)$/iu.test(argument))
    ) {
      reliable &&= addPath(entrypoints, baseDirectory, argument, analysis);
    }
  }
  const executableName = commandName(argv[0] ?? "");
  const valueOptions = new Set([
    "--cache",
    "--dir",
    "--package",
    "--prefix",
    "--registry",
    "--userconfig",
    "--workspace",
    "--cwd",
    "-C",
    "-p",
    "-w",
  ]);
  const nextPositional = (start: number): number | undefined => {
    for (let index = start; index < argv.length; index += 1) {
      const argument = argv[index];
      if (argument === undefined) continue;
      if (argument === "--") return argv[index + 1] === undefined ? undefined : index + 1;
      if (valueOptions.has(argument)) {
        if (argv[index + 1] === undefined) return undefined;
        index += 1;
        continue;
      }
      if (argument.startsWith("-")) continue;
      return index;
    }
    return undefined;
  };
  let childIndex: number | undefined;
  if (
    executableName === "npx" ||
    executableName === "npx.cmd" ||
    executableName.startsWith("bunx")
  ) {
    childIndex = nextPositional(1);
  } else {
    const operationIndex = nextPositional(1);
    const operation =
      operationIndex === undefined ? undefined : argv[operationIndex]?.toLowerCase();
    if (["dlx", "exec", "x"].includes(operation ?? "")) {
      childIndex = nextPositional((operationIndex ?? 0) + 1);
    }
  }
  if (childIndex !== undefined) {
    return mergeDependencies(
      { entrypoints: [...entrypoints], reliable },
      recursor.analyzeArgv(argv.slice(childIndex), baseDirectory, analysis),
    );
  }
  return { entrypoints: [...entrypoints], reliable };
}

export function analyzeEnvironmentAssignments(
  assignments: readonly string[],
  baseDirectory: string,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const entrypoints = new Set<string>();
  let reliable = true;
  for (const assignment of assignments) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) continue;
    const name = assignment.slice(0, separator).toUpperCase();
    const value = assignment.slice(separator + 1);
    if (name === "NODE_OPTIONS") {
      const parsed = parseShellCommands(value);
      if (!parsed.reliable || parsed.commands.length !== 1) {
        reliable = false;
        continue;
      }
      const options = parsed.commands[0];
      if (options === undefined) {
        reliable = false;
        continue;
      }
      const dependency = analyzeNode(["node", ...options], baseDirectory, analysis);
      reliable &&= dependency.reliable;
      for (const path of dependency.entrypoints) entrypoints.add(path);
      continue;
    }
    if (name === "BASH_ENV" || name === "ENV") {
      reliable &&= addPath(entrypoints, baseDirectory, value, analysis, {
        requireScriptShape: false,
      });
      continue;
    }
    if (["NODE_PATH", "PATH", "PERL5LIB", "PYTHONPATH", "RUBYLIB"].includes(name)) {
      // Directory search paths can redirect a fixed validator name to arbitrary
      // workspace code; a file-only dependency graph cannot resolve them.
      reliable = false;
    }
  }
  return { entrypoints: [...entrypoints], reliable };
}

export function analyzeEnvironmentWrapper(
  argv: readonly string[],
  baseDirectory: string,
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  let effectiveBase = baseDirectory;
  const assignments: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
      assignments.push(argument);
      continue;
    }
    if (argument === "--") {
      return mergeDependencies(
        analyzeEnvironmentAssignments(assignments, effectiveBase, analysis),
        recursor.analyzeArgv(argv.slice(index + 1), effectiveBase, analysis),
      );
    }
    if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(argument)) {
      continue;
    }
    if (argument === "-u" || argument === "--unset") {
      if (argv[index + 1] === undefined) return { entrypoints: [], reliable: false };
      index += 1;
      continue;
    }
    if (argument.startsWith("--unset=")) continue;
    if (argument === "-C" || argument === "--chdir") {
      const directory = argv[index + 1];
      if (directory === undefined) return { entrypoints: [], reliable: false };
      const resolved = resolveWorkspacePath(effectiveBase, directory);
      if (resolved === undefined) return { entrypoints: [], reliable: false };
      effectiveBase = resolved;
      index += 1;
      continue;
    }
    if (argument.startsWith("--chdir=")) {
      const resolved = resolveWorkspacePath(effectiveBase, argument.slice("--chdir=".length));
      if (resolved === undefined) return { entrypoints: [], reliable: false };
      effectiveBase = resolved;
      continue;
    }
    if (argument === "-S" || argument === "--split-string") {
      const embedded = argv[index + 1];
      return embedded === undefined
        ? { entrypoints: [], reliable: false }
        : mergeDependencies(
            analyzeEnvironmentAssignments(assignments, effectiveBase, analysis),
            recursor.analyzeShellText(embedded, effectiveBase, analysis),
          );
    }
    if (argument.startsWith("--split-string=")) {
      return mergeDependencies(
        analyzeEnvironmentAssignments(assignments, effectiveBase, analysis),
        recursor.analyzeShellText(
          argument.slice("--split-string=".length),
          effectiveBase,
          analysis,
        ),
      );
    }
    if (argument.startsWith("-")) return { entrypoints: [], reliable: false };
    return mergeDependencies(
      analyzeEnvironmentAssignments(assignments, effectiveBase, analysis),
      recursor.analyzeArgv(argv.slice(index), effectiveBase, analysis),
    );
  }
  return { entrypoints: [], reliable: false };
}

export function analyzeCrossEnvWrapper(
  argv: readonly string[],
  baseDirectory: string,
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const assignments: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argument)) {
      assignments.push(argument);
      continue;
    }
    if (argument === "--") {
      index += 1;
      if (argv[index] === undefined) return { entrypoints: [], reliable: false };
    } else if (argument.startsWith("-")) {
      return { entrypoints: [], reliable: false };
    }
    const nested = argv.slice(index);
    const command =
      commandName(argv[0] ?? "") === "cross-env-shell"
        ? recursor.analyzeShellText(nested.join(" "), baseDirectory, analysis)
        : recursor.analyzeArgv(nested, baseDirectory, analysis);
    return mergeDependencies(
      analyzeEnvironmentAssignments(assignments, baseDirectory, analysis),
      command,
    );
  }
  return { entrypoints: [], reliable: false };
}

export function analyzeCorepackWrapper(
  argv: readonly string[],
  baseDirectory: string,
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--") {
      return argv[index + 1] === undefined
        ? { entrypoints: [], reliable: false }
        : recursor.analyzeArgv(argv.slice(index + 1), baseDirectory, analysis);
    }
    if (argument.startsWith("-")) continue;
    if (SCRIPT_MANAGERS.has(commandName(argument))) {
      return recursor.analyzeArgv(argv.slice(index), baseDirectory, analysis);
    }
    return { entrypoints: [], reliable: false };
  }
  return { entrypoints: [], reliable: false };
}

export function analyzeCommandWrapper(
  argv: readonly string[],
  baseDirectory: string,
  executable: "command" | "exec",
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--")
      return recursor.analyzeArgv(argv.slice(index + 1), baseDirectory, analysis);
    if (executable === "command" && (argument === "-v" || argument === "-V")) {
      return { entrypoints: [], reliable: true };
    }
    if (executable === "command" && argument === "-p") continue;
    if (executable === "exec" && (argument === "-c" || argument === "-l")) continue;
    if (executable === "exec" && argument === "-a") {
      if (argv[index + 1] === undefined) return { entrypoints: [], reliable: false };
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) return { entrypoints: [], reliable: false };
    return recursor.analyzeArgv(argv.slice(index), baseDirectory, analysis);
  }
  return { entrypoints: [], reliable: false };
}

export function analyzeKnownValidator(
  argv: readonly string[],
  baseDirectory: string,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const entrypoints = new Set<string>();
  let reliable = true;
  const executable = commandName(argv[0] ?? "");
  const configOptions = new Set<string>();
  if (
    [
      "ava",
      "biome",
      "eslint",
      "jest",
      "karma",
      "mocha",
      "playwright",
      "prettier",
      "rollup",
      "stylelint",
      "vite",
      "vitest",
      "webpack",
      "wdio",
    ].includes(executable)
  ) {
    configOptions.add("--config");
  }
  if (["cypress", "mypy"].includes(executable)) configOptions.add("--config-file");
  if (["pyright", "ts-node", "tsc"].includes(executable)) {
    configOptions.add("--project");
    configOptions.add("-p");
  }
  if (["ava", "c8", "mocha", "nyc", "ts-node"].includes(executable)) {
    configOptions.add("--require");
  }
  if (["eslint", "pytest", "ruff", "tox"].includes(executable)) configOptions.add("-c");
  if (["make", "mvn", "mvnw"].includes(executable)) configOptions.add("-f");
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const redirection = redirectionAt(argv, index);
    if (redirection.matched) {
      reliable &&= redirection.reliable;
      index += redirection.consumed;
      continue;
    }
    let handled = false;
    for (const option of configOptions) {
      const inline = argument.startsWith(`${option}=`)
        ? argument.slice(option.length + 1)
        : undefined;
      if (inline === undefined) continue;
      reliable &&= addPath(entrypoints, baseDirectory, inline, analysis, {
        requireScriptShape: false,
      });
      handled = true;
      break;
    }
    if (handled) continue;
    if (configOptions.has(argument)) {
      reliable &&= addPath(entrypoints, baseDirectory, argv[index + 1], analysis, {
        requireScriptShape: false,
      });
      index += 1;
      continue;
    }
    if ((executable === "ts-node" || executable === "tsx") && !argument.startsWith("-")) {
      reliable &&= addPath(entrypoints, baseDirectory, argument, analysis, {
        requireScriptShape: false,
        resolveModule: true,
      });
      break;
    }
  }
  return { entrypoints: [...entrypoints], reliable };
}
