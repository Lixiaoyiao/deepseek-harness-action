import * as core from "@actions/core";
import { z } from "zod";

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
  deepseekApiKey: z.string().min(1, "deepseek-api-key is required"),
  githubToken: z.string().min(1, "github-token is required"),
  allowWrite: booleanInput,
  command: z.enum(["auto", "review", "diagnose", "fix", "implement"]),
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
  botUserId: integerInput(1, 2_147_483_647),
});

export type ActionInputs = z.infer<typeof actionInputsSchema>;

export type InputReader = (name: string, options?: { required?: boolean }) => string;

const defaults = {
  allowWrite: "false",
  command: "auto",
  prompt: "",
  dshVersion: "0.1.0-rc.6",
  dshExecutable: "",
  isolation: "docker",
  containerImage: "node:24-bookworm",
  timeoutMinutes: "20",
  maxFindings: "20",
  runTests: "true",
  testCommands: "[]",
  baseUrl: "https://api.deepseek.com",
  botUserId: "41898282",
} as const;

function optionalInput(reader: InputReader, name: string, fallback: string): string {
  const value = reader(name);
  return value === "" ? fallback : value;
}

/** Parse and validate all action inputs before any external side effect occurs. */
export function loadInputs(reader: InputReader = core.getInput): ActionInputs {
  const parsed = actionInputsSchema.safeParse({
    deepseekApiKey: reader("deepseek-api-key", { required: true }),
    githubToken: reader("github-token", { required: true }),
    allowWrite: optionalInput(reader, "allow-write", defaults.allowWrite),
    command: optionalInput(reader, "command", defaults.command),
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
    botUserId: optionalInput(reader, "bot-user-id", defaults.botUserId),
  });

  if (!parsed.success) {
    throw new Error(`Invalid action inputs: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
