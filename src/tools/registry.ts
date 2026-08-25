import type {
  AgentToolCall,
  AgentToolManifest,
  AgentToolResult,
  ToolInvocationContext,
  ToolProvider,
} from "../agent/contracts.js";
import type { SecurityPolicy } from "../security/policy.js";
import type { ExtensionPlan } from "../extensions/plan.js";
import {
  resolvePermissionRequest,
  type PermissionProfile,
  type PermissionResolution,
  type ToolDenial,
} from "../permissions/profile.js";
import { executeCommandTool } from "./executor.js";
import { evaluateBuiltinCapabilities } from "./capabilities.js";
import { githubToolManifest, resolveGitHubTools, type GitHubToolBinding } from "./github.js";
import {
  commandToolId,
  type AllowedToolId,
  type CommandToolDefinition,
  type CommandToolId,
  githubToolSchema,
  nativeToolSchema,
  type GitHubToolId,
  type NativeToolId,
  type ToolConfiguration,
  workspaceToolSchema,
  type WorkspaceToolId,
} from "./schema.js";

export interface ResolveEffectiveToolsOptions {
  readonly permissionProfile?: PermissionProfile;
  readonly disallowedTools?: readonly AllowedToolId[];
  readonly isolation?: "docker" | "none";
  readonly githubBinding?: GitHubToolBinding;
  readonly allowWrite?: boolean;
}

export interface EffectiveTools {
  readonly native: readonly NativeToolId[];
  readonly workspace: readonly WorkspaceToolId[];
  readonly manifests: readonly AgentToolManifest[];
  readonly commands: readonly CommandToolDefinition[];
  readonly github: readonly GitHubToolId[];
  readonly permission: PermissionResolution;
  readonly permissionDenials: readonly ToolDenial[];
  readonly extensions?: ExtensionPlan;
}

export function resolveEffectiveTools(
  allowed: readonly AllowedToolId[],
  configuration: ToolConfiguration,
  policy: SecurityPolicy,
  options: ResolveEffectiveToolsOptions = {},
): EffectiveTools {
  const permission = resolvePermissionRequest(
    options.permissionProfile ?? "strict",
    allowed,
    options.disallowedTools ?? [],
  );
  const requested = new Set<AllowedToolId>(permission.requestedTools);
  const disallowed = new Set<AllowedToolId>(permission.disallowedTools);
  const permissionDenials: ToolDenial[] = [...permission.deniedTools];
  const isolation = options.isolation ?? "docker";
  const requestedBuiltin = new Set(
    [...requested].filter((id): id is NativeToolId => nativeToolSchema.safeParse(id).success),
  );
  const disallowedBuiltin = new Set(
    [...disallowed].filter((id): id is NativeToolId => nativeToolSchema.safeParse(id).success),
  );
  const builtin = evaluateBuiltinCapabilities({
    requested: requestedBuiltin,
    disallowed: disallowedBuiltin,
    policy,
    isolation,
  });
  permissionDenials.push(...builtin.denials);
  const native = builtin.contracts.map(({ manifest }) => manifest.id);
  const workspace = native.filter(
    (id): id is WorkspaceToolId => workspaceToolSchema.safeParse(id).success,
  );
  const commands = policy.capabilities.executeRepositoryCode
    ? configuration.commands.filter(
        ({ name, network, workspaceAccess }) =>
          requested.has(commandToolId(name)) &&
          !disallowed.has(commandToolId(name)) &&
          (workspaceAccess !== "write" || policy.capabilities.modifyWorkspace) &&
          (network !== "bridge" || policy.capabilities.accessNetwork),
      )
    : [];
  for (const command of configuration.commands) {
    const id = commandToolId(command.name);
    if (!requested.has(id) || disallowed.has(id) || commands.includes(command)) continue;
    permissionDenials.push({
      id,
      reason:
        "The Controller trust policy denied this command's execution, write, or network grant",
    });
  }
  const requestedGitHub = new Set(
    [...requested].filter((id): id is GitHubToolId => githubToolSchema.safeParse(id).success),
  );
  const disallowedGitHub = new Set(
    [...disallowed].filter((id): id is GitHubToolId => githubToolSchema.safeParse(id).success),
  );
  const githubResolution = resolveGitHubTools(
    requestedGitHub,
    disallowedGitHub,
    policy,
    options.githubBinding,
    options.allowWrite ?? false,
  );
  permissionDenials.push(...githubResolution.denials);
  const github = githubResolution.ids;
  const manifests: AgentToolManifest[] = [
    ...builtin.contracts.map(({ manifest }) => manifest),
    ...commands.map((command) => ({
      id: commandToolId(command.name),
      description: command.description,
      provider: "command" as const,
      permissions: [
        "execute" as const,
        ...(command.workspaceAccess === "write" ? (["write"] as const) : []),
        ...(command.network === "bridge" ? (["network"] as const) : []),
      ],
      inputSchema: { type: "object", additionalProperties: false },
    })),
    ...github.map((id) => githubToolManifest(id)),
  ];
  return { native, workspace, manifests, commands, github, permission, permissionDenials };
}

