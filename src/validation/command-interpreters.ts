import {
  addPath,
  mergeDependencies,
  optionValue,
  redirectionAt,
  resolveWorkspacePath,
  type CommandDependencyAnalysisOptions,
  type CommandDependencyRecursor,
  type WorkspaceCommandDependencies,
} from "./command-paths.js";

export function analyzeNode(
  argv: readonly string[],
  baseDirectory: string,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const entrypoints = new Set<string>();
  let reliable = true;
  const valueOptions = new Set([
    "--allow-fs-read",
    "--allow-fs-write",
    "--conditions",
    "--cpu-prof-interval",
    "--cpu-prof-name",
    "--cpu-prof-dir",
    "--diagnostic-dir",
    "--heap-prof-dir",
    "--heap-prof-interval",
    "--heap-prof-name",
    "--http-parser",
    "--icu-data-dir",
    "--input-type",
    "--inspect-publish-uid",
    "--inspect-port",
    "--max-http-header-size",
    "--network-family-autoselection-attempt-timeout",
    "--openssl-config",
    "--redirect-warnings",
    "--report-directory",
    "--report-filename",
    "--report-signal",
    "--secure-heap",
    "--secure-heap-min",
    "--snapshot-blob",
    "--test-concurrency",
    "--test-isolation",
    "--test-name-pattern",
    "--test-reporter-destination",
    "--test-shard",
    "--title",
    "--tls-cipher-list",
    "--tls-keylog",
    "--trace-event-categories",
    "--trace-event-file-pattern",
    "--unhandled-rejections",
    "--use-largepages",
    "--v8-pool-size",
    "--watch-path",
    "-C",
  ]);
  const dependencyOptions = new Set([
    "--experimental-loader",
    "--import",
    "--loader",
    "--require",
    "-r",
  ]);
  const controlFileOptions = new Set([
    "--env-file",
    "--env-file-if-exists",
    "--experimental-policy",
  ]);
  const controlModuleOptions = new Set(["--test-reporter"]);
  let redirectedInput: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const redirection = redirectionAt(argv, index);
    if (redirection.matched) {
      reliable &&= redirection.reliable;
      if (redirection.input !== undefined) {
        if (redirectedInput !== undefined) reliable = false;
        redirectedInput = redirection.input;
      }
      index += redirection.consumed;
      continue;
    }
    if (argument === "--") {
      reliable &&= addPath(entrypoints, baseDirectory, argv[index + 1], analysis, {
        requireScriptShape: false,
        resolveModule: true,
      });
      break;
    }
    if (["--eval", "--print", "-e", "-p"].includes(argument)) {
      return {
        entrypoints: [...entrypoints],
        reliable:
          reliable && argv[index + 1] !== undefined && analysis?.knownWorkspacePaths === undefined,
      };
    }
    let handledInline = false;
    for (const option of dependencyOptions) {
      const inline = optionValue(argument, option);
      if (inline !== undefined) {
        reliable &&= addPath(entrypoints, baseDirectory, inline, analysis, {
          allowBareSubpath: false,
          resolveModule: true,
        });
        handledInline = true;
        break;
      }
    }
    if (handledInline) continue;
    if (argument.startsWith("-r") && argument !== "-r") {
      reliable &&= addPath(entrypoints, baseDirectory, argument.slice(2), analysis, {
        allowBareSubpath: false,
        resolveModule: true,
      });
      continue;
    }
    if (dependencyOptions.has(argument)) {
      const dependency = argv[index + 1];
      if (dependency === undefined) return { entrypoints: [...entrypoints], reliable: false };
      reliable &&= addPath(entrypoints, baseDirectory, dependency, analysis, {
        allowBareSubpath: false,
        resolveModule: true,
      });
      index += 1;
      continue;
    }
    let handledControl = false;
    for (const option of controlFileOptions) {
      const inline = optionValue(argument, option);
      if (inline === undefined) continue;
      reliable &&= addPath(entrypoints, baseDirectory, inline, analysis, {
        ...(option === "--env-file-if-exists" ? { allowMissing: true } : {}),
        requireScriptShape: false,
      });
      handledControl = true;
      break;
    }
    if (handledControl) continue;
    for (const option of controlModuleOptions) {
      const inline = optionValue(argument, option);
      if (inline === undefined) continue;
      reliable &&= addPath(entrypoints, baseDirectory, inline, analysis, {
        allowBareSubpath: false,
        resolveModule: true,
      });
      handledControl = true;
      break;
    }
    if (handledControl) continue;
    if (controlFileOptions.has(argument) || controlModuleOptions.has(argument)) {
      const dependency = argv[index + 1];
      if (dependency === undefined) return { entrypoints: [...entrypoints], reliable: false };
      reliable &&= addPath(entrypoints, baseDirectory, dependency, analysis, {
        ...(controlFileOptions.has(argument)
          ? {
              ...(argument === "--env-file-if-exists" ? { allowMissing: true } : {}),
              requireScriptShape: false,
            }
          : { allowBareSubpath: false, resolveModule: true }),
      });
      index += 1;
      continue;
    }
    if (valueOptions.has(argument)) {
      if (argv[index + 1] === undefined) return { entrypoints: [...entrypoints], reliable: false };
      index += 1;
      continue;
    }
    if ([...valueOptions].some((option) => optionValue(argument, option) !== undefined)) continue;
    if (argument.startsWith("-")) {
      if (
        !/^(?:--(?:check|help|no-|preserve-|test$|test-only|trace-|version|watch$)|-[hv])/.test(
          argument,
        )
      ) {
        reliable = false;
      }
      continue;
    }
    reliable &&= addPath(entrypoints, baseDirectory, argument, analysis, {
      requireScriptShape: false,
      resolveModule: true,
    });
    break;
  }
  if (redirectedInput !== undefined) {
    reliable &&= addPath(entrypoints, baseDirectory, redirectedInput, analysis, {
      requireScriptShape: false,
    });
  }
  return { entrypoints: [...entrypoints], reliable };
}

