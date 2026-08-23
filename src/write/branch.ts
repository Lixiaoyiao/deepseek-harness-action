import { validateRefName } from "../security/refs.js";

const MAX_BRANCH_PREFIX_BYTES = 128;
const MAX_BRANCH_TEMPLATE_BYTES = 512;
export const MAX_BRANCH_NAME_BYTES = 240;

const branchTemplateVariables = [
  "prefix",
  "key",
  "operation",
  "entityType",
  "entityNumber",
] as const;

type BranchTemplateVariable = (typeof branchTemplateVariables)[number];

export interface BranchNameConfiguration {
  readonly branchPrefix?: string;
  readonly branchNameTemplate?: string;
}

export interface ControllerBranchIdentity extends BranchNameConfiguration {
  readonly key: string;
  readonly operation: string;
  readonly entityType: "issue" | "task";
  readonly entityNumber: string;
  readonly legacySuffix: string;
}

function utf8Length(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function validateBranchPrefix(value: string): string {
  const prefix = value.trim();
  if (prefix === "") throw new Error("branch-prefix cannot be empty");
  if (utf8Length(prefix) > MAX_BRANCH_PREFIX_BYTES) {
    throw new Error(`branch-prefix must not exceed ${String(MAX_BRANCH_PREFIX_BYTES)} UTF-8 bytes`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/u.test(prefix)) {
    throw new Error("branch-prefix contains an unsupported character");
  }
  // A prefix may end in '/' or '-', so validate it with a fixed safe suffix.
  validateRefName(`${prefix}branch`);
  return prefix;
}

export function validateBranchNameTemplate(value: string): string {
  const template = value.trim();
  if (template === "") return "";
  if (utf8Length(template) > MAX_BRANCH_TEMPLATE_BYTES) {
    throw new Error(
      `branch-name-template must not exceed ${String(MAX_BRANCH_TEMPLATE_BYTES)} UTF-8 bytes`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/u.test(template)) {
    throw new Error("branch-name-template must not contain control characters");
  }
  const tokenPattern = /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu;
  const tokens = [...template.matchAll(tokenPattern)].map((match) => match[1] ?? "");
  if (tokens.length > 32) {
    throw new Error("branch-name-template contains too many variables");
  }
  const known = new Set<string>(branchTemplateVariables);
  const unknown = tokens.find((token) => !known.has(token));
  if (unknown !== undefined) {
    throw new Error(`branch-name-template contains unknown variable {{${unknown}}}`);
  }
  if (/[{}]/u.test(template.replace(tokenPattern, ""))) {
    throw new Error("branch-name-template contains malformed variable syntax");
  }
  if (!tokens.includes("prefix") || !tokens.includes("key")) {
    throw new Error("branch-name-template must include {{prefix}} and {{key}}");
  }
  return template;
}

function safeTemplateValue(name: BranchTemplateVariable, value: string): string {
  if (value === "" || utf8Length(value) > 128 || !/^[A-Za-z0-9/_.-]+$/u.test(value)) {
    throw new Error(`Unsafe branch template value for {{${name}}}`);
  }
  return value;
}

function sanitizeRefComponent(value: string): string {
  let component = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/\.\.+/gu, "-")
    .replace(/^[.-]+/gu, "")
    .replace(/\.+$/gu, "");
  if (component.endsWith(".lock")) component = `${component.slice(0, -5)}-lock`;
  return component || "branch";
}

/** Convert maintainer template literals into one conservative, validated Git ref. */
export function sanitizeBranchName(value: string): string {
  const branch = value.split(/\/+/u).filter(Boolean).map(sanitizeRefComponent).join("/");
  if (utf8Length(branch) > MAX_BRANCH_NAME_BYTES) {
    throw new Error(`Rendered branch name exceeds ${String(MAX_BRANCH_NAME_BYTES)} UTF-8 bytes`);
  }
  return validateRefName(branch);
}

/**
 * Render a maintainer template without weakening deterministic reconciliation:
 * the Controller-owned key must survive sanitization verbatim.
 */
export function buildControllerBranchName(input: ControllerBranchIdentity): string {
  const prefix = validateBranchPrefix(input.branchPrefix ?? "dsh/");
  const template = validateBranchNameTemplate(input.branchNameTemplate ?? "");
  if (template === "") {
    return sanitizeBranchName(`${prefix}${input.legacySuffix}`);
  }
  const variables: Record<BranchTemplateVariable, string> = {
    prefix,
    key: input.key,
    operation: input.operation,
    entityType: input.entityType,
    entityNumber: input.entityNumber,
  };
  const rendered = template.replace(
    /\{\{([A-Za-z][A-Za-z0-9]*)\}\}/gu,
    (_token, rawName: string) => {
      const name = rawName as BranchTemplateVariable;
      return safeTemplateValue(name, variables[name]);
    },
  );
  const branch = sanitizeBranchName(rendered);
  if (!branch.includes(input.key)) {
    throw new Error("Rendered branch name did not retain the Controller operation key");
  }
  return branch;
}

function slug(value: string): string {
  const candidate = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return candidate || "task";
}

export function buildDshBranch(
  entityNumber: number,
  hint: string,
  runIdentity = "run",
  configuration: BranchNameConfiguration = {},
): string {
  if (!Number.isSafeInteger(entityNumber) || entityNumber < 1) {
    throw new Error("Entity number must be a positive integer");
  }
  const operation = slug(hint);
  const key = slug(runIdentity);
  return buildControllerBranchName({
    ...configuration,
    key,
    operation,
    entityType: "issue",
    entityNumber: String(entityNumber),
    legacySuffix: `${String(entityNumber)}-${operation}-${key}`,
  });
}
