import * as core from "@actions/core";
import { isAbsolute } from "node:path";
import { z } from "zod";

import {
  actionInputDefault,
  actionInputName,
  type DefaultedActionInputRuntimeKey,
} from "./action-contract.js";
import {
  assertControllerCredentialsAbsentFromExtensions,
  validateExtensionToolReferences,
} from "./extensions/plan.js";
import { ActionConfigurationError } from "./errors.js";
import {
  parseMcpConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
  parsePluginConfiguration,
  type McpConfiguration,
  type NativeMcpConfiguration,
  type NativePluginConfiguration,
  type PluginConfiguration,
} from "./extensions/schema.js";
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
import { assertContainerImageReference } from "./dsh/docker-policy.js";
import { validatedControllerBaseUrl } from "./dsh/base-url.js";
import { parseTaskOutputSchema } from "./dsh/task-output.js";
import { assertSupportedDshVersion } from "./dsh/version.js";
import { validateRefName } from "./security/refs.js";
import { validateBranchNameTemplate, validateBranchPrefix } from "./write/branch.js";

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

const MAX_TRIGGER_PHRASE_BYTES = 128;
const MAX_ROUTING_LITERAL_BYTES = 256;
const MAX_ACTOR_LIST_BYTES = 4 * 1024;
const MAX_ACTOR_ENTRIES = 100;
const MAX_ACTOR_ENTRY_BYTES = 100;

function boundedRoutingLiteral(name: string, maximumBytes: number, allowEmpty: boolean) {
  return z.string().transform((value, context): string => {
    const trimmed = value.trim();
    if ((!allowEmpty && trimmed === "") || Buffer.byteLength(trimmed, "utf8") > maximumBytes) {
      context.addIssue({
        code: "custom",
        message: `${name} must be ${allowEmpty ? "at most" : "between 1 and"} ${String(maximumBytes)} UTF-8 bytes`,
      });
      return z.NEVER;
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/u.test(trimmed)) {
      context.addIssue({ code: "custom", message: `${name} must not contain control characters` });
      return z.NEVER;
    }
    return trimmed;
  });
}

function actorListInput(name: string) {
  return z.string().transform((value, context): readonly string[] => {
    if (Buffer.byteLength(value, "utf8") > MAX_ACTOR_LIST_BYTES) {
      context.addIssue({
        code: "custom",
        message: `${name} must not exceed ${String(MAX_ACTOR_LIST_BYTES)} UTF-8 bytes`,
      });
      return z.NEVER;
    }
    const entries = value
      .split(",")
      .map((entry) => entry.trim().replace(/^@/u, ""))
      .filter(Boolean);
    if (entries.length > MAX_ACTOR_ENTRIES) {
      context.addIssue({
        code: "custom",
        message: `${name} must contain at most ${String(MAX_ACTOR_ENTRIES)} actors`,
      });
      return z.NEVER;
    }
    const unique = new Map<string, string>();
    for (const entry of entries) {
      if (
        Buffer.byteLength(entry, "utf8") > MAX_ACTOR_ENTRY_BYTES ||
        !/^(?:\*|\*\[bot\]|[A-Za-z0-9_.-]+(?:\[bot\])?)$/u.test(entry)
      ) {
        context.addIssue({
          code: "custom",
          message: `${name} contains an invalid actor pattern: ${entry || "<empty>"}`,
        });
        return z.NEVER;
      }
      const normalized = entry.toLowerCase();
      if (!unique.has(normalized)) unique.set(normalized, entry);
    }
    return [...unique.values()];
  });
}

const baseBranchInput = z.string().transform((value, context): string => {
  const branch = value.trim();
  if (branch === "") return "";
  if (Buffer.byteLength(branch, "utf8") > 240) {
    context.addIssue({ code: "custom", message: "base-branch must not exceed 240 UTF-8 bytes" });
    return z.NEVER;
  }
  if (branch.startsWith("refs/")) {
    context.addIssue({ code: "custom", message: "base-branch must be an unqualified branch name" });
    return z.NEVER;
  }
  try {
    return validateRefName(branch);
  } catch (error: unknown) {
    context.addIssue({
      code: "custom",
      message:
        error instanceof Error ? `invalid base-branch: ${error.message}` : "invalid base-branch",
    });
    return z.NEVER;
  }
});

