import type { AgentToolManifest } from "../agent/contracts.js";
import type { DshComposition } from "../dsh/composition.js";
import { PolicyDeniedError } from "../errors.js";
import {
  resolveExtensionPlan,
  resolveNativeExtensionPlan,
  type ExtensionPlan,
} from "../extensions/plan.js";
import { createOctokitGitHubToolBackend } from "../github/octokit-tool-backend.js";
import type { ActionInputs } from "../inputs.js";
import { throwIfCancelled } from "../lifecycle/cancellation.js";
import { buildControllerToolPolicyAudit, buildPermissionAudit } from "../permissions/profile.js";
import { buildAuthorityAudit } from "../security/authority.js";
import { redactKnownSecrets } from "../security/env.js";
import {
  CommandToolProvider,
  resolveEffectiveTools,
  type EffectiveTools,
} from "../tools/registry.js";
import { ToolRouter } from "../tools/router.js";
import { buildContextPacket, taskIdentity } from "./context.js";
import { createGitHubToolBinding, GitHubAuthoritySession } from "./github-authority.js";
import { ControllerGitHubMutationValidation } from "./github-validation.js";
import type { RunState } from "./lifecycle.js";
import type { AuthorizedRun } from "./prepare.js";
import type { PreparedWorkspace } from "./workspace.js";

type ContextPacket = Awaited<ReturnType<typeof buildContextPacket>>;

export interface PreparedExecution {
  readonly contextPacket: ContextPacket;
  readonly tools: EffectiveTools & {
    readonly extensions: ExtensionPlan;
    readonly manifests: readonly AgentToolManifest[];
  };
  readonly toolProvider?: ToolRouter;
  readonly extensions: ExtensionPlan;
  readonly operationIdentity: string;
  readonly githubAuthority?: GitHubAuthoritySession;
  readonly githubValidation?: ControllerGitHubMutationValidation;
  readonly hasGitHubMutationTools: boolean;
  readonly selectedComposition: DshComposition;
  readonly redact: (value: string) => string;
}