export function analyzePython(
  argv: readonly string[],
  baseDirectory: string,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  let redirectedInput: string | undefined;
  let reliable = true;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const redirection = redirectionAt(argv, index);
    if (redirection.matched) {
      reliable &&= redirection.reliable;
      if (redirection.input !== undefined) {
        if (redirectedInput !== undefined) reliable = false;
        redirectedInput = redirection.input;
      }
      index += redirection.consumed;
      continue;
    }
    if (argument === "--") {
      const entrypoint = argv[index + 1];
      const result = new Set<string>();
      const resolved = addPath(result, baseDirectory, entrypoint, analysis, {
        requireScriptShape: false,
      });
      return {
        entrypoints: [...result],
        reliable: reliable && resolved,
      };
    }
    if (argument === "-c") {
      return {
        entrypoints: [],
        reliable: argv[index + 1] !== undefined && analysis?.knownWorkspacePaths === undefined,
      };
    }
    if (argument === "-m") {
      const module = argv[index + 1];
      if (module === undefined) return { entrypoints: [], reliable: false };
      const modulePath = module.replaceAll(".", "/");
      const result = new Set<string>();
      const known = analysis?.knownWorkspacePaths;
      if (known === undefined) {
        if (["compileall", "mypy", "pytest", "unittest"].includes(module)) {
          return { entrypoints: [], reliable };
        }
        const path = resolveWorkspacePath(baseDirectory, `${modulePath}.py`);
        return { entrypoints: path === undefined ? [] : [path], reliable: path !== undefined };
      }
      const candidates = [`${modulePath}.py`, `${modulePath}/__main__.py`]
        .map((path) => resolveWorkspacePath(baseDirectory, path))
        .filter((path): path is string => path !== undefined && known.has(path));
      if (candidates.length === 1) {
        const candidate = candidates[0];
        if (candidate !== undefined) result.add(candidate);
        return { entrypoints: [...result], reliable };
      }
      if (candidates.length > 1) return { entrypoints: [], reliable: false };
      return ["compileall", "mypy", "pytest", "unittest"].includes(module)
        ? { entrypoints: [], reliable }
        : { entrypoints: [], reliable: false };
    }
    if (["-W", "-X"].includes(argument)) {
      if (argv[index + 1] === undefined) return { entrypoints: [], reliable: false };
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    const result = new Set<string>();
    const resolved = addPath(result, baseDirectory, argument, analysis, {
      requireScriptShape: false,
    });
    return { entrypoints: [...result], reliable: reliable && resolved };
  }
  if (redirectedInput !== undefined) {
    const result = new Set<string>();
    reliable &&= addPath(result, baseDirectory, redirectedInput, analysis, {
      requireScriptShape: false,
    });
    return { entrypoints: [...result], reliable };
  }
  return { entrypoints: [], reliable };
}

