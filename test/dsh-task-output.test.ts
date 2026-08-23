import { describe, expect, it } from "vitest";

import { parseDshOutput } from "../src/dsh/schema.js";
import {
  parseTaskOutputSchema,
  TASK_OUTPUT_LIMITS,
  validateTaskOutput,
} from "../src/dsh/task-output.js";

const schemaJson = JSON.stringify({
  type: "object",
  properties: {
    releaseReady: { type: "boolean" },
    risk: { type: "string", enum: ["low", "high"] },
    checks: {
      type: "array",
      items: { type: "string", maxLength: 40 },
      maxItems: 4,
    },
  },
  required: ["releaseReady", "risk"],
  additionalProperties: false,
});

function taskEnvelope(extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    operation: "task",
    state: "final",
    summary: "Task complete",
    findings: [],
    ...extra,
  };
}

describe("trusted task output schema", () => {
  it("compiles the supported schema subset and validates model data", () => {
    const schema = parseTaskOutputSchema(schemaJson);
    expect(schema).toBeDefined();
    if (schema === undefined) throw new Error("expected task output schema");
    expect(Object.isFrozen(schema)).toBe(true);
    expect(
      validateTaskOutput(
        { releaseReady: true, risk: "low", checks: ["unit", "integration"] },
        schema,
      ),
    ).toEqual({ releaseReady: true, risk: "low", checks: ["unit", "integration"] });
    expect(() => validateTaskOutput({ releaseReady: true, risk: "medium" }, schema)).toThrow(
      /trusted schema validation/u,
    );
    expect(() =>
      validateTaskOutput({ releaseReady: true, risk: "low", authority: "write" }, schema),
    ).toThrow(/Unrecognized key/u);
  });

  it.each([
    ["non-object root", '"string"'],
    ["non-object result", '{"type":"string"}'],
    ["remote ref", '{"type":"object","$ref":"https://example.test/schema.json"}'],
    ["local ref", '{"type":"object","$ref":"#/$defs/value"}'],
    ["combinator", '{"type":"object","anyOf":[{"type":"object"}]}'],
    ["pattern", '{"type":"object","properties":{"x":{"type":"string","pattern":"(a+)+"}}}'],
    ["conditional", '{"type":"object","if":{"type":"object"}}'],
    ["default", '{"type":"object","properties":{"x":{"type":"string","default":"x"}}}'],
    ["unknown keyword", '{"type":"object","title":"ignored"}'],
    ["prototype type", '{"type":"object","properties":{"x":{"type":"toString"}}}'],
    ["dangerous property", '{"type":"object","properties":{"__proto__":{"type":"string"}}}'],
  ])("rejects %s schemas", (_name, raw) => {
    expect(() => parseTaskOutputSchema(raw)).toThrow();
  });

  it("bounds schema bytes, nesting, and property complexity", () => {
    expect(() =>
      parseTaskOutputSchema(
        JSON.stringify({ type: "object", description: "x".repeat(TASK_OUTPUT_LIMITS.schemaBytes) }),
      ),
    ).toThrow(/bytes/u);

    let nested: Record<string, unknown> = { type: "string" };
    for (let index = 0; index < TASK_OUTPUT_LIMITS.schemaDepth; index += 1) {
      nested = { type: "array", items: nested };
    }
    expect(() =>
      parseTaskOutputSchema(
        JSON.stringify({ type: "object", properties: { nested }, additionalProperties: false }),
      ),
    ).toThrow(/depth/u);

    const properties = Object.fromEntries(
      Array.from({ length: TASK_OUTPUT_LIMITS.schemaPropertiesPerObject + 1 }, (_, index) => [
        `p${String(index)}`,
        { type: "boolean" },
      ]),
    );
    expect(() => parseTaskOutputSchema(JSON.stringify({ type: "object", properties }))).toThrow(
      /properties exceeds/u,
    );
  });

  it("applies global output size, depth, string, array, and dangerous-key limits", () => {
    const permissive = parseTaskOutputSchema(
      JSON.stringify({ type: "object", additionalProperties: true }),
    );
    if (permissive === undefined) throw new Error("expected task output schema");
    expect(() =>
      validateTaskOutput(
        { value: "x".repeat(TASK_OUTPUT_LIMITS.outputStringBytes + 1) },
        permissive,
      ),
    ).toThrow(/bytes/u);
    expect(() =>
      validateTaskOutput(
        { values: Array.from({ length: TASK_OUTPUT_LIMITS.outputArrayItems + 1 }, () => 1) },
        permissive,
      ),
    ).toThrow(/array items/u);
    expect(() =>
      validateTaskOutput(
        Object.fromEntries(
          Array.from({ length: TASK_OUTPUT_LIMITS.outputObjectProperties + 1 }, (_, index) => [
            `p${String(index)}`,
            index,
          ]),
        ),
        permissive,
      ),
    ).toThrow(/object properties/u);
    expect(() =>
      validateTaskOutput(
        Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [
            `items${String(index)}`,
            Array.from({ length: TASK_OUTPUT_LIMITS.outputArrayItems }, () => 1),
          ]),
        ),
        permissive,
      ),
    ).toThrow(/nodes/u);
    expect(() =>
      validateTaskOutput(
        {
          values: Array.from({ length: 5 }, () =>
            "x".repeat(TASK_OUTPUT_LIMITS.outputStringBytes - 2_000),
          ),
        },
        permissive,
      ),
    ).toThrow(/taskOutput exceeds .* bytes/u);

    let nested: unknown = "leaf";
    for (let index = 0; index < TASK_OUTPUT_LIMITS.outputDepth; index += 1) {
      nested = { child: nested };
    }
    expect(() => validateTaskOutput({ nested }, permissive)).toThrow(/depth/u);

    const dangerous = JSON.parse('{"__proto__":{"authority":"write"}}') as unknown;
    expect(() => validateTaskOutput(dangerous, permissive)).toThrow(/dangerous key/u);
  });
});