function validatedBranchInput(
  name: "branch-prefix" | "branch-name-template",
  validate: (value: string) => string,
) {
  return z.string().transform((value, context): string => {
    try {
      return validate(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : `invalid ${name}`,
      });
      return z.NEVER;
    }
  });
}

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
  triggerPhrase: boundedRoutingLiteral("trigger-phrase", MAX_TRIGGER_PHRASE_BYTES, false),
  labelTrigger: boundedRoutingLiteral("label-trigger", MAX_ROUTING_LITERAL_BYTES, true),
  assigneeTrigger: boundedRoutingLiteral("assignee-trigger", MAX_ROUTING_LITERAL_BYTES, true),
  allowedActors: actorListInput("allowed-actors"),
  allowedBots: actorListInput("allowed-bots"),
  includeCommentsByActor: actorListInput("include-comments-by-actor"),
  excludeCommentsByActor: actorListInput("exclude-comments-by-actor"),
  baseBranch: baseBranchInput,
  branchPrefix: validatedBranchInput("branch-prefix", validateBranchPrefix),
  branchNameTemplate: validatedBranchInput("branch-name-template", validateBranchNameTemplate),
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
  taskOutputSchema: z
    .string()
    .transform((value, context) => {
      try {
        return parseTaskOutputSchema(value);
      } catch (error: unknown) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : String(error),
        });
        return z.NEVER;
      }
    })
    .optional(),
});

type CommonActionInputs = z.infer<typeof actionInputsSchema>;

export type ControlledActionInputs = CommonActionInputs & {
  readonly dshMode: "controlled";
  readonly mcpConfig: McpConfiguration;
  readonly pluginConfig: PluginConfiguration;
};

export type NativeActionInputs = CommonActionInputs & {
  readonly dshMode: "native";
  readonly mcpConfig: NativeMcpConfiguration;
  readonly pluginConfig: NativePluginConfiguration;
};

/** Mode closes the configuration shape so impossible composition pairs never reach production. */
export type ActionInputs = ControlledActionInputs | NativeActionInputs;

export type InputReader = (name: string, options?: { required?: boolean }) => string;

function optionalInput(reader: InputReader, runtimeKey: DefaultedActionInputRuntimeKey): string {
  const value = reader(actionInputName(runtimeKey));
  const fallback = actionInputDefault(runtimeKey);
  return value === "" ? fallback : value;
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value)) return value.some((item) => containsSecret(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, item]) => key.includes(secret) || containsSecret(item, secret),
    );
  }
  return false;
}

function assertControllerSecretsAbsentFromWorkerInputs(inputs: ActionInputs): void {
  const secrets = [inputs.deepseekApiKey, inputs.githubToken];
  const publicRefConfiguration = [
    inputs.baseBranch,
    inputs.branchPrefix,
    inputs.branchNameTemplate,
  ];
  const configuredArgv = [
    ...inputs.testCommands,
    ...inputs.toolConfig.commands.map(({ argv }) => argv),
  ];
  if (
    secrets.some(
      (secret) =>
        inputs.prompt.includes(secret) ||
        publicRefConfiguration.some((value) => value.includes(secret)),
    ) ||
    secrets.some((secret) => containsSecret(inputs.taskOutputSchema, secret)) ||
    configuredArgv.some((argv) =>
      argv.some((argument) => secrets.some((secret) => argument.includes(secret))),
    )
  ) {
    throw new ActionConfigurationError(
      "Invalid action inputs: controller credentials must not appear in the task prompt, branch configuration, task-output-schema, test-commands, or tool-config argv",
    );
  }
}

