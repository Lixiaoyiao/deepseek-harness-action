import { z } from "zod";
import { permissionProfileSchema } from "../permissions/profile.js";
import {
  parseAllowedTools,
  parseDisallowedTools,
  parseToolConfiguration,
} from "../tools/schema.js";
import { parseTaskOutputSchema } from "../dsh/task-output.js";
import { validateRefName } from "../security/refs.js";
import { validateBranchNameTemplate, validateBranchPrefix } from "../write/branch.js";
import { parseContextFiles, parsePromptFile } from "../text-files.js";
import type {
  McpConfiguration,
  NativeMcpConfiguration,
  NativePluginConfiguration,
  PluginConfiguration,
} from "../extensions/schema.js";

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

export const actionInputsSchema = z.object({
  deepseekApiKey: z.string().min(8, "deepseek-api-key must be at least 8 characters"),
  githubToken: z.string().min(8, "github-token must be at least 8 characters"),
  allowWrite: booleanInput,
  command: z.enum(["auto", "task", "review", "diagnose", "fix", "implement"]),
  taskAccess: z.enum(["read", "write"]),
  prompt: z.string(),
  sessionMode: z.enum(["off", "auto", "save", "resume"]),
  sessionKey: z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/u),
  sessionSourceRunId: z.string().regex(/^(?:[1-9][0-9]{0,15})?$/u),
  sessionRetentionDays: integerInput(1, 7),
  promptFile: z.string().transform((value, context) => {
    try {
      return parsePromptFile(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
  contextFiles: z.string().transform((value, context) => {
    try {
      return parseContextFiles(value);
    } catch (error: unknown) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  }),
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
