import { z } from "zod";

import { ACTION_INPUT_CONTRACT } from "./action-contract.js";
import { assertPinnedContainerImage } from "./dsh/docker-policy.js";
import { ActionConfigurationError, PolicyDeniedError } from "./errors.js";
import { loadInputs, type ActionInputs } from "./inputs.js";
import { redactKnownSecrets } from "./security/env.js";
import { assertWriteValidationConfigured } from "./write/validate.js";

const credentialEnvironmentSchema = z.strictObject({
  "deepseek-api-key": z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .optional(),
  "github-token": z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .optional(),
});
const configurationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  inputs: z.record(z.string(), z.string()),
  credentialEnv: credentialEnvironmentSchema.optional(),
});

export interface ConfigurationDiagnostic {
  readonly id: string;
  readonly status: "passed" | "failed" | "warning" | "not_checked";
  readonly message: string;
}

export interface ConfigurationCheckResult {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly scope: "static_configuration_only";
  readonly diagnostics: readonly ConfigurationDiagnostic[];
}

function extensionsConfigured(inputs: ActionInputs): boolean {
  return (
    inputs.mcpConfig.servers.length > 0 ||
    inputs.pluginConfig.bundles.length > 0 ||
    inputs.pluginConfig.plugins.length > 0
  );
}

/** Early admission only. Runtime authorization and validation remain independent gates. */
export function assertWriteTaskConfiguration(inputs: ActionInputs): void {
  assertWriteValidationConfigured(inputs.runTests, inputs.testCommands);
  try {
    if (
      inputs.testCommands.some((argv) =>
        argv.some((argument) => /REPLACE_WITH_|REQUIRED: replace test-commands/iu.test(argument)),
      )
    ) {
      throw new Error(
        "test-commands still contains an installer/example placeholder; select reviewed, credential-free validation argv for your repository",
      );
    }
    if (inputs.isolation !== "docker") {
      throw new Error("Write tasks require Docker isolation");
    }
    assertPinnedContainerImage(inputs.containerImage);
  } catch (error: unknown) {
    throw new ActionConfigurationError(
      `Invalid write configuration: ${error instanceof Error ? error.message : "validation configuration is invalid"}`,
    );
  }
}

/** Called before routing/model startup; auto routes repeat the write gate after routing. */
export function assertStartupConfiguration(inputs: ActionInputs): void {
  if (
    inputs.command === "fix" ||
    inputs.command === "implement" ||
    (inputs.command === "task" && inputs.taskAccess === "write")
  ) {
    if (!inputs.allowWrite) {
      throw new PolicyDeniedError(
        "Explicit write tasks require allow-write=true; this setting still does not grant actor or repository authority",
      );
    }
    assertWriteTaskConfiguration(inputs);
  }
}

const uncheckedDiagnostics: readonly ConfigurationDiagnostic[] = [
  {
    id: "docker",
    status: "not_checked",
    message:
      "Docker executable/daemon, container image availability and toolchain are not probed by this offline check.",
  },
  {
    id: "online_authority",
    status: "not_checked",
    message:
      "Credential validity, token scopes/quota, actor permissions, repository/event origin and current SHA require fresh online checks at execution.",
  },
  {
    id: "repository_validation",
    status: "not_checked",
    message:
      "Validation commands and repository scripts were not executed or trusted; a maintainer must review their provenance and they must pass before writes.",
  },
  {
    id: "runtime_extensions",
    status: "not_checked",
    message:
      "Installed DSH/package bytes, extension acquisition/activation and extension-owned credentials/side effects require runtime checks.",
  },
  {
    id: "text_sources",
    status: "not_checked",
    message:
      "Selected prompt/context files are not read locally; trusted revision, existence, file content/encoding and byte limits are verified at execution.",
  },
];

