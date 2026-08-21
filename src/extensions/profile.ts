import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { NativeToolId } from "../tools/schema.js";
import { mcpPublicToolName } from "./plan.js";
import type { EffectiveExtensionPlan, ExtensionToolGrant } from "./plan.js";

export const CONTROLLED_PROFILE_NAME = "github-action" as const;
export const PROFILE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] as const;

export interface DshPolicyRule {
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: "builtin" | "mcp" | "plugin";
  readonly groupId: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCalls: number;
  readonly groupMaxCalls: number;
}

export interface ControlledProfilePaths {
  readonly profileDir: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly patchPath: string;
  readonly workspacePath: string;
  readonly statePath: string;
  readonly auditPath: string;
  readonly rules: readonly DshPolicyRule[];
}

export interface PrepareControlledProfileOptions {
  readonly dshHome: string;
  readonly plan: EffectiveExtensionPlan;
  readonly nativeTools: readonly NativeToolId[];
  readonly workspaceWrite: boolean;
  readonly task: string;
  readonly workerWorkspacePath: string;
  readonly policyPluginPath: string;
  readonly workspacePluginPath: string;
  readonly workerStatePath: string;
  readonly workerAuditPath: string;
  readonly manifestBase: Readonly<Record<string, unknown>>;
  /** Absolute worker-side entry modules for installed direct Cordis plugins. */
  readonly pluginModuleSpecifiers?: Readonly<Record<string, string>>;
}

const nativeRuntimeTools: Readonly<Record<NativeToolId, readonly string[]>> = {
  "workspace.read": ["read", "read_image"],
  "workspace.search": ["glob", "grep"],
  "workspace.edit": ["write", "edit", "str_replace_editor"],
  "native.bash": ["bash"],
  "native.web-search": ["web_search"],
  "native.subagent": ["subagent"],
};

export function nativeRuntimeToolNames(tools: readonly NativeToolId[]): readonly string[] {
  return [...new Set(tools.flatMap((logicalId) => nativeRuntimeTools[logicalId]))].sort(
    (left, right) => left.localeCompare(right),
  );
}

function nativeRuleLimits(
  id: NativeToolId,
): Pick<DshPolicyRule, "groupId" | "timeoutMs" | "maxOutputBytes" | "maxCalls" | "groupMaxCalls"> {
  if (id === "native.bash") {
    return {
      groupId: "builtin.bash",
      timeoutMs: 65_000,
      maxOutputBytes: 512 * 1024,
      maxCalls: 40,
      groupMaxCalls: 40,
    };
  }
  if (id === "native.web-search") {
    return {
      groupId: "builtin.web",
      timeoutMs: 65_000,
      maxOutputBytes: 256 * 1024,
      maxCalls: 10,
      groupMaxCalls: 10,
    };
  }
  if (id === "native.subagent") {
    return {
      groupId: "builtin.subagent",
      timeoutMs: 5 * 60_000,
      maxOutputBytes: 512 * 1024,
      maxCalls: 4,
      groupMaxCalls: 4,
    };
  }
  return {
    groupId: "builtin.workspace",
    timeoutMs: 60_000,
    maxOutputBytes: 256 * 1024,
    maxCalls: 100,
    groupMaxCalls: 500,
  };
}

function nativeRules(tools: readonly NativeToolId[]): DshPolicyRule[] {
  return tools.flatMap((id) =>
    nativeRuntimeTools[id].map((runtimeName) => ({
      id,
      runtimeName,
      provider: "builtin" as const,
      ...nativeRuleLimits(id),
    })),
  );
}

function knownNativeRuntimeTools(tools: readonly NativeToolId[]): readonly string[] {
  const enabled = new Set(tools);
  return [
    ...(enabled.has("workspace.read") || enabled.has("workspace.edit")
      ? ["read", "read_image", "write", "edit"]
      : []),
    ...(enabled.has("workspace.search") ? ["glob", "grep"] : []),
    ...(enabled.has("workspace.edit") ? ["str_replace_editor"] : []),
    ...(enabled.has("native.bash") ? ["bash"] : []),
    ...(enabled.has("native.web-search") ? ["web_search"] : []),
    ...(enabled.has("native.subagent") ? ["subagent"] : []),
  ];
}

function knownExtensionRuntimeTools(plan: EffectiveExtensionPlan): readonly string[] {
  return [
    ...plan.mcpServers.flatMap((server) =>
      server.definition.tools.map((tool) => mcpPublicToolName(server.definition.id, tool.name)),
    ),
    ...plan.bundles.flatMap((bundle) => bundle.definition.tools.map((tool) => tool.name)),
    ...plan.plugins.flatMap((plugin) => plugin.definition.tools.map((tool) => tool.name)),
  ];
}

