import { basename } from "node:path";

import { z } from "zod";

export const workspaceToolSchema = z.enum(["workspace.read", "workspace.search", "workspace.edit"]);
export type WorkspaceToolId = z.infer<typeof workspaceToolSchema>;

const commandNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/u, "must start with a letter and contain only a-z, 0-9, or -");

const forbiddenInterpreters = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "fish",
  "fish.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "sh",
  "sh.exe",
  "zsh",
  "zsh.exe",
]);

function executableName(value: string): string {
  return basename(value.replaceAll("\\", "/")).toLowerCase();
}

const commandToolSchema = z
  .strictObject({
    name: commandNameSchema,
    description: z.string().trim().min(1).max(500),
    argv: z.array(z.string().min(1).max(4_096)).min(1).max(64),
    timeoutMinutes: z.number().int().min(1).max(30).default(10),
    maxOutputBytes: z
      .number()
      .int()
      .min(1_024)
      .max(2 * 1024 * 1024)
      .default(128 * 1024),
    maxCalls: z.number().int().min(1).max(10).default(3),
    network: z.enum(["none", "bridge"]).default("none"),
    workspaceAccess: z.enum(["read", "write"]).default("read"),
  })
  .superRefine((command, context) => {
    if (command.argv.some((argument) => argument.includes("\0"))) {
      context.addIssue({ code: "custom", path: ["argv"], message: "argv must not contain NUL" });
    }
    const executable = command.argv[0];
    if (executable !== undefined && forbiddenInterpreters.has(executableName(executable))) {
      context.addIssue({
        code: "custom",
        path: ["argv", 0],
        message: "shell interpreters are not allowed; configure an exact executable and argv",
      });
    }
  });

const toolConfigurationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    commands: z.array(commandToolSchema).max(32).default([]),
  })
  .superRefine((configuration, context) => {
    const seen = new Set<string>();
    for (const [index, command] of configuration.commands.entries()) {
      if (seen.has(command.name)) {
        context.addIssue({
          code: "custom",
          path: ["commands", index, "name"],
          message: `duplicate command name: ${command.name}`,
        });
      }
      seen.add(command.name);
    }
  });

export type CommandToolDefinition = z.infer<typeof commandToolSchema>;
export type ToolConfiguration = z.infer<typeof toolConfigurationSchema>;
export type CommandToolId = `command.${string}`;
export type McpToolId = `mcp.${string}.${string}`;
export type PluginToolId = `plugin.${string}.${string}`;
export type AllowedToolId = WorkspaceToolId | CommandToolId | McpToolId | PluginToolId;

const allowedToolIdSchema = z.union([
  workspaceToolSchema,
  z.string().regex(/^command\.[a-z][a-z0-9-]{0,31}$/u),
  z.string().regex(/^mcp\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/u),
  z.string().regex(/^plugin\.[a-z][a-z0-9-]{0,31}\.[a-z][a-z0-9_-]{0,63}$/u),
]);

function decodeJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export function parseToolConfiguration(raw: string): ToolConfiguration {
  const result = toolConfigurationSchema.safeParse(decodeJson(raw, "tool-config"));
  if (!result.success) {
    throw new Error(`Invalid tool-config: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

export function parseAllowedTools(raw: string): readonly AllowedToolId[] {
  const result = z.array(allowedToolIdSchema).max(64).safeParse(decodeJson(raw, "allowed-tools"));
  if (!result.success) {
    throw new Error(`Invalid allowed-tools: ${z.prettifyError(result.error)}`);
  }
  const unique = [...new Set(result.data)] as AllowedToolId[];
  return unique;
}

export function commandToolId(name: string): CommandToolId {
  return `command.${commandNameSchema.parse(name)}`;
}

export function mcpToolId(serverId: string, toolId: string): McpToolId {
  return `mcp.${serverId}.${toolId}`;
}

export function pluginToolId(extensionId: string, toolId: string): PluginToolId {
  return `plugin.${extensionId}.${toolId}`;
}

export function validateAllowedToolReferences(
  allowedTools: readonly AllowedToolId[],
  configuration: ToolConfiguration,
): void {
  const configured = new Set(configuration.commands.map(({ name }) => commandToolId(name)));
  const missing = allowedTools.find(
    (id): id is CommandToolId => id.startsWith("command.") && !configured.has(id as CommandToolId),
  );
  if (missing !== undefined) {
    throw new Error(`allowed-tools references undefined command tool: ${missing}`);
  }
}
