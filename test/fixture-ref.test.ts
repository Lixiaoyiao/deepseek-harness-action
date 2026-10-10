import { z } from "zod";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const helperUrl = new URL("../.github/e2e/fixture-ref.mjs", import.meta.url).href;
const cwd = fileURLToPath(new URL("..", import.meta.url));
const expectedSha = "a1".repeat(20);
const otherSha = "b2".repeat(20);
const privateTransportMessage = "PRIVATE_TRANSPORT_DETAIL_MUST_NOT_BE_REPORTED";

interface Input {
  readonly operation: "create" | "delete";
  readonly repository: string;
  readonly runId: string;
  readonly runAttempt: string;
  readonly ref: string;
  readonly expectedSha: string;
}

interface Reply {
  readonly status?: number | undefined;
  readonly value?: unknown;
  readonly error?: string | undefined;
  readonly advanceMs?: number | undefined;
}

interface Replay {
  readonly result?:
    | {
        readonly operation: "create" | "delete";
        readonly writes: number;
        readonly reads: number;
      }
    | undefined;
  readonly error?: string | undefined;
  readonly requests: readonly {
    readonly method: string;
    readonly path: string;
    readonly body?: unknown;
    readonly hasSignal: boolean;
  }[];
  readonly reports: readonly Readonly<Record<string, unknown>>[];
  readonly waits: readonly number[];
  readonly remaining: number;
}

const driver = `
import { readFileSync } from "node:fs";
const { confirmFixtureRef } = await import(process.argv[1]);
const input = JSON.parse(readFileSync(0, "utf8"));
const replies = [...input.replies];
const requests = [];
const reports = [];
const waits = [];
let clock = 1000;
let result;
let error;
try {
  result = await confirmFixtureRef(input.request, {
    request: async ({ method, path, body, signal }) => {
      requests.push({ method, path, ...(body === undefined ? {} : { body }), hasSignal: signal instanceof AbortSignal });
      const reply = replies.shift();
      if (reply === undefined) throw new Error("UNSCRIPTED_REQUEST");
      clock += reply.advanceMs ?? 0;
      if (reply.error !== undefined) throw new Error(reply.error);
      return { status: reply.status, ...(Object.hasOwn(reply, "value") ? { value: reply.value } : {}) };
    },
    now: () => clock,
    wait: async (ms) => { waits.push(ms); clock += ms; },
    report: (event) => reports.push(event),
  });
} catch (failure) {
  error = failure instanceof Error ? failure.message : String(failure);
}
process.stdout.write(JSON.stringify({ result, error, requests, reports, waits, remaining: replies.length }) + "\\n");
`;

function request(operation: Input["operation"] = "create", ref = "dsh-e2e/checks-123-2"): Input {
  return {
    operation,
    repository: "Lixiaoyiao/deepseek-harness-action",
    runId: "123",
    runAttempt: "2",
    ref,
    expectedSha,
  };
}

function identity(input: Input, overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ref: `refs/heads/${input.ref}`,
    object: { type: "commit", sha: input.expectedSha },
    ...overrides,
  };
}

function replay(input: Input, replies: readonly Reply[]): Replay {
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", driver, helperUrl], {
    cwd,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    input: JSON.stringify({ request: input, replies }),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  });
  if (child.error !== undefined) throw child.error;
  expect(child.status, child.stderr).toBe(0);
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe("");
  const result = z
    .looseObject({
      result: z
        .looseObject({
          operation: z.union([z.literal("create"), z.literal("delete")]),
          writes: z.number(),
          reads: z.number(),
        })
        .optional(),
      error: z.string().optional(),
      requests: z.array(
        z.looseObject({
          method: z.string(),
          path: z.string(),
          body: z.unknown().optional(),
          hasSignal: z.boolean(),
        }),
      ),
      reports: z.array(z.record(z.string(), z.unknown())),
      waits: z.array(z.number()),
      remaining: z.number(),
    })
    .parse(JSON.parse(child.stdout));
  for (const event of result.reports) {
    expect(Object.keys(event).sort()).toEqual(["attempt", "operation", "stage", "status"]);
    expect(event.operation).toBe(input.operation);
    expect(typeof event.stage).toBe("string");
    expect(event.status === null || ["number", "string"].includes(typeof event.status)).toBe(true);
    expect(Number.isSafeInteger(event.attempt)).toBe(true);
  }
  const reported = JSON.stringify(result.reports);
  for (const omitted of [input.ref, input.expectedSha, privateTransportMessage])
    expect(reported).not.toContain(omitted);
  expect(result.requests.every(({ hasSignal }) => hasSignal)).toBe(true);
  return result;
}