export function analyzeShellInterpreter(
  argv: readonly string[],
  baseDirectory: string,
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const entrypoints = new Set<string>();
  let redirectedInput: string | undefined;
  let reliable = true;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const redirection = redirectionAt(argv, index);
    if (redirection.matched) {
      reliable &&= redirection.reliable;
      if (redirection.input !== undefined) {
        if (redirectedInput !== undefined) reliable = false;
        redirectedInput = redirection.input;
      }
      index += redirection.consumed;
      continue;
    }
    if (
      argument === "-c" ||
      argument === "--command" ||
      argument === "-Command" ||
      /^-[A-Za-z]*c[A-Za-z]*$/u.test(argument)
    ) {
      const embedded = argv[index + 1];
      if (embedded === undefined) return { entrypoints: [...entrypoints], reliable: false };
      return mergeDependencies(
        { entrypoints: [...entrypoints], reliable },
        recursor.analyzeShellText(embedded, baseDirectory, analysis),
      );
    }
    if (argument.startsWith("--command=")) {
      return mergeDependencies(
        { entrypoints: [...entrypoints], reliable },
        recursor.analyzeShellText(argument.slice("--command=".length), baseDirectory, analysis),
      );
    }
    if (argument === "--rcfile" || argument === "--init-file") {
      reliable &&= addPath(entrypoints, baseDirectory, argv[index + 1], analysis, {
        requireScriptShape: false,
      });
      index += 1;
      continue;
    }
    if (argument.startsWith("--rcfile=") || argument.startsWith("--init-file=")) {
      reliable &&= addPath(
        entrypoints,
        baseDirectory,
        argument.slice(argument.indexOf("=") + 1),
        analysis,
        {
          requireScriptShape: false,
        },
      );
      continue;
    }
    if (["-o", "-O"].includes(argument)) {
      if (argv[index + 1] === undefined) {
        return { entrypoints: [...entrypoints], reliable: false };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    const resolved = addPath(entrypoints, baseDirectory, argument, analysis, {
      requireScriptShape: false,
    });
    return { entrypoints: [...entrypoints], reliable: reliable && resolved };
  }
  if (redirectedInput !== undefined) {
    reliable &&= addPath(entrypoints, baseDirectory, redirectedInput, analysis, {
      requireScriptShape: false,
    });
  }
  return { entrypoints: [...entrypoints], reliable };
}

export function analyzePowerShell(
  argv: readonly string[],
  baseDirectory: string,
  recursor: CommandDependencyRecursor,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const normalized = argument.toLowerCase();
    if (normalized === "-file" || normalized === "--file") {
      const path = argv[index + 1];
      const result = new Set<string>();
      const resolved = addPath(result, baseDirectory, path, analysis, {
        requireScriptShape: false,
      });
      return {
        entrypoints: [...result],
        reliable: resolved,
      };
    }
    if (normalized === "-command" || normalized === "--command") {
      const embedded = argv[index + 1];
      return embedded === undefined
        ? { entrypoints: [], reliable: false }
        : recursor.analyzeShellText(embedded, baseDirectory, analysis);
    }
    if (normalized.startsWith("-")) continue;
    const result = new Set<string>();
    const resolved = addPath(result, baseDirectory, argument, analysis, {
      requireScriptShape: false,
    });
    return { entrypoints: [...result], reliable: resolved };
  }
  return { entrypoints: [], reliable: true };
}

export function analyzeRubyOrPerl(
  argv: readonly string[],
  baseDirectory: string,
  analysis?: CommandDependencyAnalysisOptions,
): WorkspaceCommandDependencies {
  const entrypoints = new Set<string>();
  let redirectedInput: string | undefined;
  let reliable = true;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    const redirection = redirectionAt(argv, index);
    if (redirection.matched) {
      reliable &&= redirection.reliable;
      if (redirection.input !== undefined) {
        if (redirectedInput !== undefined) reliable = false;
        redirectedInput = redirection.input;
      }
      index += redirection.consumed;
      continue;
    }
    if (argument === "-e") {
      return {
        entrypoints: [...entrypoints],
        reliable: argv[index + 1] !== undefined && analysis?.knownWorkspacePaths === undefined,
      };
    }
    if (argument === "-r") {
      reliable &&= addPath(entrypoints, baseDirectory, argv[index + 1], analysis, {
        allowBareSubpath: false,
        resolveModule: true,
      });
      index += 1;
      continue;
    }
    if (argument.startsWith("-r")) {
      reliable &&= addPath(entrypoints, baseDirectory, argument.slice(2), analysis, {
        allowBareSubpath: false,
        resolveModule: true,
      });
      continue;
    }
    if (["-C", "-E", "-F", "-I", "-K", "--directory", "--encoding"].includes(argument)) {
      if (argv[index + 1] === undefined) {
        return { entrypoints: [...entrypoints], reliable: false };
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    reliable &&= addPath(entrypoints, baseDirectory, argument, analysis, {
      requireScriptShape: false,
    });
    break;
  }
  if (entrypoints.size === 0 && redirectedInput !== undefined) {
    reliable &&= addPath(entrypoints, baseDirectory, redirectedInput, analysis, {
      requireScriptShape: false,
    });
  }
  return { entrypoints: [...entrypoints], reliable };
}
