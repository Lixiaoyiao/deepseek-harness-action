import { isAbsolute } from "node:path";
import {
  assertControllerCredentialsAbsentFromExtensions,
  validateExtensionToolReferences,
} from "../extensions/plan.js";
import { ActionConfigurationError } from "../errors.js";
import { assertPermissionProfileConfiguration } from "../permissions/profile.js";
import { validateAllowedToolReferences } from "../tools/schema.js";
import { assertContainerImageReference, assertPinnedContainerImage } from "../dsh/docker-policy.js";
import { validatedControllerBaseUrl } from "../dsh/base-url.js";
import { assertSupportedDshVersion } from "../dsh/version.js";
import type { ActionInputs } from "./schema.js";

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
    inputs.promptFile,
    inputs.sessionKey,
    ...inputs.contextFiles,
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

function assertInputOnlyRuntimeInvariants(inputs: ActionInputs): void {
  assertSupportedDshVersion(inputs.dshVersion);
  assertContainerImageReference(inputs.containerImage);
  validatedControllerBaseUrl(inputs.baseUrl, "DeepSeek base URL");
  validatedControllerBaseUrl(inputs.webSearchBaseUrl, "Web search base URL");

  if (inputs.sessionMode === "off") {
    if (inputs.sessionKey !== "" || inputs.sessionSourceRunId !== "") {
      throw new Error("session-key and session-source-run-id require an explicit session-mode");
    }
  } else {
    if (inputs.sessionKey === "" || inputs.isolation !== "docker") {
      throw new Error("Session requires a maintainer-selected session-key and Docker isolation");
    }
    assertPinnedContainerImage(inputs.containerImage);
    if ((inputs.sessionMode === "resume") !== (inputs.sessionSourceRunId !== "")) {
      throw new Error("session-source-run-id is required only with session-mode=resume");
    }
    if (
      inputs.sessionSourceRunId !== "" &&
      !Number.isSafeInteger(Number(inputs.sessionSourceRunId))
    ) {
      throw new Error("session-source-run-id must be a safe positive integer");
    }
  }

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

/** Validate combinations and prevent Controller credentials crossing into worker data. */
export function assertActionInputInvariants(inputs: ActionInputs): void {
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
  assertControllerSecretsAbsentFromWorkerInputs(inputs);
  if (inputs.prompt.trim() !== "" && inputs.promptFile !== "") {
    throw new ActionConfigurationError(
      "Invalid action inputs: prompt and prompt-file are mutually exclusive",
    );
  }
  if (inputs.command === "task" && inputs.prompt.trim() === "" && inputs.promptFile === "") {
    throw new ActionConfigurationError(
      "Invalid action inputs: prompt or prompt-file is required when command is task",
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
}