function methods(result: Replay): string[] {
  return result.requests.map(({ method }) => method);
}

function assertFailed(result: Replay): void {
  expect(result.result).toBeUndefined();
  expect(result.error).toEqual(expect.any(String));
}

describe("run-bound fixture ref confirmation", () => {
  it("creates once and confirms the full ref identity without repeating the write", () => {
    const input = request();
    const result = replay(input, [
      { status: 201, value: identity(input) },
      { status: 200, value: identity(input) },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ operation: "create", writes: 1, reads: 1 });
    expect(methods(result)).toEqual(["POST", "GET"]);
    expect(result.requests[0]?.body).toEqual({ ref: `refs/heads/${input.ref}`, sha: expectedSha });
    expect(result.requests[0]?.path).toBe("git/refs");
    expect(result.requests[1]?.path.replace(/^\//u, "")).toBe(`git/ref/heads/${input.ref}`);
    expect(result.waits).toEqual([]);
  });

  it.each(["dsh-e2e/checks-123-2", "dsh-e2e/checks-base-123-2"])(
    "retries only confirmation reads while created ref %s is briefly absent",
    (ref) => {
      const input = request("create", ref);
      const result = replay(input, [
        { status: 201, value: identity(input) },
        { status: 404 },
        { status: 404 },
        { status: 200, value: identity(input) },
      ]);
      expect(result.result).toEqual({ operation: "create", writes: 1, reads: 3 });
      expect(methods(result)).toEqual(["POST", "GET", "GET", "GET"]);
      expect(result.waits).toEqual([1_000, 1_000]);
    },
  );

  it("validates the existing ref, deletes once, and tolerates only stale reads of that same identity", () => {
    const input = request("delete");
    const result = replay(input, [
      { status: 200, value: identity(input) },
      { status: 204 },
      { status: 200, value: identity(input) },
      { status: 200, value: identity(input) },
      { status: 404 },
    ]);
    expect(result.result).toEqual({ operation: "delete", writes: 1, reads: 4 });
    expect(methods(result)).toEqual(["GET", "DELETE", "GET", "GET", "GET"]);
    expect(result.requests[1]?.body).toBeUndefined();
    expect(result.requests[1]?.path.replace(/^\//u, "")).toBe(`git/refs/heads/${input.ref}`);
    expect(result.waits).toEqual([1_000, 1_000]);
  });

  it("treats an already absent delete target as complete without any write", () => {
    const result = replay(request("delete"), [{ status: 404 }]);
    expect(result.result).toEqual({ operation: "delete", writes: 0, reads: 1 });
    expect(methods(result)).toEqual(["GET"]);
    expect(result.waits).toEqual([]);
  });

  const ambiguousWrites: readonly Reply[] = [
    { error: privateTransportMessage },
    { status: 404 },
    { status: 500 },
    { status: 503 },
  ];
  it.each(ambiguousWrites)("confirms an ambiguous create response using only GET: %j", (reply) => {
    const input = request();
    const result = replay(input, [reply, { status: 200, value: identity(input) }]);
    expect(result.result).toEqual({ operation: "create", writes: 1, reads: 1 });
    expect(methods(result)).toEqual(["POST", "GET"]);
  });

  it.each(ambiguousWrites)("confirms an ambiguous delete response using only GET: %j", (reply) => {
    const input = request("delete");
    const result = replay(input, [{ status: 200, value: identity(input) }, reply, { status: 404 }]);
    expect(result.result).toEqual({ operation: "delete", writes: 1, reads: 2 });
    expect(methods(result)).toEqual(["GET", "DELETE", "GET"]);
  });

  it.each([400, 401, 403, 408, 422, 429])(
    "does not confirm or retry explicitly rejected create status %i",
    (status) => {
      const input = request();
      const result = replay(input, [{ status }, { status: 200, value: identity(input) }]);
      assertFailed(result);
      expect(methods(result)).toEqual(["POST"]);
      expect(result.remaining).toBe(1);
    },
  );

  it.each([400, 401, 403, 408, 422, 429])(
    "does not confirm or retry explicitly rejected delete status %i",
    (status) => {
      const input = request("delete");
      const result = replay(input, [
        { status: 200, value: identity(input) },
        { status },
        { status: 404 },
      ]);
      assertFailed(result);
      expect(methods(result)).toEqual(["GET", "DELETE"]);
      expect(result.remaining).toBe(1);
    },
  );

  const rejectedReads: readonly Reply[] = [
    { status: 403 },
    { status: 429 },
    { status: 500 },
    { status: 302 },
    { status: 999 },
    {},
    { error: privateTransportMessage },
  ];
  it.each(rejectedReads)("fails closed immediately when a confirmation GET fails: %j", (reply) => {
    const input = request();
    const result = replay(input, [
      { status: 201, value: identity(input) },
      reply,
      { status: 200, value: identity(input) },
    ]);
    assertFailed(result);
    expect(methods(result)).toEqual(["POST", "GET"]);
    expect(result.remaining).toBe(1);
    expect(result.waits).toEqual([]);
  });

  it.each(rejectedReads)("does not delete after an unsuccessful initial GET: %j", (reply) => {
    const result = replay(request("delete"), [reply, { status: 204 }]);
    assertFailed(result);
    expect(methods(result)).toEqual(["GET"]);
    expect(result.remaining).toBe(1);
  });

  function invalidIdentities(input: Input): readonly unknown[] {
    return [
      null,
      {},
      { ref: `refs/heads/${input.ref}` },
      identity(input, { ref: "refs/heads/dsh-e2e/checks-999-2" }),
      identity(input, { object: { type: "tag", sha: expectedSha } }),
      identity(input, { object: { type: "commit", sha: otherSha } }),
    ];
  }

  it.each(invalidIdentities(request()))(
    "rejects a malformed or different create response before confirming: %j",
    (value) => {
      const input = request();
      const result = replay(input, [
        { status: 201, value },
        { status: 200, value: identity(input) },
      ]);
      assertFailed(result);
      expect(methods(result)).toEqual(["POST"]);
    },
  );

  it.each(invalidIdentities(request()))(
    "rejects a malformed or mismatched identity from confirmation GET: %j",
    (value) => {
      const input = request();
      const result = replay(input, [
        { status: 201, value: identity(input) },
        { status: 200, value },
        { status: 200, value: identity(input) },
      ]);
      assertFailed(result);
      expect(methods(result)).toEqual(["POST", "GET"]);
      expect(result.remaining).toBe(1);
      expect(result.waits).toEqual([]);
    },
  );

  it.each(invalidIdentities(request("delete")))(
    "never deletes a malformed or different initial ref identity: %j",
    (value) => {
      const result = replay(request("delete"), [{ status: 200, value }, { status: 204 }]);
      assertFailed(result);
      expect(methods(result)).toEqual(["GET"]);
    },
  );

  it("stops if a deleted ref is recreated at another SHA rather than deleting it again", () => {
    const input = request("delete");
    const result = replay(input, [
      { status: 200, value: identity(input) },
      { status: 204 },
      { status: 200, value: identity(input, { object: { type: "commit", sha: otherSha } }) },
      { status: 404 },
    ]);
    assertFailed(result);
    expect(methods(result)).toEqual(["GET", "DELETE", "GET"]);
    expect(result.remaining).toBe(1);
  });

  it.each(["dsh-e2e/checks-124-2", "dsh-e2e/checks-123-3", "dsh-e2e/checks-base-123-3", "main"])(
    "rejects ref %s outside the exact run identity without issuing requests",
    (ref) => {
      const result = replay(request("create", ref), []);
      assertFailed(result);
      expect(result.requests).toEqual([]);
    },
  );

  it("stops after five absent confirmation reads and never repeats the create", () => {
    const input = request();
    const result = replay(input, [
      { status: 201, value: identity(input) },
      ...Array.from({ length: 5 }, () => ({ status: 404 })),
      { status: 200, value: identity(input) },
    ]);
    assertFailed(result);
    expect(methods(result)).toEqual(["POST", "GET", "GET", "GET", "GET", "GET"]);
    expect(result.waits).toEqual([1_000, 1_000, 1_000, 1_000]);
    expect(result.remaining).toBe(1);
  });

  it("issues no confirmation request after the total deadline expires during a write", () => {
    const input = request();
    const result = replay(input, [
      { status: 201, value: identity(input), advanceMs: 20_001 },
      { status: 200, value: identity(input) },
    ]);
    assertFailed(result);
    expect(methods(result)).toEqual(["POST"]);
    expect(result.remaining).toBe(1);
    expect(result.waits).toEqual([]);
  });
});
