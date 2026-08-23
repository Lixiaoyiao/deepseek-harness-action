import { z } from "zod";

export const TASK_OUTPUT_LIMITS = {
  schemaBytes: 12 * 1024,
  schemaNodes: 512,
  schemaDepth: 12,
  schemaProperties: 128,
  schemaPropertiesPerObject: 64,
  schemaStringBytes: 2 * 1024,
  outputBytes: 64 * 1024,
  outputNodes: 2_048,
  outputDepth: 16,
  outputStringBytes: 16 * 1024,
  outputArrayItems: 256,
  outputObjectProperties: 256,
} as const;

export type TaskOutputSchema = Readonly<Record<string, unknown>>;

const schemaCache = new WeakMap<TaskOutputSchema, z.ZodType>();
const dangerousKeys = new Set(["__proto__", "constructor", "prototype"]);
const commonKeywords = new Set(["type", "description", "enum", "const"]);
const keywordsByType: Readonly<Record<string, ReadonlySet<string>>> = {
  object: new Set(["properties", "required", "additionalProperties"]),
  array: new Set(["items", "minItems", "maxItems"]),
  string: new Set(["minLength", "maxLength", "format"]),
  number: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
  integer: new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]),
  boolean: new Set(),
  null: new Set(),
};
const scalarTypes = new Set(["string", "number", "integer", "boolean", "null"]);
const supportedFormats = new Set([
  "email",
  "uri",
  "uri-reference",
  "uuid",
  "guid",
  "date-time",
  "date",
  "time",
  "duration",
  "ipv4",
  "ipv6",
]);

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function integerKeyword(
  schema: Record<string, unknown>,
  keyword: "minItems" | "maxItems" | "minLength" | "maxLength",
): number | undefined {
  const value = schema[keyword];
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${keyword} must be a non-negative safe integer`);
  }
  return value as number;
}

function numericKeyword(schema: Record<string, unknown>, keyword: string): number | undefined {
  const value = schema[keyword];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${keyword} must be a finite number`);
  }
  return value;
}

function matchesScalarType(value: unknown, type: string): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  return typeof value === type;
}

interface SchemaWalkState {
  nodes: number;
  properties: number;
}

