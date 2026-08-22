import * as core from "@actions/core";
import { z } from "zod";

import {
  assertControllerCredentialsAbsentFromExtensions,
  validateExtensionToolReferences,
} from "./extensions/plan.js";
import { ActionConfigurationError } from "./errors.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "./extensions/schema.js";
import {
  assertPermissionProfileConfiguration,
  permissionProfileSchema,
} from "./permissions/profile.js";
import {
  parseAllowedTools,
  parseDisallowedTools,
  parseToolConfiguration,
  validateAllowedToolReferences,
} from "./tools/schema.js";
import { DSH_VERSION } from "./release.js";

const booleanInput = z.enum(["true", "false"]).transform((value) => value === "true");

const integerInput = (minimum: number, maximum: number) =>
  z
    .string()
    .regex(/^\d+$/, "must be a base-10 integer")
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));

const argvListInput = z.string().transform((value, context): readonly (readonly string[])[] => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    context.addIssue({ code: "custom", message: "must be valid JSON" });
    return z.NEVER;
  }

  const result = z.array(z.array(z.string().min(1)).min(1)).safeParse(decoded);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      message: "must be a JSON array of non-empty argv arrays",
    });
    return z.NEVER;
  }
  return result.data;
});

const actionInputsSchema = z.object({
  deepseekApiKey: z.string().min(8, "deepseek-api-key must be at least 8 characters"),
  githubToken: z.string().min(8, "github-token must be at least 8 characters"),
  allowWrite: booleanInput,
  command: z.enum(["auto", "task", "review", "diagnose", "fix", "implement"]),
  taskAccess: z.enum(["read", "write"]),
  prompt: z.string(),
  dshVersion: z.string().min(1),
  dshExecutable: z.string(),
  isolation: z.enum(["docker", "none"]),
  containerImage: z.string().min(1),
  timeoutMinutes: integerInput(1, 360),
  maxFindings: integerInput(1, 100),
  runTests: booleanInput,
  testCommands: argvListInput,
  baseUrl: z.url(),
  webSearchBaseUrl: z.url(),
  botUserId: integerInput(1, 2_147_483_647),
  progressComment: booleanInput,
  maxTurns: integerInput(1, 10),
  permissionProfile: permissionProfileSchema,
  validationIntegrity: z.enum(["off", "warn", "strict"]),
  allowPluginInstall: booleanInput,
  allowedTools: z.string().transform((value, context) => {
    try {
      return parseAllowedTools(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
  disallowedTools: z.string().transform((value, context) => {
    try {
      return parseDisallowedTools(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
  toolConfig: z.string().transform((value, context) => {
    try {
      return parseToolConfiguration(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
  mcpConfig: z.string().transform((value, context) => {
    try {
      return parseMcpConfiguration(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
  pluginConfig: z.string().transform((value, context) => {
    try {
      return parsePluginConfiguration(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
});

export type ActionInputs = z.infer<typeof actionInputsSchema>;

export type InputReader = (name: string, options?: { required?: boolean }) => string;

const defaults = {
  allowWrite: "false",
  command: "auto",
  taskAccess: "read",
  prompt: "",
  dshVersion: DSH_VERSION,
  dshExecutable: "",
  isolation: "docker",
  containerImage:
    "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059",
  timeoutMinutes: "20",
  maxFindings: "20",
  runTests: "true",
  testCommands: "[]",
  baseUrl: "https://api.deepseek.com",
  webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
  botUserId: "41898282",
  progressComment: "true",
  maxTurns: "3",
  permissionProfile: "strict",
  validationIntegrity: "warn",
  allowPluginInstall: "false",
  allowedTools: "[]",
  disallowedTools: "[]",
  toolConfig: '{"schemaVersion":1,"commands":[]}',
  mcpConfig: '{"schemaVersion":1,"servers":[]}',
  pluginConfig: '{"schemaVersion":1,"bundles":[],"plugins":[]}',
} as const;

function optionalInput(reader: InputReader, name: string, fallback: string): string {
  const value = reader(name);
  return value === "" ? fallback : value;
}

function assertControllerSecretsAbsentFromWorkerInputs(inputs: ActionInputs): void {
  const secrets = [inputs.deepseekApiKey, inputs.githubToken];
  const configuredArgv = [
    ...inputs.testCommands,
    ...inputs.toolConfig.commands.map(({ argv }) => argv),
  ];
  if (
    secrets.some((secret) => inputs.prompt.includes(secret)) ||
    configuredArgv.some((argv) =>
      argv.some((argument) => secrets.some((secret) => argument.includes(secret))),
    )
  ) {
    throw new ActionConfigurationError(
      "Invalid action inputs: controller credentials must not appear in the task prompt, test-commands, or tool-config argv",
    );
  }
}

/** Parse and validate all action inputs before any external side effect occurs. */
export function loadInputs(reader: InputReader = core.getInput): ActionInputs {
  const parsed = actionInputsSchema.safeParse({
    deepseekApiKey: reader("deepseek-api-key", { required: true }),
    githubToken: reader("github-token", { required: true }),
    allowWrite: optionalInput(reader, "allow-write", defaults.allowWrite),
    command: optionalInput(reader, "command", defaults.command),
    taskAccess: optionalInput(reader, "task-access", defaults.taskAccess),
    prompt: optionalInput(reader, "prompt", defaults.prompt),
    dshVersion: optionalInput(reader, "dsh-version", defaults.dshVersion),
    dshExecutable: optionalInput(reader, "dsh-executable", defaults.dshExecutable),
    isolation: optionalInput(reader, "isolation", defaults.isolation),
    containerImage: optionalInput(reader, "container-image", defaults.containerImage),
    timeoutMinutes: optionalInput(reader, "timeout-minutes", defaults.timeoutMinutes),
    maxFindings: optionalInput(reader, "max-findings", defaults.maxFindings),
    runTests: optionalInput(reader, "run-tests", defaults.runTests),
    testCommands: optionalInput(reader, "test-commands", defaults.testCommands),
    baseUrl: optionalInput(reader, "base-url", defaults.baseUrl),
    webSearchBaseUrl: optionalInput(reader, "web-search-base-url", defaults.webSearchBaseUrl),
    botUserId: optionalInput(reader, "bot-user-id", defaults.botUserId),
    progressComment: optionalInput(reader, "progress-comment", defaults.progressComment),
    maxTurns: optionalInput(reader, "max-turns", defaults.maxTurns),
    permissionProfile: optionalInput(reader, "permission-profile", defaults.permissionProfile),
    validationIntegrity: optionalInput(
      reader,
      "validation-integrity",
      defaults.validationIntegrity,
    ),
    allowPluginInstall: optionalInput(reader, "allow-plugin-install", defaults.allowPluginInstall),
    allowedTools: optionalInput(reader, "allowed-tools", defaults.allowedTools),
    disallowedTools: optionalInput(reader, "disallowed-tools", defaults.disallowedTools),
    toolConfig: optionalInput(reader, "tool-config", defaults.toolConfig),
    mcpConfig: optionalInput(reader, "mcp-config", defaults.mcpConfig),
    pluginConfig: optionalInput(reader, "plugin-config", defaults.pluginConfig),
  });

  if (!parsed.success) {
    throw new ActionConfigurationError(`Invalid action inputs: ${z.prettifyError(parsed.error)}`);
  }
  try {
    assertPermissionProfileConfiguration(parsed.data.permissionProfile, parsed.data.allowedTools);
    validateAllowedToolReferences(parsed.data.allowedTools, parsed.data.toolConfig);
    validateAllowedToolReferences(
      parsed.data.disallowedTools,
      parsed.data.toolConfig,
      "disallowed-tools",
    );
    validateExtensionToolReferences(
      parsed.data.allowedTools,
      parsed.data.mcpConfig,
      parsed.data.pluginConfig,
    );
    validateExtensionToolReferences(
      parsed.data.disallowedTools,
      parsed.data.mcpConfig,
      parsed.data.pluginConfig,
      "disallowed-tools",
    );
    assertControllerCredentialsAbsentFromExtensions(
      parsed.data.mcpConfig,
      parsed.data.pluginConfig,
      [parsed.data.deepseekApiKey, parsed.data.githubToken],
    );
  } catch (error: unknown) {
    throw new ActionConfigurationError(
      `Invalid action inputs: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  assertControllerSecretsAbsentFromWorkerInputs(parsed.data);
  if (parsed.data.command === "task" && parsed.data.prompt.trim() === "") {
    throw new ActionConfigurationError(
      "Invalid action inputs: prompt is required when command is task",
    );
  }
  if (
    parsed.data.permissionProfile === "standard" &&
    (parsed.data.mcpConfig.servers.length > 0 ||
      parsed.data.pluginConfig.bundles.length > 0 ||
      parsed.data.pluginConfig.plugins.length > 0)
  ) {
    throw new ActionConfigurationError(
      "Invalid action inputs: MCP, Bundle, and Plugin configuration requires permission-profile custom (strict remains accepted for v0.4 compatibility)",
    );
  }
  return parsed.data;
}
