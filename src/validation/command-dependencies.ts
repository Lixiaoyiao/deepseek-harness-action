import {
  analyzeNode,
  analyzePowerShell,
  analyzePython,
  analyzeRubyOrPerl,
  analyzeShellInterpreter,
} from "./command-interpreters.js";
import {
  addPath,
  commandName,
  looksLikeScriptPath,
  mergeDependencies,
  stripRedirections,
  type CommandDependencyAnalysisOptions,
  type CommandDependencyRecursor,
  type WorkspaceCommandDependencies,
} from "./command-paths.js";
import {
  analyzeCommandWrapper,
  analyzeCorepackWrapper,
  analyzeCrossEnvWrapper,
  analyzeEnvironmentAssignments,
  analyzeEnvironmentWrapper,
  analyzeKnownValidator,
  analyzeScriptManager,
  isCrossEnvWrapper,
  isKnownValidatorExecutable,
  isPassiveCommand,
  SCRIPT_MANAGERS,
} from "./command-wrappers.js";
import { parseShellCommands } from "./shell-command-parser.js";

export {
  normalizeWorkspacePath,
  resolveWorkspacePath,
  type CommandDependencyAnalysisOptions,
  type WorkspaceCommandDependencies,
} from "./command-paths.js";
export { commandUsesPackageManifest } from "./command-wrappers.js";
export { parseShellCommands, type ParsedShellCommands } from "./shell-command-parser.js";

const recursor: CommandDependencyRecursor = {
  analyzeArgv: (argv, baseDirectory, analysis) => analyzeCommandArgv(argv, baseDirectory, analysis),
  analyzeShellText: (value, baseDirectory, analysis) =>
    analyzeShellText(value, baseDirectory, analysis),
};

export function analyzeCommandArgv(
  argv: readonly string[],
  baseDirectory = "",
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  let offset = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(argv[offset] ?? "")) offset += 1;
  const environment = analyzeEnvironmentAssignments(argv.slice(0, offset), baseDirectory, analysis);
  const redirections = stripRedirections(argv.slice(offset));
  const command = redirections.argv;
  const redirectedInputs = new Set<string>();
  let redirectedInputsReliable = redirections.reliable;
  for (const input of redirections.inputs) {
    redirectedInputsReliable &&= addPath(redirectedInputs, baseDirectory, input, analysis, {
      requireScriptShape: false,
    });
  }
  const redirectedDependency: WorkspaceCommandDependencies = {
    entrypoints: [...redirectedInputs],
    reliable: redirectedInputsReliable,
  };
  const executable = command[0];
  if (executable === undefined) return mergeDependencies(environment, redirectedDependency);
  analysis?.onCommand?.(command, baseDirectory);
  const executableName = commandName(executable);
  let dependency: WorkspaceCommandDependencies;
  if (SCRIPT_MANAGERS.has(executableName)) {
    dependency = analyzeScriptManager(command, baseDirectory, recursor, analysis);
  } else if (isCrossEnvWrapper(executableName)) {
    dependency = analyzeCrossEnvWrapper(command, baseDirectory, recursor, analysis);
  } else if (executableName === "corepack" || executableName === "corepack.cmd") {
    dependency = analyzeCorepackWrapper(command, baseDirectory, recursor, analysis);
  } else if (executableName === "env") {
    dependency = analyzeEnvironmentWrapper(command, baseDirectory, recursor, analysis);
  } else if (executableName === "exec" || executableName === "command") {
    dependency = analyzeCommandWrapper(command, baseDirectory, executableName, recursor, analysis);
  } else if (executableName === "source" || executable === ".") {
    const entrypoints = new Set<string>();
    const reliable = addPath(entrypoints, baseDirectory, command[1], analysis, {
      requireScriptShape: false,
    });
    dependency = { entrypoints: [...entrypoints], reliable };
  } else if (executableName === "node" || executableName === "node.exe") {
    dependency = analyzeNode(command, baseDirectory, analysis);
  } else if (["python", "python3", "python.exe"].includes(executableName)) {
    dependency = analyzePython(command, baseDirectory, analysis);
  } else if (["bash", "sh", "zsh"].includes(executableName)) {
    dependency = analyzeShellInterpreter(command, baseDirectory, recursor, analysis);
  } else if (["pwsh", "powershell", "powershell.exe"].includes(executableName)) {
    dependency = analyzePowerShell(command, baseDirectory, recursor, analysis);
  } else if (executableName === "ruby" || executableName === "perl") {
    dependency = analyzeRubyOrPerl(command, baseDirectory, analysis);
  } else if (isKnownValidatorExecutable(executableName)) {
    dependency = analyzeKnownValidator(command, baseDirectory, analysis);
  } else if (isPassiveCommand(executableName)) {
    dependency = { entrypoints: [], reliable: true };
  } else if (looksLikeScriptPath(executable)) {
    const entrypoints = new Set<string>();
    const reliable = addPath(entrypoints, baseDirectory, executable, analysis, {
      requireScriptShape: false,
    });
    dependency = { entrypoints: [...entrypoints], reliable };
  } else {
    dependency = { entrypoints: [], reliable: false };
  }
  return mergeDependencies(environment, redirectedDependency, dependency);
}

export function analyzeShellText(
  value: string,
  baseDirectory = "",
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const parsed = parseShellCommands(value);
  const entrypoints = new Set<string>();
  let reliable = parsed.reliable;
  for (const argv of parsed.commands) {
    const dependency = analyzeCommandArgv(argv, baseDirectory, analysis);
    for (const path of dependency.entrypoints) entrypoints.add(path);
    reliable &&= dependency.reliable;
  }
  return { entrypoints: [...entrypoints], reliable };
}