/** Resolve the exact model-visible capability set and all pre-Agent authority audits. */
export async function prepareExecution(options: {
  readonly state: RunState;
  readonly authorized: AuthorizedRun;
  readonly workspace: PreparedWorkspace;
  readonly inputs: ActionInputs;
  readonly deadlineMs: number;
  readonly signal: AbortSignal;
}): Promise<PreparedExecution> {
  const { state, authorized, workspace, inputs, deadlineMs, signal } = options;
  const { client, context, command, snapshot, policy } = authorized;
  const { agentWorkspace, snapshot: workspaceSnapshot } = workspace;
  const contextPacket = await buildContextPacket(client, context, command, snapshot, inputs);
  throwIfCancelled(signal);
  const trustedGitHubBinding = createGitHubToolBinding(context, snapshot);
  const resolvedTools = resolveEffectiveTools(inputs.allowedTools, inputs.toolConfig, policy, {
    permissionProfile: inputs.permissionProfile,
    disallowedTools: inputs.disallowedTools,
    isolation: inputs.isolation,
    ...(trustedGitHubBinding === undefined ? {} : { githubBinding: trustedGitHubBinding }),
    allowWrite: inputs.allowWrite,
  });
  const deniedTools = new Set(resolvedTools.permission.disallowedTools);
  const extensionAllowedTools = resolvedTools.permission.requestedTools.filter(
    (id) => !deniedTools.has(id),
  );
  const extensions =
    inputs.dshMode === "native"
      ? resolveNativeExtensionPlan({
          mcp: inputs.mcpConfig,
          plugins: inputs.pluginConfig,
          allowPluginInstall: inputs.allowPluginInstall,
          policy,
        })
      : resolveExtensionPlan({
          allowedTools: extensionAllowedTools,
          mcp: inputs.mcpConfig,
          plugins: inputs.pluginConfig,
          allowPluginInstall: inputs.allowPluginInstall,
          policy,
        });
  const extensionManifests = extensions.profileName === "github-action" ? extensions.manifests : [];
  const tools = {
    ...resolvedTools,
    extensions,
    manifests: [...resolvedTools.manifests, ...extensionManifests],
  };
  if (
    extensions.profileName === "github-action" &&
    extensions.network &&
    tools.native.includes("native.bash")
  ) {
    throw new PolicyDeniedError(
      "native.bash cannot share a worker with a bridge-networked extension; use mediated web-search or remove Bash",
    );
  }
  if (command.requestedAccess === "write" && !tools.workspace.includes("workspace.edit")) {
    throw new PolicyDeniedError(
      "Write tasks require effective workspace.edit permission; select standard or allow it in custom after all trust gates pass",
    );
  }

  const redact = (value: string): string =>
    redactKnownSecrets(value, [inputs.deepseekApiKey, inputs.githubToken]);
  const commandToolProvider =
    tools.commands.length === 0
      ? undefined
      : new CommandToolProvider({
          definitions: tools.commands,
          workspacePath: agentWorkspace,
          containerImage: inputs.containerImage,
          redact,
        });
  const githubMutationTools = tools.github.filter((id) => id !== "github.checks.read");
  if (githubMutationTools.length > 0 && workspaceSnapshot === undefined) {
    throw new PolicyDeniedError(
      "GitHub mutation tools require an immutable Controller workspace snapshot",
    );
  }
  const githubValidation =
    githubMutationTools.length === 0 || workspaceSnapshot === undefined
      ? undefined
      : new ControllerGitHubMutationValidation({
          state,
          workspace: workspaceSnapshot,
          inputs,
          deadlineMs,
          signal,
        });
  const githubAuthority =
    tools.github.length === 0 || trustedGitHubBinding === undefined
      ? undefined
      : new GitHubAuthoritySession({
          ids: tools.github,
          binding: trustedGitHubBinding,
          policy,
          allowWrite: inputs.allowWrite,
          expectedAuthorId: inputs.botUserId,
          backend: createOctokitGitHubToolBackend(client),
          ...(githubValidation === undefined ? {} : { validationGate: githubValidation.gate }),
          state,
          workspacePath: agentWorkspace,
          deadlineMs,
          signal,
        });
  const controllerProviders = [commandToolProvider, githubAuthority?.gateway].filter(
    (provider) => provider !== undefined,
  );
  const toolProvider =
    controllerProviders.length === 0 ? undefined : new ToolRouter(controllerProviders);
  const agentTools = {
    ...tools,
    manifests: [
      ...tools.manifests.filter(({ provider }) => provider !== "command" && provider !== "github"),
      ...(toolProvider?.manifest() ?? []),
    ],
  };
  const permission = buildPermissionAudit({
    resolution: resolvedTools.permission,
    manifests: agentTools.manifests,
    additionalDenials: resolvedTools.permissionDenials,
    ...(state.composition?.actionManagedExtensionProfile === true ||
    extensions.audit.entries.length > 0
      ? { extensions: extensions.audit }
      : {}),
    ...(state.composition === undefined
      ? {}
      : { mediatedWeb: state.composition.requiresWebSearchProxy(tools.native) }),
  });
  state.permission = permission;
  if (state.composition?.toolPolicyOwner === "controller") {
    state.toolPolicy = buildControllerToolPolicyAudit(
      permission,
      state.composition.toolPolicyOwner,
    );
  }
  const operationIdentity = taskIdentity(command, inputs, extensions.digest, permission.digest);

  // Validate the immutable baseline before any model-controlled path can queue
  // a mutation; the Gateway repeats the gate immediately before its flush.
  await githubValidation?.validate();
  state.authority = buildAuthorityAudit(extensions);
  const selectedComposition = state.composition;
  if (selectedComposition === undefined) throw new Error("DSH composition was not selected");

  return {
    contextPacket,
    tools: agentTools,
    ...(toolProvider === undefined ? {} : { toolProvider }),
    extensions,
    operationIdentity,
    ...(githubAuthority === undefined ? {} : { githubAuthority }),
    ...(githubValidation === undefined ? {} : { githubValidation }),
    hasGitHubMutationTools: githubMutationTools.length > 0,
    selectedComposition,
    redact,
  };
}