describe("taskOutput protocol rules", () => {
  const schema = parseTaskOutputSchema(schemaJson);
  if (schema === undefined) throw new Error("expected task output schema");

  it("requires and returns validated taskOutput only for a configured final task", () => {
    const output = parseDshOutput(
      JSON.stringify(
        taskEnvelope({ taskOutput: { releaseReady: true, risk: "low", checks: ["unit"] } }),
      ),
      "task",
      schema,
    );
    expect(output.taskOutput).toEqual({ releaseReady: true, risk: "low", checks: ["unit"] });
    expect(() => parseDshOutput(JSON.stringify(taskEnvelope()), "task", schema)).toThrow(
      /is required/u,
    );
    expect(() =>
      parseDshOutput(
        JSON.stringify(taskEnvelope({ taskOutput: { releaseReady: "yes", risk: "low" } })),
        "task",
        schema,
      ),
    ).toThrow(/trusted schema validation/u);
  });

  it("allows intermediate needs_tool and blocked task states to omit taskOutput", () => {
    expect(
      parseDshOutput(
        JSON.stringify(
          taskEnvelope({
            state: "needs_tool",
            toolRequest: { id: "command.test", input: {} },
          }),
        ),
        "task",
        schema,
      ).taskOutput,
    ).toBeUndefined();
    expect(
      parseDshOutput(JSON.stringify(taskEnvelope({ state: "blocked" })), "task", schema).taskOutput,
    ).toBeUndefined();
  });

  it("rejects taskOutput when unconfigured or emitted by other operations and states", () => {
    expect(() =>
      parseDshOutput(
        JSON.stringify(taskEnvelope({ taskOutput: { releaseReady: true, risk: "low" } })),
        "task",
      ),
    ).toThrow(/no trusted task-output-schema/u);
    expect(() =>
      parseDshOutput(
        JSON.stringify({
          ...taskEnvelope({ taskOutput: { releaseReady: true, risk: "low" } }),
          operation: "review",
        }),
        "review",
        schema,
      ),
    ).toThrow(/allowed only for a final task/u);
    expect(() =>
      parseDshOutput(
        JSON.stringify(
          taskEnvelope({
            state: "needs_tool",
            toolRequest: { id: "command.test", input: {} },
            taskOutput: { releaseReady: true, risk: "low" },
          }),
        ),
        "task",
        schema,
      ),
    ).toThrow(/allowed only for a final task/u);
  });
});