function validateSchemaNode(
  value: unknown,
  depth: number,
  state: SchemaWalkState,
  path: string,
): void {
  if (!isObject(value)) throw new Error(`${path} must be a JSON Schema object`);
  state.nodes += 1;
  if (state.nodes > TASK_OUTPUT_LIMITS.schemaNodes) {
    throw new Error(`schema exceeds ${String(TASK_OUTPUT_LIMITS.schemaNodes)} nodes`);
  }
  if (depth > TASK_OUTPUT_LIMITS.schemaDepth) {
    throw new Error(`schema exceeds depth ${String(TASK_OUTPUT_LIMITS.schemaDepth)}`);
  }

  const type = value.type;
  if (typeof type !== "string" || !Object.hasOwn(keywordsByType, type)) {
    throw new Error(`${path}.type must be one supported JSON Schema type`);
  }
  const allowed = keywordsByType[type];
  for (const [key, keywordValue] of Object.entries(value)) {
    if (dangerousKeys.has(key)) throw new Error(`${path} contains dangerous key ${key}`);
    if (!commonKeywords.has(key) && !allowed?.has(key)) {
      throw new Error(`${path} contains unsupported keyword ${key}`);
    }
    if (typeof keywordValue === "string") {
      if (keywordValue.includes("\0")) throw new Error(`${path}.${key} contains a NUL byte`);
      if (byteLength(keywordValue) > TASK_OUTPUT_LIMITS.schemaStringBytes) {
        throw new Error(
          `${path}.${key} exceeds ${String(TASK_OUTPUT_LIMITS.schemaStringBytes)} bytes`,
        );
      }
    }
  }

  if (value.description !== undefined && typeof value.description !== "string") {
    throw new Error(`${path}.description must be a string`);
  }
  if ((value.enum !== undefined || value.const !== undefined) && !scalarTypes.has(type)) {
    throw new Error(`${path} may use enum or const only with scalar types`);
  }
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 64) {
      throw new Error(`${path}.enum must contain between 1 and 64 values`);
    }
    for (const enumValue of value.enum) {
      if (!matchesScalarType(enumValue, type)) {
        throw new Error(`${path}.enum contains a value that does not match type ${type}`);
      }
      if (
        typeof enumValue === "string" &&
        (enumValue.includes("\0") || byteLength(enumValue) > TASK_OUTPUT_LIMITS.schemaStringBytes)
      ) {
        throw new Error(`${path}.enum contains an invalid string`);
      }
    }
  }
  if (value.const !== undefined && !matchesScalarType(value.const, type)) {
    throw new Error(`${path}.const does not match type ${type}`);
  }
  if (
    typeof value.const === "string" &&
    (value.const.includes("\0") || byteLength(value.const) > TASK_OUTPUT_LIMITS.schemaStringBytes)
  ) {
    throw new Error(`${path}.const contains an invalid string`);
  }

  if (type === "object") {
    const properties = value.properties ?? {};
    if (!isObject(properties)) throw new Error(`${path}.properties must be an object`);
    const propertyEntries = Object.entries(properties);
    if (propertyEntries.length > TASK_OUTPUT_LIMITS.schemaPropertiesPerObject) {
      throw new Error(
        `${path}.properties exceeds ${String(TASK_OUTPUT_LIMITS.schemaPropertiesPerObject)} entries`,
      );
    }
    state.properties += propertyEntries.length;
    if (state.properties > TASK_OUTPUT_LIMITS.schemaProperties) {
      throw new Error(
        `schema exceeds ${String(TASK_OUTPUT_LIMITS.schemaProperties)} total properties`,
      );
    }
    const propertyNames = new Set<string>();
    for (const [name, propertySchema] of propertyEntries) {
      if (dangerousKeys.has(name))
        throw new Error(`${path}.properties contains dangerous key ${name}`);
      if (name === "" || byteLength(name) > 128 || name.includes("\0")) {
        throw new Error(`${path}.properties contains an invalid property name`);
      }
      propertyNames.add(name);
      validateSchemaNode(propertySchema, depth + 1, state, `${path}.properties.${name}`);
    }
    if (value.required !== undefined) {
      if (!Array.isArray(value.required) || value.required.length > propertyEntries.length) {
        throw new Error(`${path}.required must be a bounded array of declared property names`);
      }
      const seen = new Set<string>();
      for (const name of value.required) {
        if (typeof name !== "string" || !propertyNames.has(name) || seen.has(name)) {
          throw new Error(`${path}.required must contain unique declared property names`);
        }
        seen.add(name);
      }
    }
    if (
      value.additionalProperties !== undefined &&
      typeof value.additionalProperties !== "boolean"
    ) {
      validateSchemaNode(
        value.additionalProperties,
        depth + 1,
        state,
        `${path}.additionalProperties`,
      );
    }
    return;
  }

  if (type === "array") {
    if (value.items === undefined) throw new Error(`${path}.items is required for array schemas`);
    validateSchemaNode(value.items, depth + 1, state, `${path}.items`);
    const minimum = integerKeyword(value, "minItems");
    const maximum = integerKeyword(value, "maxItems");
    if (minimum !== undefined && minimum > TASK_OUTPUT_LIMITS.outputArrayItems) {
      throw new Error(`${path}.minItems exceeds the task output array limit`);
    }
    if (maximum !== undefined && maximum > TASK_OUTPUT_LIMITS.outputArrayItems) {
      throw new Error(`${path}.maxItems exceeds the task output array limit`);
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`${path}.minItems must not exceed maxItems`);
    }
    return;
  }

  if (type === "string") {
    const minimum = integerKeyword(value, "minLength");
    const maximum = integerKeyword(value, "maxLength");
    if (minimum !== undefined && minimum > TASK_OUTPUT_LIMITS.outputStringBytes) {
      throw new Error(`${path}.minLength exceeds the task output string limit`);
    }
    if (maximum !== undefined && maximum > TASK_OUTPUT_LIMITS.outputStringBytes) {
      throw new Error(`${path}.maxLength exceeds the task output string limit`);
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`${path}.minLength must not exceed maxLength`);
    }
    if (
      value.format !== undefined &&
      (typeof value.format !== "string" || !supportedFormats.has(value.format))
    ) {
      throw new Error(`${path}.format is unsupported`);
    }
    return;
  }

  if (type === "number" || type === "integer") {
    const minimum = numericKeyword(value, "minimum");
    const maximum = numericKeyword(value, "maximum");
    const exclusiveMinimum = numericKeyword(value, "exclusiveMinimum");
    const exclusiveMaximum = numericKeyword(value, "exclusiveMaximum");
    const multipleOf = numericKeyword(value, "multipleOf");
    if (multipleOf !== undefined && multipleOf <= 0) {
      throw new Error(`${path}.multipleOf must be positive`);
    }
    if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
      throw new Error(`${path}.minimum must not exceed maximum`);
    }
    if (
      exclusiveMinimum !== undefined &&
      exclusiveMaximum !== undefined &&
      exclusiveMinimum >= exclusiveMaximum
    ) {
      throw new Error(`${path}.exclusiveMinimum must be less than exclusiveMaximum`);
    }
  }
}