/** No model, subprocess, repository code, network, or remote mutation is used here. */
export function checkConfiguration(
  configuration: unknown,
  environment: NodeJS.ProcessEnv = process.env,
): ConfigurationCheckResult {
  const diagnostics: ConfigurationDiagnostic[] = [];
  const parsed = configurationSchema.safeParse(configuration);
  if (!parsed.success) {
    return {
      schemaVersion: 1,
      ok: false,
      scope: "static_configuration_only",
      diagnostics: [
        {
          id: "configuration_document",
          status: "failed",
          message:
            "Expected schemaVersion=1, inputs as an Action input-name-to-string object, and optional credentialEnv names for deepseek-api-key/github-token; unknown document fields are rejected.",
        },
        ...uncheckedDiagnostics,
      ],
    };
  }
  const raw = { ...parsed.data.inputs };
  const knownNames = new Set<string>(ACTION_INPUT_CONTRACT.map(({ name }) => name));
  for (const name of Object.keys(raw)) {
    if (!knownNames.has(name)) {
      diagnostics.push({
        id: "unknown_input",
        status: "failed",
        message:
          "An unknown Action input name is present; use the published action.yml input names.",
      });
    }
  }
  for (const name of ["deepseek-api-key", "github-token"] as const) {
    const environmentName = parsed.data.credentialEnv?.[name];
    if (environmentName !== undefined) {
      if (raw[name] !== undefined) {
        diagnostics.push({
          id: name,
          status: "failed",
          message: `${name} must use either inputs or credentialEnv, not both.`,
        });
      }
      const value = Object.hasOwn(environment, environmentName)
        ? environment[environmentName]
        : undefined;
      raw[name] = typeof value === "string" ? value : "";
    }
    const credential = raw[name];
    if (credential === undefined || credential.trim() === "" || credential.includes("${{")) {
      diagnostics.push({
        id: name,
        status: "failed",
        message: `${name} is missing or is an unresolved workflow expression; supply its value through credentialEnv for this check.`,
      });
    }
  }
  const secrets = [raw["deepseek-api-key"], raw["github-token"]].filter(
    (value): value is string => value !== undefined && value !== "",
  );
  if (!diagnostics.some(({ status }) => status === "failed")) {
    try {
      const inputs = loadInputs((name) => raw[name] ?? "");
      assertStartupConfiguration(inputs);
      if (extensionsConfigured(inputs)) {
        if (inputs.isolation !== "docker") {
          throw new ActionConfigurationError(
            "MCP, Bundle, and Plugin extensions require Docker isolation",
          );
        }
        assertPinnedContainerImage(inputs.containerImage);
      }
      diagnostics.push({
        id: "action_inputs",
        status: "passed",
        message:
          "Public input schemas, exact supported DSH version, mode/isolation rules and extension configuration are valid.",
      });
      if (inputs.command === "auto" && inputs.allowWrite) {
        try {
          assertWriteTaskConfiguration(inputs);
        } catch (error: unknown) {
          diagnostics.push({
            id: "conditional_write",
            status: "warning",
            message: `Read routes can run, but a routed write will fail before model startup: ${error instanceof Error ? error.message : "write validation is not configured"}`,
          });
        }
      }
    } catch (error: unknown) {
      diagnostics.push({
        id: "action_inputs",
        status: "failed",
        message: redactKnownSecrets(
          error instanceof Error ? error.message : "Invalid Action configuration",
          secrets,
        ),
      });
    }
  }
  return {
    schemaVersion: 1,
    ok: !diagnostics.some(({ status }) => status === "failed"),
    scope: "static_configuration_only",
    diagnostics: [
      ...diagnostics,
      ...uncheckedDiagnostics,
      ...(raw["session-mode"] === "auto" ||
      raw["session-mode"] === "save" ||
      raw["session-mode"] === "resume"
        ? [
            {
              id: "session_provenance",
              status: "not_checked" as const,
              message:
                "Session workflow source, concurrency and key history, producer run/attempt, artifact integrity, retention and latest generation require fresh execution-time checks; no artifact is read by this offline check.",
            },
          ]
        : []),
    ],
  };
}
