import type {
  AgentToolCall,
  AgentToolManifest,
  AgentToolResult,
  ToolInvocationContext,
  ToolProvider,
} from "../agent/contracts.js";
import type { SecurityPolicy } from "../security/policy.js";
import { executeCommandTool } from "./executor.js";
import {
  commandToolId,
  type AllowedToolId,
  type CommandToolDefinition,
  type CommandToolId,
  type ToolConfiguration,
  type WorkspaceToolId,
} from "./schema.js";

const workspaceDescriptions: Readonly<Record<WorkspaceToolId, string>> = {
  "workspace.read": "Read repository files inside the bound workspace.",
  "workspace.search": "Search repository paths and file contents inside the bound workspace.",
  "workspace.edit": "Edit files inside the disposable bound workspace.",
};

export interface EffectiveTools {
  readonly workspace: readonly WorkspaceToolId[];
  readonly manifests: readonly AgentToolManifest[];
  readonly commands: readonly CommandToolDefinition[];
}

export function resolveEffectiveTools(
  allowed: readonly AllowedToolId[],
  configuration: ToolConfiguration,
  policy: SecurityPolicy,
): EffectiveTools {
  const allowedSet = new Set<AllowedToolId>(allowed);
  const workspace = (Object.keys(workspaceDescriptions) as WorkspaceToolId[]).filter((id) => {
    if (!allowedSet.has(id)) return false;
    if (id === "workspace.edit") return policy.capabilities.modifyWorkspace;
    return policy.capabilities.readRepository && policy.trust !== "untrusted";
  });
  const commands = policy.capabilities.executeRepositoryCode
    ? configuration.commands.filter(
        ({ name, network, workspaceAccess }) =>
          allowedSet.has(commandToolId(name)) &&
          (workspaceAccess !== "write" || policy.capabilities.modifyWorkspace) &&
          (network !== "bridge" || policy.capabilities.accessNetwork),
      )
    : [];
  const manifests: AgentToolManifest[] = [
    ...workspace.map((id) => ({
      id,
      description: workspaceDescriptions[id],
      provider: "builtin" as const,
      permissions: [id === "workspace.edit" ? "write" : "read"] as const,
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
  return { workspace, manifests, commands };
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
