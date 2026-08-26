import type { ActionInputs, ControlledActionInputs, NativeActionInputs } from "../src/inputs.js";
import type { GitHubContext } from "../src/github/context.js";
import type { PermissionCheck } from "../src/github/permissions.js";
import { DSH_VERSION } from "../src/release.js";

type ControlledInputOverrides = Partial<ControlledActionInputs> & {
  readonly dshMode?: "controlled";
};
type NativeInputOverrides = Partial<NativeActionInputs> & { readonly dshMode: "native" };
type DynamicModeInputOverrides = Partial<
  Omit<ControlledActionInputs, "dshMode" | "mcpConfig" | "pluginConfig">
> & { readonly dshMode: ActionInputs["dshMode"] };
type CommonTestInputs = Omit<ControlledActionInputs, "dshMode" | "mcpConfig" | "pluginConfig">;

export function inputs(overrides: NativeInputOverrides): NativeActionInputs;
export function inputs(overrides?: ControlledInputOverrides): ControlledActionInputs;
export function inputs(overrides: DynamicModeInputOverrides): ActionInputs;
export function inputs(
  overrides: ControlledInputOverrides | NativeInputOverrides | DynamicModeInputOverrides = {},
): ActionInputs {
  const common: CommonTestInputs = {
    deepseekApiKey: "secret",
    githubToken: "token",
    allowWrite: false,
    command: "auto",
    taskAccess: "read",
    prompt: "",
    dshVersion: DSH_VERSION,
    dshExecutable: "",
    isolation: "docker",
    containerImage: "node:24-bookworm",
    timeoutMinutes: 20,
    maxFindings: 20,
    runTests: true,
    testCommands: [],
    baseUrl: "https://api.deepseek.com",
    webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
    botUserId: 41898282,
    progressComment: true,
    triggerPhrase: "@dsh",
    labelTrigger: "",
    assigneeTrigger: "",
    allowedActors: ["*"],
    allowedBots: [],
    includeCommentsByActor: [],
    excludeCommentsByActor: [],
    baseBranch: "",
    branchPrefix: "dsh/",
    branchNameTemplate: "",
    maxTurns: 3,
    permissionProfile: "strict",
    validationIntegrity: "warn",
    allowPluginInstall: false,
    allowedTools: ["workspace.read", "workspace.search", "workspace.edit"],
    disallowedTools: [],
    toolConfig: { schemaVersion: 1, commands: [] },
  };
  if (overrides.dshMode === "native") {
    const mcpConfig = "mcpConfig" in overrides ? overrides.mcpConfig : undefined;
    const pluginConfig = "pluginConfig" in overrides ? overrides.pluginConfig : undefined;
    return {
      ...common,
      ...overrides,
      dshMode: "native",
      mcpConfig: mcpConfig ?? { schemaVersion: 1, servers: [] },
      pluginConfig: pluginConfig ?? { schemaVersion: 1, bundles: [], plugins: [] },
    };
  }
  const mcpConfig = "mcpConfig" in overrides ? overrides.mcpConfig : undefined;
  const pluginConfig = "pluginConfig" in overrides ? overrides.pluginConfig : undefined;
  return {
    ...common,
    ...overrides,
    dshMode: "controlled",
    mcpConfig: mcpConfig ?? { schemaVersion: 1, servers: [] },
    pluginConfig: pluginConfig ?? { schemaVersion: 1, bundles: [], plugins: [] },
  };
}

export function pullRequestContext(
  overrides: Partial<GitHubContext> & { fork?: boolean } = {},
): GitHubContext {
  const { fork = false, ...contextOverrides } = overrides;
  return {
    kind: "entity",
    rawEventName: "pull_request",
    eventName: "pull_request",
    eventAction: "opened",
    runId: "10",
    actor: "alice",
    repository: { id: 1, owner: "octo", repo: "repo", fullName: "octo/repo" },
    payload: {},
    isPullRequestTarget: false,
    entityNumber: 7,
    isPullRequest: true,
    pullRequest: {
      number: 7,
      draft: false,
      headSha: "a".repeat(40),
      headRef: "feature",
      headRepository: fork ? "contributor/repo" : "octo/repo",
      headRepositoryId: fork ? 2 : 1,
      baseSha: "b".repeat(40),
      baseRef: "main",
      baseRepository: "octo/repo",
      baseRepositoryId: 1,
      isFork: fork,
    },
    ...contextOverrides,
  };
}

export function permissions(canWrite: boolean): PermissionCheck {
  return {
    actors: [
      {
        actor: "alice",
        accountType: "User",
        permission: canWrite ? "write" : "read",
        hasWrite: canWrite,
        allowedBot: false,
      },
    ],
    allActorsHaveWrite: canWrite,
    allActorsAllowedForWrite: canWrite,
  };
}