function extensionRule(tool: ExtensionToolGrant): DshPolicyRule {
  return {
    id: tool.id,
    runtimeName: tool.runtimeName,
    provider: tool.provider,
    groupId: `${tool.ownerKind}.${tool.ownerId}`,
    timeoutMs: tool.timeoutMs,
    maxOutputBytes: tool.maxOutputBytes,
    maxCalls: tool.maxCalls,
    groupMaxCalls: tool.groupMaxCalls,
  };
}

function mcpEntry(
  server: EffectiveExtensionPlan["mcpServers"][number],
  workerWorkspacePath: string,
): Record<string, unknown> {
  const definition = server.definition;
  const common = {
    serverName: definition.id,
    transport: definition.transport,
    // The official rc.8 MCP client exposes one timeout for the whole server.
    // Use the widest approved tool timeout here; the Action-owned ToolRuntime
    // policy still applies each tool's smaller cooperative deadline.
    toolCallTimeoutMs: Math.max(...server.tools.map((tool) => tool.timeoutMs)),
    failOnStartupError: true,
    reconnect: definition.reconnect,
  };
  const config =
    definition.transport === "stdio"
      ? {
          ...common,
          command: definition.command,
          args: definition.args,
          env: definition.env,
          cwd:
            definition.cwd === undefined
              ? workerWorkspacePath
              : `${workerWorkspacePath.replace(/[\\/]$/u, "")}/${definition.cwd.replaceAll("\\", "/")}`,
        }
      : {
          ...common,
          url: definition.url,
          headers: definition.headers,
        };
  return {
    id: `dsh-action-mcp-${definition.id}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config,
  };
}

function pluginEntry(
  plugin: EffectiveExtensionPlan["plugins"][number],
  moduleSpecifiers: Readonly<Record<string, string>> | undefined,
): Record<string, unknown> {
  // The first Profile render happens before npm installs approved extensions.
  // Keep that intermediate patch unbootable rather than resolving a bare name
  // from the Action package. The Controller replaces it with the verified
  // package entry before starting DSH.
  const moduleSpecifier =
    moduleSpecifiers?.[plugin.definition.id] ??
    `file:///__dsh_action_unresolved_plugin__/${plugin.definition.id}.mjs`;
  return {
    id: `dsh-action-plugin-${plugin.definition.id}`,
    name: loaderModuleSpecifier(moduleSpecifier),
    config: plugin.definition.config,
  };
}

function loaderModuleSpecifier(path: string): string {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? pathToFileURL(path).href : path;
}

const ALWAYS_DISABLED_BASE_ROWS = [
  "session-title-llm",
  "session-telemetry-otel",
  "user-questions",
  "agent-instructions",
  "skill",
  "skill-filesystem",
  "skill-badge",
  "tool-skill",
  "commands",
  "command-feedback",
  "goal",
  "goal-round-driver",
  "command-goal",
  "plan-mode",
  "command-compact",
  "tool-pwsh",
  "tool-jobs",
  "tool-todo",
  "tool-goal",
  "subagent-fork-in-process",
  "tool-subagent-control",
  "tool-subagent-list-agents",
  "tool-subagent-fork",
  "tool-subagent-report",
  "workflow-worker-thread",
  "tool-workflow",
  "tool-ralph",
  "code-runtime",
] as const;

function controlledRows(
  options: PrepareControlledProfileOptions,
): readonly Record<string, unknown>[] {
  const enabled = new Set(options.nativeTools);
  const mode = options.workspaceWrite ? "workspace-write" : "read-only";
  const disabled = [
    ...ALWAYS_DISABLED_BASE_ROWS,
    ...(!enabled.has("native.bash") ? ["tool-bash"] : []),
    ...(!enabled.has("native.subagent")
      ? ["subagent", "subagent-spawn-in-process", "tool-subagent"]
      : []),
    ...(!enabled.has("native.web-search") ? ["web", "web-search-deepseek", "tool-web"] : []),
    ...(!enabled.has("workspace.read") && !enabled.has("workspace.edit") ? ["tool-fs"] : []),
    ...(!enabled.has("workspace.search") ? ["tool-fs-search"] : []),
    ...(!enabled.has("workspace.edit") ? ["tool-str-replace-editor"] : []),
  ];
  return [
    {
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      config: { mode, workspaceRoot: options.workerWorkspacePath },
    },
    ...(enabled.has("native.bash")
      ? [
          {
            id: "tool-bash",
            name: "@deepseek-ai/dsh-tool-bash",
            config: { enableRunInBackground: false },
          },
        ]
      : []),
    ...(enabled.has("native.subagent")
      ? [
          { id: "subagent", name: "@deepseek-ai/dsh-subagent" },
          {
            id: "subagent-spawn-in-process",
            name: "@deepseek-ai/dsh-subagent-spawn-in-process",
            config: { providerName: "spawn" },
          },
          {
            id: "tool-subagent",
            name: "@deepseek-ai/dsh-tool-subagent",
            config: {
              provider: "spawn",
              toolName: "subagent",
              enableRunInBackground: false,
              backgroundMode: "one-shot",
              maxDepth: 1,
              toolFilter: {
                allow: [
                  ...new Set([
                    ...nativeRules(options.nativeTools).map(({ runtimeName }) => runtimeName),
                    ...options.plan.tools.map(({ runtimeName }) => runtimeName),
                  ]),
                ],
              },
            },
          },
        ]
      : []),
    ...(enabled.has("native.web-search")
      ? [
          {
            id: "web",
            name: "@deepseek-ai/dsh-web",
            config: { searchProvider: "deepseek-official" },
          },
          {
            id: "web-search-deepseek",
            name: "@deepseek-ai/dsh-web-search-deepseek",
            config: { apiKeyEnv: "DEEPSEEK_API_KEY" },
          },
          {
            id: "tool-web",
            name: "@deepseek-ai/dsh-tool-web",
            config: { search: true, fetch: false, searchTimeoutMs: 60_000 },
          },
        ]
      : []),
    {
      id: "fs-sandbox",
      name: "@deepseek-ai/dsh-fs-sandbox",
      config: { cwd: options.workerWorkspacePath },
    },
    { id: "approval", name: "@deepseek-ai/dsh-user-approval", config: { policy: "never" } },
    {
      id: "permission",
      name: "@deepseek-ai/dsh-permission-presets",
      config: {
        presets: { [mode]: { sandbox: mode, approval: "never" } },
        defaultPreset: mode,
      },
    },
    {
      id: "headless-runner",
      name: "@deepseek-ai/dsh-headless",
      inject: ["headlessStartup", "actionWorkspace"],
      config: { task: options.task },
    },
    ...disabled.map((id) => ({ id, disabled: true })),
  ];
}

export function renderControlledProfilePatch(options: PrepareControlledProfileOptions): {
  readonly patch: string;
  readonly rules: readonly DshPolicyRule[];
} {
  const rules = [
    ...nativeRules(options.nativeTools),
    ...options.plan.tools.map((tool) => extensionRule(tool)),
  ];
  const entries = [
    {
      id: "dsh-action-workspace",
      name: loaderModuleSpecifier(options.workspacePluginPath),
      config: { cwd: options.workerWorkspacePath },
    },
    ...options.plan.mcpServers.map((server) => mcpEntry(server, options.workerWorkspacePath)),
    ...options.plan.plugins.map((plugin) => pluginEntry(plugin, options.pluginModuleSpecifiers)),
    {
      id: "dsh-action-policy",
      name: loaderModuleSpecifier(options.policyPluginPath),
      config: {
        allowedRuntimeTools: rules.map((rule) => rule.runtimeName),
        knownRuntimeTools: [
          ...new Set([
            ...knownNativeRuntimeTools(options.nativeTools),
            ...knownExtensionRuntimeTools(options.plan),
          ]),
        ],
        rules,
        statePath: options.workerStatePath,
        auditPath: options.workerAuditPath,
      },
    },
  ];
  // JSON is valid YAML. Keeping every workflow value JSON-quoted prevents a
  // string from becoming a Cordis `!!js` expression or a new patch row.
  return {
    patch: `${JSON.stringify([...controlledRows(options), { insert: entries }], undefined, 2)}\n`,
    rules,
  };
}

interface PackageManifest {
  readonly name?: unknown;
  readonly main?: unknown;
  readonly exports?: unknown;
}

function importExportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = importExportTarget(candidate);
      if (target !== undefined) return target;
    }
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(record, ".")) return importExportTarget(record["."]);
  for (const [condition, candidate] of Object.entries(record)) {
    if (condition !== "node" && condition !== "import" && condition !== "default") continue;
    const target = importExportTarget(candidate);
    if (target !== undefined) return target;
  }
  return undefined;
}

function insideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function installedPluginEntry(
  packageDirectory: string,
  packageName: string,
): Promise<string> {
  const packageReal = await realpath(packageDirectory);
  const manifest = JSON.parse(
    await readFile(join(packageReal, "package.json"), "utf8"),
  ) as PackageManifest;
  if (manifest.name !== packageName) {
    throw new Error(`Installed direct plugin package identity mismatch: ${packageName}`);
  }
  const target =
    manifest.exports === undefined
      ? typeof manifest.main === "string"
        ? manifest.main
        : "./index.js"
      : importExportTarget(manifest.exports);
  if (!target?.startsWith("./")) {
    throw new Error(`Direct plugin ${packageName} has no importable root export`);
  }
  let entry = resolve(packageReal, target);
  const details = await stat(entry);
  if (details.isDirectory()) entry = join(entry, "index.js");
  const entryReal = await realpath(entry);
  if (!insideDirectory(packageReal, entryReal)) {
    throw new Error(`Direct plugin ${packageName} entry escapes the installed package`);
  }
  return entryReal;
}

function workerModulePath(workerProfilePath: string, relativeEntry: string): string {
  const parts = relativeEntry.split(/[\\/]/u);
  return workerProfilePath.startsWith("/")
    ? posix.join(workerProfilePath, ...parts)
    : join(workerProfilePath, ...parts);
}

