import { isRecord } from "../security/record.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loaderModuleSpecifier } from "../extensions/profile.js";

import type { DshPolicyRule } from "./composition.js";
import type { DshOperation } from "./schema.js";
import type { NativeToolId } from "../tools/schema.js";
import { mcpPublicToolName } from "../extensions/plan.js";
import type { EffectiveExtensionPlan, ExtensionToolGrant } from "../extensions/plan.js";

export const CONTROLLED_PROFILE_NAME = "github-action" as const;
const PROFILE_BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] as const;

interface ControlledProfilePaths {
  readonly profileDir: string;
  readonly rootPath: string;
  readonly manifestPath: string;
  readonly patchPath: string;
  readonly workspacePath: string;
  readonly statePath: string;
  readonly auditPath: string;
  readonly rules: readonly DshPolicyRule[];
}

interface PrepareControlledProfileOptions {
  readonly dshHome: string;
  readonly plan: EffectiveExtensionPlan;
  readonly nativeTools: readonly NativeToolId[];
  readonly workspaceWrite: boolean;
  readonly expectedOperation: DshOperation;
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

// A DSH row can register more tools than one logical Controller grant allows.
// Keep that row inventory together so the allowlist and pre-restriction inventory
// cannot drift independently (tool-fs registers both read and write tools).
const nativeToolGroups: readonly {
  readonly rows: readonly string[];
  readonly grants: Partial<Record<NativeToolId, readonly string[]>>;
}[] = [
  {
    rows: ["tool-fs"],
    grants: { "workspace.read": ["read", "read_image"], "workspace.edit": ["write", "edit"] },
  },
  { rows: ["tool-fs-search"], grants: { "workspace.search": ["glob", "grep"] } },
  { rows: ["tool-str-replace-editor"], grants: { "workspace.edit": ["str_replace_editor"] } },
  { rows: ["tool-bash"], grants: { "native.bash": ["bash"] } },
  {
    rows: ["web", "web-deepseek-api", "tool-web"],
    grants: { "native.web-search": ["web_search"], "native.web-fetch": ["web_fetch"] },
  },
  {
    rows: ["subagent", "subagent-spawn-in-process", "tool-subagent"],
    grants: { "native.subagent": ["subagent"] },
  },
];

function runtimeNamesForGrant(id: NativeToolId): readonly string[] {
  return nativeToolGroups.flatMap(({ grants }) => grants[id] ?? []);
}

export function nativeRuntimeToolNames(tools: readonly NativeToolId[]): readonly string[] {
  return [...new Set(tools.flatMap(runtimeNamesForGrant))].sort((left, right) =>
    left.localeCompare(right),
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
  if (id === "native.web-search" || id === "native.web-fetch") {
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
    runtimeNamesForGrant(id).map((runtimeName) => ({
      id,
      runtimeName,
      provider: "builtin" as const,
      ...nativeRuleLimits(id),
    })),
  );
}

function knownNativeRuntimeTools(tools: readonly NativeToolId[]): readonly string[] {
  return nativeToolGroups.flatMap(({ grants }) =>
    tools.some((tool) => grants[tool] !== undefined) ? Object.values(grants).flat() : [],
  );
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
    // The official rc.2 MCP client exposes one timeout for the whole server.
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

const ALWAYS_DISABLED_BASE_ROWS = [
  "tool-working-directory",
  "web-search-deepseek",
  "session-title-llm",
  "session-telemetry-otel",
  "session-log-deepseek",
  "plugin-package-inventory-deepseek",
  "web-fetch-http",
  "mcp-resources",
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
  "workflow-ptc",
  "tool-workflow",
  "tool-ralph",
  "ptc-runtime",
] as const;

function controlledRows(
  options: PrepareControlledProfileOptions,
): readonly Record<string, unknown>[] {
  const enabled = new Set(options.nativeTools);
  const mode = options.workspaceWrite ? "workspace-write" : "read-only";
  const disabled = [
    ...ALWAYS_DISABLED_BASE_ROWS,
    ...nativeToolGroups.flatMap(({ rows, grants }) =>
      options.nativeTools.some((tool) => grants[tool] !== undefined) ? [] : rows,
    ),
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
              maxDepth: 1,
            },
          },
        ]
      : []),
    ...(enabled.has("native.web-search") || enabled.has("native.web-fetch")
      ? [
          {
            id: "web",
            name: "@deepseek-ai/dsh-web",
            config: { searchProvider: "deepseek-search-api", fetchProvider: "deepseek-fetch-api" },
          },
          {
            id: "web-deepseek-api",
            name: "@deepseek-ai/dsh-web-deepseek-api",
            config: { apiKeyEnv: "DEEPSEEK_API_KEY" },
          },
          {
            id: "tool-web",
            name: "@deepseek-ai/dsh-tool-web",
            config: {
              search: enabled.has("native.web-search"),
              fetch: enabled.has("native.web-fetch"),
              searchTimeoutMs: 60_000,
            },
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
      config: { task: options.task, json: true },
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
    // 0.1.7 no longer ships this row in dsh-base. Cordis id patches only
    // update existing rows, so retaining the Action editor requires insertion.
    ...(options.nativeTools.includes("workspace.edit")
      ? [{ id: "tool-str-replace-editor", name: "@deepseek-ai/dsh-tool-str-replace-editor" }]
      : []),
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
        expectedOperation: options.expectedOperation,
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
  const baseDependencies = isRecord(options.manifestBase.dependencies)
    ? options.manifestBase.dependencies
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