export interface CommandToolProviderOptions {
  readonly definitions: readonly CommandToolDefinition[];
  readonly workspacePath: string;
  readonly containerImage: string;
  readonly redact: (value: string) => string;
  readonly execute?: typeof executeCommandTool;
}

export class CommandToolProvider implements ToolProvider {
  public readonly id = "command";
  private readonly definitions: ReadonlyMap<CommandToolId, CommandToolDefinition>;
  private readonly calls = new Map<CommandToolId, number>();

  public constructor(private readonly options: CommandToolProviderOptions) {
    this.definitions = new Map(
      options.definitions.map((definition) => [commandToolId(definition.name), definition]),
    );
  }

  public manifest(): readonly AgentToolManifest[] {
    return [...this.definitions.entries()].map(([id, definition]) => ({
      id,
      description: definition.description,
      provider: "command",
      permissions: [
        "execute",
        ...(definition.workspaceAccess === "write" ? (["write"] as const) : []),
        ...(definition.network === "bridge" ? (["network"] as const) : []),
      ],
      inputSchema: { type: "object", additionalProperties: false },
    }));
  }

  public async invoke(
    call: AgentToolCall,
    context: ToolInvocationContext,
  ): Promise<AgentToolResult> {
    if (
      typeof call.input !== "object" ||
      call.input === null ||
      Array.isArray(call.input) ||
      Object.keys(call.input).length !== 0
    ) {
      throw new Error(`Command tool ${call.id} accepts no model-provided arguments`);
    }
    const definition = this.definitions.get(call.id as CommandToolId);
    if (definition === undefined) throw new Error(`Unknown or unauthorized tool: ${call.id}`);
    const id = commandToolId(definition.name);
    const next = (this.calls.get(id) ?? 0) + 1;
    if (next > definition.maxCalls) {
      throw new Error(`Command tool ${id} exceeded its maxCalls limit`);
    }
    this.calls.set(id, next);
    const result = await (this.options.execute ?? executeCommandTool)({
      callId: call.callId,
      id,
      definition,
      workspacePath: this.options.workspacePath,
      containerImage: this.options.containerImage,
      timeoutMs: context.timeoutMs,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    if (typeof result.output !== "object" || result.output === null) {
      throw new Error(`Command tool ${id} returned an invalid result envelope`);
    }
    const output = result.output as Record<string, unknown>;
    if (typeof output.stdout !== "string" || typeof output.stderr !== "string") {
      throw new Error(`Command tool ${id} returned non-string process output`);
    }
    return {
      ...result,
      output: {
        ...output,
        stdout: this.options.redact(output.stdout),
        stderr: this.options.redact(output.stderr),
      },
    };
  }
}
