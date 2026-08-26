import { DSH_VERSION } from "./release.js";

export const DEFAULT_CONTAINER_IMAGE =
  "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059" as const;

export const ACTION_INPUT_DOC_GROUPS = [
  { id: "credentials", title: "Credentials and API routing" },
  { id: "operation", title: "Operation and publication" },
  { id: "routing", title: "Routing, filters, and branch UX" },
  { id: "runtime", title: "Runtime, isolation, and limits" },
  { id: "validation", title: "Validation" },
  { id: "tools", title: "Agent tools and extensions" },
] as const;

export type ActionInputDocsGroup = (typeof ACTION_INPUT_DOC_GROUPS)[number]["id"];

export interface ActionPublicInputDefinition {
  readonly name: string;
  readonly runtimeKey: string;
  readonly required: boolean;
  readonly default?: string;
  readonly description: string;
  readonly docsGroup: ActionInputDocsGroup;
  /** Installer metadata is generated only for the small subset the installer consumes. */
  readonly installer?: boolean;
}

/**
 * Typed single source of truth for the public Action input metadata.
 *
 * Runtime parsing and security validation deliberately remain in `inputs.ts`.
 */
export const ACTION_INPUT_CONTRACT = [
  {
    name: "deepseek-api-key",
    runtimeKey: "deepseekApiKey",
    required: true,
    description:
      "DeepSeek API key. Kept by the controller-side credential proxy; never passed to DSH or repository code.",
    docsGroup: "credentials",
  },
  {
    name: "github-token",
    runtimeKey: "githubToken",
    required: false,
    default: "${{ github.token }}",
    description: "GitHub token used only by the trusted controller.",
    docsGroup: "credentials",
  },
  {
    name: "allow-write",
    runtimeKey: "allowWrite",
    required: false,
    default: "false",
    description:
      "Allow trusted same-repository task/fix/implement writes after all trust gates pass.",
    docsGroup: "operation",
  },
  {
    name: "command",
    runtimeKey: "command",
    required: false,
    default: "auto",
    description: "Optional explicit operation: task, review, diagnose, fix, implement, or auto.",
    docsGroup: "operation",
  },
  {
    name: "task-access",
    runtimeKey: "taskAccess",
    required: false,
    default: "read",
    description:
      "Capability requested by an explicit task: read or write. Write still requires allow-write and every policy gate.",
    docsGroup: "operation",
  },
  {
    name: "prompt",
    runtimeKey: "prompt",
    required: false,
    default: "",
    description:
      "Trusted task prompt. With command=auto on dispatch/schedule events, a non-empty prompt selects generic task mode.",
    docsGroup: "operation",
  },
  {
    name: "trigger-phrase",
    runtimeKey: "triggerPhrase",
    required: false,
    default: "@dsh",
    description:
      "Maintainer-controlled literal used for first-line comment commands. Routing only; it never grants authority.",
    docsGroup: "routing",
  },
  {
    name: "label-trigger",
    runtimeKey: "labelTrigger",
    required: false,
    default: "",
    description:
      "Optional exact label that routes Issue tasks or pull request reviews. Empty disables this route.",
    docsGroup: "routing",
  },
  {
    name: "assignee-trigger",
    runtimeKey: "assigneeTrigger",
    required: false,
    default: "",
    description:
      "Optional exact assignee login that routes Issue tasks or pull request reviews. Empty disables this route.",
    docsGroup: "routing",
  },
  {
    name: "allowed-actors",
    runtimeKey: "allowedActors",
    required: false,
    default: "*",
    description:
      "Comma-separated maintainer routing allowlist for originating actors. * preserves the default route; authorization remains separate.",
    docsGroup: "routing",
  },
  {
    name: "allowed-bots",
    runtimeKey: "allowedBots",
    required: false,
    default: "",
    description:
      "Comma-separated bot allowlist. Empty preserves the fail-closed bot write gate; listed bots still need repository write permission.",
    docsGroup: "routing",
  },
  {
    name: "include-comments-by-actor",
    runtimeKey: "includeCommentsByActor",
    required: false,
    default: "",
    description:
      "Optional comma-separated allowlist for historical comments included as untrusted context. The audited trigger comment is retained.",
    docsGroup: "routing",
  },
  {
    name: "exclude-comments-by-actor",
    runtimeKey: "excludeCommentsByActor",
    required: false,
    default: "",
    description:
      "Optional comma-separated deny list for historical comment context. Exclusion wins over inclusion.",
    docsGroup: "routing",
  },
  {
    name: "base-branch",
    runtimeKey: "baseBranch",
    required: false,
    default: "",
    description:
      "Maintainer-selected base branch for Issue and automation tasks. Empty uses the trusted repository default branch; PR fixes stay bound to their head.",
    docsGroup: "routing",
  },
  {
    name: "branch-prefix",
    runtimeKey: "branchPrefix",
    required: false,
    default: "dsh/",
    description: "Validated prefix for Controller-created task branches.",
    docsGroup: "routing",
  },
  {
    name: "branch-name-template",
    runtimeKey: "branchNameTemplate",
    required: false,
    default: "",
    description:
      "Optional deterministic branch template using {{prefix}}, {{key}}, {{operation}}, {{entityType}}, and {{entityNumber}}; {{prefix}} and {{key}} are required.",
    docsGroup: "routing",
  },
  {
    name: "task-output-schema",
    runtimeKey: "taskOutputSchema",
    required: false,
    default: "",
    description:
      "Optional bounded maintainer-owned JSON Schema for a Controller-validated taskOutput. It never replaces result-json or grants authority.",
    docsGroup: "operation",
  },
  {
    name: "dsh-mode",
    runtimeKey: "dshMode",
    required: false,
    default: "controlled",
    description:
      "DSH composition ownership: controlled preserves the Controller-owned ToolRuntime policy; experimental native uses the official DSH headless Profile, MCP, Bundle, Plugin, Skill, Subagent, and Workflow graph inside the Action's Docker safety boundary.",
    docsGroup: "runtime",
    installer: true,
  },
  {
    name: "dsh-version",
    runtimeKey: "dshVersion",
    required: false,
    default: DSH_VERSION,
    description: `Pinned @deepseek-ai/dsh version. The Action accepts only the audited ${DSH_VERSION} runtime.`,
    docsGroup: "runtime",
  },
  {
    name: "dsh-executable",
    runtimeKey: "dshExecutable",
    required: false,
    default: "",
    description:
      "Trusted capability input. Optional absolute path to a preinstalled DSH executable; host mode executes it without a container boundary.",
    docsGroup: "runtime",
  },
  {
    name: "isolation",
    runtimeKey: "isolation",
    required: false,
    default: "docker",
    description:
      "Trusted capability input selecting the DSH isolation backend. 'none' removes the OS/container boundary; Docker is required for untrusted review data, writes, and extensions.",
    docsGroup: "runtime",
  },
  {
    name: "container-image",
    runtimeKey: "containerImage",
    required: false,
    default: DEFAULT_CONTAINER_IMAGE,
    description:
      "Trusted worker-code input. Every value must be one Docker/OCI image reference and cannot be parsed as a Docker option; extensions and writes require a full name@sha256 digest.",
    docsGroup: "runtime",
  },
  {
    name: "timeout-minutes",
    runtimeKey: "timeoutMinutes",
    required: false,
    default: "20",
    description:
      "Overall setup/execution deadline shared by runtime and extension install, DSH turns, command tools, and validation. Fixed short cleanup/finalization grace may run after it.",
    docsGroup: "runtime",
  },
  {
    name: "max-findings",
    runtimeKey: "maxFindings",
    required: false,
    default: "20",
    description: "Maximum high-confidence findings to publish.",
    docsGroup: "operation",
  },
  {
    name: "run-tests",
    runtimeKey: "runTests",
    required: false,
    default: "true",
    description:
      "Must be true for every code, Git ref, and pull-request mutation. false denies the mutation and is not a validation waiver.",
    docsGroup: "validation",
  },
  {
    name: "test-commands",
    runtimeKey: "testCommands",
    required: false,
    default: "[]",
    description:
      'Non-empty JSON array of credential-free argv arrays required for every write, e.g. [["npm","test"]]. Every command must pass; Controller credentials in argv are rejected.',
    docsGroup: "validation",
  },
  {
    name: "validation-integrity",
    runtimeKey: "validationIntegrity",
    required: false,
    default: "warn",
    description:
      "Controller-owned validation-definition policy: off records, warn reports, strict blocks high-confidence weakening and replays baseline controls when needed.",
    docsGroup: "validation",
  },
  {
    name: "base-url",
    runtimeKey: "baseUrl",
    required: false,
    default: "https://api.deepseek.com",
    description:
      "Trusted credential-routing input. The controller-side proxy forwards DeepSeek requests to this URL; never derive it from untrusted content.",
    docsGroup: "credentials",
  },
  {
    name: "web-search-base-url",
    runtimeKey: "webSearchBaseUrl",
    required: false,
    default: "https://api.deepseek.com/anthropic/v1",
    description:
      "Trusted credential-routing input for the Controller-mediated DeepSeek Anthropic Messages web-search endpoint.",
    docsGroup: "credentials",
  },
  {
    name: "bot-user-id",
    runtimeKey: "botUserId",
    required: false,
    default: "41898282",
    description:
      "Numeric ID of the bot account that owns tracking comments. Defaults to github-actions[bot].",
    docsGroup: "credentials",
  },
  {
    name: "progress-comment",
    runtimeKey: "progressComment",
    required: false,
    default: "true",
    description:
      "Create or update one controller-owned sticky comment at major lifecycle stages, reusing the operation's result marker.",
    docsGroup: "operation",
  },
  {
    name: "max-turns",
    runtimeKey: "maxTurns",
    required: false,
    default: "3",
    description: "Maximum fresh DSH turns across tool requests and validation repair attempts.",
    docsGroup: "runtime",
  },
  {
    name: "permission-profile",
    runtimeKey: "permissionProfile",
    required: false,
    default: "strict",
    description:
      "Agent tool preset: strict preserves v0.4 behavior, standard grants trusted coding conveniences, and custom uses the exact allow/deny lists.",
    docsGroup: "tools",
  },
  {
    name: "allowed-tools",
    runtimeKey: "allowedTools",
    required: false,
    default: "[]",
    description:
      "JSON allowlist of Action/controlled capabilities. controlled accepts workspace.*, native.*, command.*, typed github.*, mcp.*, and plugin.* IDs; native rejects mcp./plugin. grants because DSH owns that inventory.",
    docsGroup: "tools",
  },
  {
    name: "disallowed-tools",
    runtimeKey: "disallowedTools",
    required: false,
    default: "[]",
    description:
      "JSON deny list using the same exact tool IDs as allowed-tools. Deny always wins after preset expansion.",
    docsGroup: "tools",
  },
  {
    name: "tool-config",
    runtimeKey: "toolConfig",
    required: false,
    default: '{"schemaVersion":1,"commands":[]}',
    description:
      "Versioned JSON manifest of maintainer-owned fixed-argv command tools. Model-provided argv and controller credentials in argv are rejected; common direct shell executables are also denied.",
    docsGroup: "tools",
  },
  {
    name: "mcp-config",
    runtimeKey: "mcpConfig",
    required: false,
    default: '{"schemaVersion":1,"servers":[]}',
    description:
      "Versioned maintainer-owned official DSH MCP config. controlled declares exact tools/budgets; native declares the server, owner-level workspaceWrite/network, toolCallTimeoutMs, and explicit credentialEnv/credentialHeaders because DSH discovers tools.",
    docsGroup: "tools",
  },
  {
    name: "plugin-config",
    runtimeKey: "pluginConfig",
    required: false,
    default: '{"schemaVersion":1,"bundles":[],"plugins":[]}',
    description:
      "Versioned maintainer-owned DSH Bundle/Plugin config. Native entries are definition-only, with direct-Plugin credentialConfig, and load through official Profile/Cordis composition. Startup executes trusted worker code; every package requires an exact semver or GitHub commit pin.",
    docsGroup: "tools",
  },
  {
    name: "allow-plugin-install",
    runtimeKey: "allowPluginInstall",
    required: false,
    default: "false",
    description:
      "Allow startup of explicitly configured and pinned third-party DSH Bundles/Plugins. Disabled by default because installation and startup execute trusted code.",
    docsGroup: "tools",
  },
] as const satisfies readonly ActionPublicInputDefinition[];

export type ActionInputDefinition = (typeof ACTION_INPUT_CONTRACT)[number];
export type ActionInputName = ActionInputDefinition["name"];
export type ActionInputRuntimeKey = ActionInputDefinition["runtimeKey"];
export type DefaultedActionInputRuntimeKey = Extract<
  ActionInputDefinition,
  { readonly default: string }
>["runtimeKey"];

export function actionInputDefinition(runtimeKey: ActionInputRuntimeKey): ActionInputDefinition {
  const definition = ACTION_INPUT_CONTRACT.find((input) => input.runtimeKey === runtimeKey);
  if (definition === undefined) throw new Error(`Unknown Action input runtime key: ${runtimeKey}`);
  return definition;
}

export function actionInputName(runtimeKey: ActionInputRuntimeKey): ActionInputName {
  return actionInputDefinition(runtimeKey).name;
}

export function actionInputDefault(runtimeKey: DefaultedActionInputRuntimeKey): string;
export function actionInputDefault(runtimeKey: ActionInputRuntimeKey): string | undefined;
export function actionInputDefault(runtimeKey: ActionInputRuntimeKey): string | undefined {
  const definition: ActionPublicInputDefinition = actionInputDefinition(runtimeKey);
  return definition.default;
}