function deepFreeze(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}

function compileSchema(schema: TaskOutputSchema): z.ZodType {
  const cached = schemaCache.get(schema);
  if (cached !== undefined) return cached;
  let compiled: z.ZodType;
  try {
    compiled = z.fromJSONSchema(schema);
  } catch (error: unknown) {
    throw new Error(
      `task output schema could not be compiled: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  schemaCache.set(schema, compiled);
  return compiled;
}

/** Parse the maintainer-controlled input into a finite, immutable safe subset. */
export function parseTaskOutputSchema(raw: string): TaskOutputSchema | undefined {
  if (raw.trim() === "") return undefined;
  if (byteLength(raw) > TASK_OUTPUT_LIMITS.schemaBytes) {
    throw new Error(`task-output-schema exceeds ${String(TASK_OUTPUT_LIMITS.schemaBytes)} bytes`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error: unknown) {
    throw new Error("task-output-schema must be valid JSON", { cause: error });
  }
  if (!isObject(value) || value.type !== "object") {
    throw new Error("task-output-schema root must be a JSON Schema object with type object");
  }
  validateSchemaNode(value, 1, { nodes: 0, properties: 0 }, "$");
  deepFreeze(value);
  compileSchema(value);
  return value;
}

interface OutputWalkState {
  nodes: number;
}

function assertBoundedOutput(
  value: unknown,
  depth: number,
  state: OutputWalkState,
  path: string,
): void {
  state.nodes += 1;
  if (state.nodes > TASK_OUTPUT_LIMITS.outputNodes) {
    throw new Error(`taskOutput exceeds ${String(TASK_OUTPUT_LIMITS.outputNodes)} nodes`);
  }
  if (depth > TASK_OUTPUT_LIMITS.outputDepth) {
    throw new Error(`taskOutput exceeds depth ${String(TASK_OUTPUT_LIMITS.outputDepth)}`);
  }
  if (typeof value === "string") {
    if (byteLength(value) > TASK_OUTPUT_LIMITS.outputStringBytes) {
      throw new Error(`${path} exceeds ${String(TASK_OUTPUT_LIMITS.outputStringBytes)} bytes`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > TASK_OUTPUT_LIMITS.outputArrayItems) {
      throw new Error(`${path} exceeds ${String(TASK_OUTPUT_LIMITS.outputArrayItems)} array items`);
    }
    value.forEach((item, index) =>
      assertBoundedOutput(item, depth + 1, state, `${path}[${String(index)}]`),
    );
    return;
  }
  if (isObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > TASK_OUTPUT_LIMITS.outputObjectProperties) {
      throw new Error(
        `${path} exceeds ${String(TASK_OUTPUT_LIMITS.outputObjectProperties)} object properties`,
      );
    }
    for (const [key, child] of entries) {
      if (dangerousKeys.has(key)) throw new Error(`${path} contains dangerous key ${key}`);
      if (byteLength(key) > 128 || key.includes("\0"))
        throw new Error(`${path} has an invalid key`);
      assertBoundedOutput(child, depth + 1, state, `${path}.${key}`);
    }
  }
}

function renderIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Validate untrusted model data with both global resource limits and the trusted schema. */
export function validateTaskOutput(value: unknown, schema: TaskOutputSchema): unknown {
  let serialized: unknown;
  try {
    serialized = JSON.stringify(value);
  } catch (error: unknown) {
    throw new Error("taskOutput must be finite JSON data", { cause: error });
  }
  if (typeof serialized !== "string" || byteLength(serialized) > TASK_OUTPUT_LIMITS.outputBytes) {
    throw new Error(`taskOutput exceeds ${String(TASK_OUTPUT_LIMITS.outputBytes)} bytes`);
  }
  assertBoundedOutput(value, 1, { nodes: 0 }, "$.taskOutput");
  const parsed = compileSchema(schema).safeParse(value);
  if (!parsed.success) {
    throw new Error(`taskOutput failed trusted schema validation: ${renderIssues(parsed.error)}`);
  }
  return parsed.data;
}