function configurationError(error: unknown): ActionConfigurationError {
  return new ActionConfigurationError(
    `Invalid action inputs: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

function assertInputOnlyRuntimeInvariants(inputs: ActionInputs): void {
  assertSupportedDshVersion(inputs.dshVersion);
  assertContainerImageReference(inputs.containerImage);
  validatedControllerBaseUrl(inputs.baseUrl, "DeepSeek base URL");
  validatedControllerBaseUrl(inputs.webSearchBaseUrl, "Web search base URL");

  if (inputs.dshMode === "native") {
    if (inputs.isolation !== "docker" || inputs.dshExecutable !== "") {
      throw new Error(
        "dsh-mode native requires Docker isolation and does not accept dsh-executable",
      );
    }
    return;
  }
  if (inputs.isolation === "docker" && inputs.dshExecutable !== "") {
    throw new Error("dsh-executable is host-only and cannot be used with Docker isolation");
  }
  if (
    inputs.isolation === "none" &&
    inputs.dshExecutable !== "" &&
    !isAbsolute(inputs.dshExecutable)
  ) {
    throw new Error("dsh-executable must be an absolute path when isolation is none");
  }
}

/** Parse and validate all action inputs before any external side effect occurs. */
export function loadInputs(reader: InputReader = core.getInput): ActionInputs {
  const deepseekApiKey = reader(actionInputName("deepseekApiKey"), { required: true });
  const githubToken = reader(actionInputName("githubToken"), { required: true });
  const baseBranch = optionalInput(reader, "baseBranch");
  const branchPrefix = optionalInput(reader, "branchPrefix");
  const branchNameTemplate = optionalInput(reader, "branchNameTemplate");
  const dshModeResult = z
    .enum(["controlled", "native"])
    .safeParse(optionalInput(reader, "dshMode"));
  if (!dshModeResult.success) {
    throw new ActionConfigurationError(
      `Invalid action inputs: ${z.prettifyError(dshModeResult.error)}`,
    );
  }
  const dshMode = dshModeResult.data;
  const rawMcp = optionalInput(reader, "mcpConfig");
  const rawPlugins = optionalInput(reader, "pluginConfig");
  if (
    [deepseekApiKey, githubToken].some(
      (secret) =>
        secret !== "" &&
        [baseBranch, branchPrefix, branchNameTemplate].some((value) => value.includes(secret)),
    )
  ) {
    throw new ActionConfigurationError(
      "Invalid action inputs: controller credentials must not appear in branch configuration",
    );
  }
  const parsed = actionInputsSchema.safeParse({
    deepseekApiKey,
    githubToken,
    allowWrite: optionalInput(reader, "allowWrite"),
    command: optionalInput(reader, "command"),
    taskAccess: optionalInput(reader, "taskAccess"),
    prompt: optionalInput(reader, "prompt"),
    dshVersion: optionalInput(reader, "dshVersion"),
    dshExecutable: optionalInput(reader, "dshExecutable"),
    isolation: optionalInput(reader, "isolation"),
    containerImage: optionalInput(reader, "containerImage"),
    timeoutMinutes: optionalInput(reader, "timeoutMinutes"),
    maxFindings: optionalInput(reader, "maxFindings"),
    runTests: optionalInput(reader, "runTests"),
    testCommands: optionalInput(reader, "testCommands"),
    baseUrl: optionalInput(reader, "baseUrl"),
    webSearchBaseUrl: optionalInput(reader, "webSearchBaseUrl"),
    botUserId: optionalInput(reader, "botUserId"),
    progressComment: optionalInput(reader, "progressComment"),
    triggerPhrase: optionalInput(reader, "triggerPhrase"),
    labelTrigger: optionalInput(reader, "labelTrigger"),
    assigneeTrigger: optionalInput(reader, "assigneeTrigger"),
    allowedActors: optionalInput(reader, "allowedActors"),
    allowedBots: optionalInput(reader, "allowedBots"),
    includeCommentsByActor: optionalInput(reader, "includeCommentsByActor"),
    excludeCommentsByActor: optionalInput(reader, "excludeCommentsByActor"),
    baseBranch,
    branchPrefix,
    branchNameTemplate,
    maxTurns: optionalInput(reader, "maxTurns"),
    permissionProfile: optionalInput(reader, "permissionProfile"),
    validationIntegrity: optionalInput(reader, "validationIntegrity"),
    allowPluginInstall: optionalInput(reader, "allowPluginInstall"),
    allowedTools: optionalInput(reader, "allowedTools"),
    disallowedTools: optionalInput(reader, "disallowedTools"),
    toolConfig: optionalInput(reader, "toolConfig"),
    taskOutputSchema: optionalInput(reader, "taskOutputSchema"),
  });

  if (!parsed.success) {
    throw new ActionConfigurationError(`Invalid action inputs: ${z.prettifyError(parsed.error)}`);
  }
  let inputs: ActionInputs;
  try {
    inputs =
      dshMode === "native"
        ? {
            ...parsed.data,
            dshMode: "native",
            mcpConfig: parseNativeMcpConfiguration(rawMcp),
            pluginConfig: parseNativePluginConfiguration(rawPlugins),
          }
        : {
            ...parsed.data,
            dshMode: "controlled",
            mcpConfig: parseMcpConfiguration(rawMcp),
            pluginConfig: parsePluginConfiguration(rawPlugins),
          };
    assertInputOnlyRuntimeInvariants(inputs);
    assertPermissionProfileConfiguration(inputs.permissionProfile, inputs.allowedTools);
    validateAllowedToolReferences(inputs.allowedTools, inputs.toolConfig);
    validateAllowedToolReferences(inputs.disallowedTools, inputs.toolConfig, "disallowed-tools");
    if (inputs.dshMode === "controlled") {
      validateExtensionToolReferences(inputs.allowedTools, inputs.mcpConfig, inputs.pluginConfig);
      validateExtensionToolReferences(
        inputs.disallowedTools,
        inputs.mcpConfig,
        inputs.pluginConfig,
        "disallowed-tools",
      );
    } else {
      const fabricatedGrant = [...inputs.allowedTools, ...inputs.disallowedTools].find(
        (id) => id.startsWith("mcp.") || id.startsWith("plugin."),
      );
      if (fabricatedGrant !== undefined) {
        throw new Error(
          `dsh-mode native does not accept ${fabricatedGrant} in allowed-tools/disallowed-tools; DSH owns native extension discovery and inventory`,
        );
      }
    }
    assertControllerCredentialsAbsentFromExtensions(inputs.mcpConfig, inputs.pluginConfig, [
      inputs.deepseekApiKey,
      inputs.githubToken,
    ]);
  } catch (error: unknown) {
    throw configurationError(error);
  }
  assertControllerSecretsAbsentFromWorkerInputs(inputs);
  if (inputs.command === "task" && inputs.prompt.trim() === "") {
    throw new ActionConfigurationError(
      "Invalid action inputs: prompt is required when command is task",
    );
  }
  if (
    inputs.taskOutputSchema !== undefined &&
    inputs.command !== "auto" &&
    inputs.command !== "task"
  ) {
    throw new ActionConfigurationError(
      "Invalid action inputs: task-output-schema is supported only for command task or auto",
    );
  }
  if (
    inputs.dshMode === "controlled" &&
    inputs.permissionProfile === "standard" &&
    (inputs.mcpConfig.servers.length > 0 ||
      inputs.pluginConfig.bundles.length > 0 ||
      inputs.pluginConfig.plugins.length > 0)
  ) {
    throw new ActionConfigurationError(
      "Invalid action inputs: MCP, Bundle, and Plugin configuration requires permission-profile custom (strict remains accepted for v0.4 compatibility)",
    );
  }
  return inputs;
}