/** Resolve approved direct plugins from the controlled Profile installation root. */
export async function resolveInstalledPluginModuleSpecifiers(options: {
  readonly packageRoot: string;
  readonly workerProfilePath: string;
  readonly plan: Pick<EffectiveExtensionPlan, "plugins">;
}): Promise<Readonly<Record<string, string>>> {
  const packageRootReal = await realpath(options.packageRoot);
  const resolved: Record<string, string> = {};
  for (const plugin of options.plan.plugins) {
    const packageDirectory = join(
      packageRootReal,
      "node_modules",
      ...plugin.definition.package.split("/"),
    );
    const hostEntry = await installedPluginEntry(packageDirectory, plugin.definition.package);
    if (!insideDirectory(packageRootReal, hostEntry)) {
      throw new Error(`Direct plugin ${plugin.definition.package} resolves outside the Profile`);
    }
    const workerEntry = workerModulePath(
      options.workerProfilePath,
      relative(packageRootReal, hostEntry),
    );
    resolved[plugin.definition.id] = loaderModuleSpecifier(workerEntry);
  }
  return Object.freeze(resolved);
}

export async function prepareControlledProfile(
  options: PrepareControlledProfileOptions,
): Promise<ControlledProfilePaths> {
  const profileDir = join(options.dshHome, "profiles", CONTROLLED_PROFILE_NAME);
  const rootPath = join(profileDir, "action-root.yml");
  const manifestPath = join(profileDir, "package.json");
  const patchPath = join(profileDir, "cordis.patch.yml");
  const workspacePath = join(profileDir, "pnpm-workspace.yaml");
  const statePath = join(options.dshHome, "action-state", "tool-counts.json");
  const auditPath = join(options.dshHome, "action-state", "tool-receipts.jsonl");
  const bundles = [
    ...PROFILE_BUNDLES,
    ...options.plan.bundles.map((bundle) => bundle.definition.package),
  ];
  const baseDependencies =
    typeof options.manifestBase.dependencies === "object" &&
    options.manifestBase.dependencies !== null &&
    !Array.isArray(options.manifestBase.dependencies)
      ? (options.manifestBase.dependencies as Readonly<Record<string, unknown>>)
      : {};
  const manifest = {
    ...options.manifestBase,
    name: "dsh-profile-github-action",
    private: true,
    dependencies: { ...baseDependencies, ...options.plan.packageDependencies },
    dsh: { profile: { bundles } },
  };
  const rendered = renderControlledProfilePatch(options);
  await mkdir(profileDir, { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(patchPath, rendered.patch, { encoding: "utf8", mode: 0o600 });
  await writeFile(
    rootPath,
    "# Controller-owned empty Profile root; Bundle/Profile patches compose the tree.\n[]\n",
    { encoding: "utf8", mode: 0o600 },
  );
  await writeFile(
    workspacePath,
    "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
    { encoding: "utf8", mode: 0o600 },
  );
  return {
    profileDir,
    rootPath,
    manifestPath,
    patchPath,
    workspacePath,
    statePath,
    auditPath,
    rules: rendered.rules,
  };
}
