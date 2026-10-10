import * as core from "@actions/core";
import { z } from "zod";
import {
  actionInputDefault,
  actionInputName,
  type DefaultedActionInputRuntimeKey,
} from "./action-contract.js";
import { ActionConfigurationError } from "./errors.js";
import {
  parseMcpConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
  parsePluginConfiguration,
} from "./extensions/schema.js";
import { actionInputsSchema, type ActionInputs } from "./inputs/schema.js";
import { assertActionInputInvariants } from "./inputs/validation.js";
export type { ActionInputs, ControlledActionInputs, NativeActionInputs } from "./inputs/schema.js";

export type InputReader = (name: string, options?: { required?: boolean }) => string;

function optionalInput(reader: InputReader, runtimeKey: DefaultedActionInputRuntimeKey): string {
  const value = reader(actionInputName(runtimeKey));
  const fallback = actionInputDefault(runtimeKey);
  return value === "" ? fallback : value;
}

function configurationError(error: unknown): ActionConfigurationError {
  return new ActionConfigurationError(
    `Invalid action inputs: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
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
    sessionMode: optionalInput(reader, "sessionMode"),
    sessionKey: optionalInput(reader, "sessionKey"),
    sessionSourceRunId: optionalInput(reader, "sessionSourceRunId"),
    sessionRetentionDays: optionalInput(reader, "sessionRetentionDays"),
    promptFile: optionalInput(reader, "promptFile"),
    contextFiles: optionalInput(reader, "contextFiles"),
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
    assertActionInputInvariants(inputs);
  } catch (error: unknown) {
    throw configurationError(error);
  }
  return inputs;
}
