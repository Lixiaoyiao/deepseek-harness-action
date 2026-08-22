import type {
  AgentToolCall,
  AgentToolManifest,
  AgentToolResult,
  ToolInvocationContext,
  ToolProvider,
} from "../agent/contracts.js";
import type { SecurityPolicy } from "../security/policy.js";
import type { EffectiveExtensionPlan } from "../extensions/plan.js";
import {
  resolvePermissionRequest,
  type PermissionProfile,
  type PermissionResolution,
  type ToolDenial,
} from "../permissions/profile.js";
import { executeCommandTool } from "./executor.js";
import {
  autonomyToolSchema,
  commandToolId,
  type AllowedToolId,
  type AutonomyToolId,
  type CommandToolDefinition,
  type CommandToolId,
  type NativeToolId,
  type ToolConfiguration,
  type WorkspaceToolId,
} from "./schema.js";

const workspaceDescriptions: Readonly<Record<WorkspaceToolId, string>> = {
  "workspace.read": "Read repository files inside the bound workspace.",
  "workspace.search": "Search repository paths and file contents inside the bound workspace.",
  "workspace.edit": "Edit files inside the disposable bound workspace.",
};

const autonomyDescriptions: Readonly<Record<AutonomyToolId, string>> = {
  "native.bash":
    "Run bounded foreground Bash commands inside the DSH workspace sandbox; escalation is never approved.",
  "native.web-search":
    "Search the web through the Controller-mediated DeepSeek Messages proxy without receiving the real API key.",
  "native.subagent":
    "Delegate bounded foreground work to one in-process DSH subagent with inherited tool restrictions.",
};

export interface ResolveEffectiveToolsOptions {
  readonly permissionProfile?: PermissionProfile;
  readonly disallowedTools?: readonly AllowedToolId[];
  readonly isolation?: "docker" | "none";
}

export interface EffectiveTools {
  readonly native: readonly NativeToolId[];
  readonly workspace: readonly WorkspaceToolId[];
  readonly manifests: readonly AgentToolManifest[];
  readonly commands: readonly CommandToolDefinition[];
  readonly permission: PermissionResolution;
  readonly permissionDenials: readonly ToolDenial[];
  readonly extensions?: EffectiveExtensionPlan;
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
  const deny = (id: AllowedToolId, reason: string): false => {
    if (!disallowed.has(id)) permissionDenials.push({ id, reason });
    return false;
  };
  const isolation = options.isolation ?? "docker";
  const nativeCandidates = [
    ...(Object.keys(workspaceDescriptions) as WorkspaceToolId[]),
    ...(Object.keys(autonomyDescriptions) as AutonomyToolId[]),
  ] as const;
  const native = nativeCandidates.filter((id): id is NativeToolId => {
    if (!requested.has(id) || disallowed.has(id)) return false;
    if (id === "workspace.edit") {
      return (
        (policy.capabilities.modifyWorkspace && isolation === "docker") ||
        deny(id, "Workspace editing requires trusted-write policy with Docker isolation")
      );
    }
    if (id === "workspace.read" || id === "workspace.search") {
      return (
        (policy.capabilities.readRepository &&
          policy.trust !== "untrusted" &&
          isolation === "docker") ||
        deny(id, "Repository tools require a trusted actor and Docker isolation")
      );
    }
    if (id === "native.bash") {
      return (
        (policy.capabilities.executeRepositoryCode &&
          policy.capabilities.modifyWorkspace &&
          isolation === "docker") ||
        deny(id, "Bash requires trusted-write repository-code execution in Docker")
      );
    }
    if (id === "native.web-search") {
      return (
        (policy.capabilities.accessNetwork &&
          policy.trust !== "untrusted" &&
          isolation === "docker") ||
        deny(id, "Web search requires a trusted same-repository actor and Docker")
      );
    }
    return (
      (policy.capabilities.readRepository &&
        policy.capabilities.modifyWorkspace &&
        policy.trust === "trusted-write" &&
        isolation === "docker") ||
      deny(id, "Subagent delegation requires trusted-write policy in Docker")
    );
  });
  const workspace = native.filter(
    (id): id is WorkspaceToolId => !autonomyToolSchema.safeParse(id).success,
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
  const manifests: AgentToolManifest[] = [
    ...native.map((id) => ({
      id,
      description:
        id in workspaceDescriptions
          ? workspaceDescriptions[id as WorkspaceToolId]
          : autonomyDescriptions[id as AutonomyToolId],
      provider: "builtin" as const,
      permissions:
        id === "workspace.edit"
          ? (["write"] as const)
          : id === "native.bash"
            ? (["read", "execute"] as const)
            : id === "native.web-search"
              ? (["network"] as const)
              : id === "native.subagent"
                ? (["read", "execute"] as const)
                : (["read"] as const),
      inputSchema: { type: "object", additionalProperties: false },
    })),
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
  ];
  return { native, workspace, manifests, commands, permission, permissionDenials };
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
