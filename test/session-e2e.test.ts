import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseTaskOutputSchema, validateTaskOutput } from "../src/dsh/task-output.js";
import { loadInputs } from "../src/inputs.js";

interface FixtureModule {
  buildSessionTask(
    phase: string,
    challenge: string,
    memory?: string,
  ): { prompt: string; schema: string };
  assertSourceProof(proof: unknown, expected: Record<string, unknown>): unknown;
  resultChecks(result: unknown, expected: Record<string, unknown>): Record<string, boolean>;
  failureChecks(
    result: unknown,
    expected: Record<string, unknown>,
    actionOutcome: string,
  ): Record<string, boolean>;
  selectSessionHistory(
    runs: unknown[],
    current: Record<string, unknown>,
  ): { status: string; source?: { id: number } };
  inspectCheckpointArchive(
    input: Uint8Array,
    expected: Record<string, unknown>,
  ): {
    payload: Buffer;
    payloadSha256: string;
    archiveSha256: string;
    eventCount: number;
    generation: number;
  };
}
let fixture: FixtureModule;
const now = Date.parse("2026-10-04T01:00:00Z");
const id = "session-11111111-1111-4111-8111-111111111111";
const memory = "a".repeat(48);
const challenge = "b".repeat(24);
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

beforeAll(async () => {
  fixture = (await import(
    pathToFileURL(resolve(".github/e2e/session-e2e-proof.mjs")).href
  )) as FixtureModule;
});

function identity(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: "save",
    repository: "octo/repo",
    runId: 10,
    runAttempt: 1,
    candidateSha: "c".repeat(40),
    harnessSha: "d".repeat(40),
    dshMode: "controlled",
    keyHash: "e".repeat(64),
    memory,
    challenge,
    sessionId: id,
    artifactId: 30,
    generation: 1,
    permissionMode: "workspace-write",
    ...extra,
  };
}

function checkpoint(
  options: {
    generation?: number;
    mode?: string;
    dshMode?: string;
    extraFile?: boolean;
    extraTurn?: boolean;
  } = {},
) {
  const generation = options.generation ?? 1;
  const permissionMode = options.mode ?? "workspace-write";
  const events: Record<string, unknown>[] = [
    { type: "permission/preset", data: { preset: permissionMode } },
    { type: "sandbox/mode", data: { mode: permissionMode } },
    { type: "approval/policy", data: { policy: "never" } },
  ];
  for (let turn = 1; turn <= generation + (options.extraTurn === true ? 1 : 0); turn++) {
    events.push(
      { type: "turn/start", data: { turn } },
      {
        type: "user/message",
        data: {
          id: `message-${String(turn)}`,
          role: "user",
          content: [{ type: "text", text: `${memory} ${challenge}` }],
          source: { kind: "user" },
        },
        surfaceOp: "append",
      },
      { type: "turn/end", data: { turn, reason: { kind: "completed" } } },
    );
  }
  const header = sessionFormatCatalog.encodeCurrentHeader(
    { version: 4, id, createdAt: now, cwd: "/workspace", isSeeded: false, delegationDepth: 0 },
    0,
  );
  const payload = Buffer.from(
    [header, ...events.map((event, seq) => ({ ...event, seq, time: now + seq }))]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const manifest = {
    schemaVersion: 1,
    repository: { id: 1, owner: "octo", repo: "repo" },
    workflow: {
      path: ".github/workflows/session-e2e.yml",
      jobId: "session",
      jobName: "session",
      runId: 10,
      runAttempt: 1,
      sourceSha: "d".repeat(40),
    },
    runtime: { dshVersion: "0.2.0-rc.2", mode: options.dshMode ?? "controlled" },
    session: { sessionId: id, keyHash: "e".repeat(64), generation },
    payload: { file: "session.jsonl", bytes: payload.length, sha256: hash(payload) },
  };
  const archive = zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "session.jsonl": payload,
    ...(options.extraFile === true ? { "extra.txt": Buffer.from("not admissible") } : {}),
  });
  return {
    archive,
    payload,
    expected: identity({
      generation,
      permissionMode,
      dshMode: options.dshMode ?? "controlled",
      payloadSha256: hash(payload),
    }),
  };
}

function successResult(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "success",
    operation: "task",
    taskOutput: { memory, challenge, phase: "save" },
    policy: { trust: "trusted-write" },
    permissions: { workspaceWrite: true },
    isolation: { backend: "docker", processIsolated: true, workspaceAccess: "read-write" },
    dsh: { mode: "controlled" },
    session: {
      mode: "save",
      status: "saved",
      generation: 1,
      artifactId: 30,
      payloadSha256: "f".repeat(64),
      sessionId: id,
    },
    loop: { turns: 1, toolCalls: 0 },
    write: { status: "no-changes", changedPaths: [] },
    validation: { status: "not-applicable", commandCount: 0 },
    ...extra,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected mapping");
  return value as Record<string, unknown>;
}

describe("independent Actions Session qualification fixture", () => {
  it("supplies a new challenge while withholding historical memory from every resume input", () => {
    const save = fixture.buildSessionTask("save", challenge, memory);
    const resume = fixture.buildSessionTask("resume", challenge, memory);
    expect(save.prompt).toContain(memory);
    expect(resume.prompt).toContain(challenge);
    expect(resume.prompt).not.toContain(memory);
    expect(resume.schema).not.toContain(memory);
    const schema = object(JSON.parse(resume.schema));
    expect(object(object(schema.properties).memory)).toEqual({
      type: "string",
      minLength: 48,
      maxLength: 48,
    });
  });

  it.each(["save", "resume"])(
    "admits the real prepare-generated %s schema through public schema and workflow input parsers",
    async (phase) => {
      const task = fixture.buildSessionTask(phase, challenge, memory);
      const schema = parseTaskOutputSchema(task.schema);
      if (schema === undefined) throw new Error("Expected generated task schema");
      expect(validateTaskOutput({ memory, challenge, phase }, schema)).toEqual({
        memory,
        challenge,
        phase,
      });
      expect(() =>
        validateTaskOutput({ memory, challenge: "0".repeat(24), phase }, schema),
      ).toThrow();
      expect(() =>
        validateTaskOutput(
          { memory, challenge, phase: phase === "save" ? "resume" : "save" },
          schema,
        ),
      ).toThrow();
      expect(() =>
        validateTaskOutput({ memory: memory.slice(1), challenge, phase }, schema),
      ).toThrow();
      const wrongMemory = "f".repeat(48);
      expect(validateTaskOutput({ memory: wrongMemory, challenge, phase }, schema)).toEqual({
        memory: wrongMemory,
        challenge,
        phase,
      });
      expect(
        fixture.resultChecks(
          { taskOutput: { memory: wrongMemory, challenge, phase } },
          identity({ phase }),
        ).memory,
      ).toBe(false);

      const workflow = object(
        parse(
          await readFile(new URL("../.github/workflows/session-e2e.yml", import.meta.url), "utf8"),
        ),
      );
      const steps = object(object(workflow.jobs).session).steps;
      if (!Array.isArray(steps)) throw new Error("Expected actual workflow steps");
      const action = steps.map(object).find((step) => step.id === "action");
      const declaredInputs = object(object(action).with);
      for (const mode of ["controlled", "native"]) {
        const expressions: Readonly<Record<string, string>> = {
          "${{ secrets.DEEPSEEK_API_KEY }}": "fixture-model-credential",
          "${{ github.token }}": "fixture-controller-credential",
          "${{ steps.task.outputs.phase == 'save' && 'write' || 'read' }}":
            phase === "save" ? "write" : "read",
          "${{ inputs.dsh_mode }}": mode,
          "${{ steps.task.outputs.prompt }}": task.prompt,
          "${{ steps.task.outputs.schema }}": task.schema,
          "${{ inputs.session_key }}": "fixture-logical-task",
        };
        const values = Object.fromEntries(
          Object.entries(declaredInputs).map(([name, raw]) => {
            if (typeof raw !== "string")
              throw new Error("Workflow inputs must be explicit strings");
            const value = expressions[raw] ?? raw;
            if (value.includes("${{")) throw new Error("Unresolved fixture expression");
            return [name, value];
          }),
        );
        // This fixture also lands on the permanent harness before the candidate's auto parser.
        // Session admission is asserted below; keep this schema-only parser check version-independent.
        const parsed = loadInputs((name) =>
          name === "session-mode" ? "off" : name === "session-key" ? "" : (values[name] ?? ""),
        );
        expect(parsed.taskOutputSchema).toEqual(schema);
        expect(parsed.dshMode).toBe(mode);
        expect(parsed.taskAccess).toBe(phase === "save" ? "write" : "read");
      }
    },
  );

  it.each([
    "repository",
    "runId",
    "runAttempt",
    "candidateSha",
    "harnessSha",
    "dshMode",
    "keyHash",
  ])("refuses proof whose %s is not from the selected successful source run", (key) => {
    const expected = identity();
    const proof = { ...expected, schemaVersion: 1, qualified: true, payloadSha256: "f".repeat(64) };
    expect(fixture.assertSourceProof(proof, expected)).toEqual(proof);
    expect(() =>
      fixture.assertSourceProof({ ...proof, [key]: "different-source" }, expected),
    ).toThrow("SOURCE_BINDING");
  });

  it.each(["controlled", "native"])(
    "decodes complete released v4 persistence and verifies %s checksum and current policy",
    (mode) => {
      const value = checkpoint({ dshMode: mode });
      expect(fixture.inspectCheckpointArchive(value.archive, value.expected)).toEqual({
        payload: value.payload,
        payloadSha256: hash(value.payload),
        archiveSha256: hash(value.archive),
        generation: 1,
        eventCount: 6,
      });
    },
  );

  it.each([
    { payloadSha256: "0".repeat(64) },
    { sessionId: id.replace("11111111", "33333333") },
    { runId: 11 },
    { runAttempt: 2 },
    { harnessSha: "1".repeat(40) },
    { generation: 2 },
    { keyHash: "2".repeat(64) },
    { permissionMode: "read-only" },
    { challenge: "0".repeat(24) },
  ])("rejects wrong checkpoint identity, checksum, permissions or new request %j", (extra) => {
    const value = checkpoint();
    expect(() =>
      fixture.inspectCheckpointArchive(value.archive, { ...value.expected, ...extra }),
    ).toThrow();
  });

  it("rejects hidden extra files and does not accept an extra replayed task", () => {
    const extra = checkpoint({ extraFile: true });
    expect(() => fixture.inspectCheckpointArchive(extra.archive, extra.expected)).toThrow(
      "ARCHIVE_FILES",
    );
    const replay = checkpoint({ extraTurn: true });
    expect(() => fixture.inspectCheckpointArchive(replay.archive, replay.expected)).toThrow(
      "ONLY_NEW_TASK",
    );
    const resumed = checkpoint({ generation: 2, mode: "read-only" });
    expect(fixture.inspectCheckpointArchive(resumed.archive, resumed.expected).generation).toBe(2);
  });

  it("requires genuine independent-run memory plus current read-only policy and fresh artifact", () => {
    const expected = identity({
      phase: "resume",
      generation: 2,
      runId: 11,
      sourceRunId: 10,
      payloadSha256: "0".repeat(64),
    });
    const result = successResult({
      taskOutput: { memory, challenge, phase: "resume" },
      policy: { trust: "trusted-read" },
      permissions: { workspaceWrite: false },
      isolation: { backend: "docker", processIsolated: true, workspaceAccess: "read-only" },
      session: {
        mode: "resume",
        status: "saved",
        generation: 2,
        sourceRunId: 10,
        sessionId: id,
        artifactId: 31,
        payloadSha256: "f".repeat(64),
      },
      write: {},
    });
    expect(Object.values(fixture.resultChecks(result, expected)).every(Boolean)).toBe(true);
    expect(
      fixture.resultChecks(
        { ...result, taskOutput: { memory: "wrong", challenge, phase: "resume" } },
        expected,
      ).memory,
    ).toBe(false);
    expect(
      fixture.resultChecks({ ...result, permissions: { workspaceWrite: true } }, expected)
        .currentPermission,
    ).toBe(false);
    expect(
      fixture.resultChecks({ ...result, loop: { dshToolReceipts: [{ ok: true }] } }, expected)
        .noToolsOrWrites,
    ).toBe(false);
    expect(fixture.resultChecks(result, { ...expected, runId: 10 }).newRun).toBe(false);
    expect(Object.values(fixture.resultChecks(undefined, expected)).every(Boolean)).toBe(false);
  });

  it("keeps one static trusted producer, read-only fixture tokens and a real fail-closed validator", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/session-e2e.yml", import.meta.url),
      "utf8",
    );
    const parsed = object(parse(workflow));
    expect(parsed.permissions).toEqual({});
    expect(parsed["run-name"]).toBe("dsh-session-${{ inputs.session_key }}");
    expect(parsed.concurrency).toEqual({
      group: "dsh-session-${{ inputs.session_key }}",
      "cancel-in-progress": false,
    });
    const jobs = object(parsed.jobs);
    const producers = Object.entries(jobs).flatMap(([jobId, rawJob]) => {
      const steps = object(rawJob).steps;
      if (!Array.isArray(steps)) return [];
      return steps.map(object).flatMap((step) => {
        if (step.with === undefined) return [];
        const inputs = object(step.with);
        return inputs["session-mode"] !== undefined && inputs["session-mode"] !== "off"
          ? [{ jobId, step }]
          : [];
      });
    });
    expect(producers).toHaveLength(1);
    expect(producers[0]?.jobId).toBe("session");
    const job = object(jobs.session);
    expect(job.permissions).toEqual({ contents: "read", "pull-requests": "read", actions: "read" });
    expect(job.environment).toBe("core-e2e");
    expect(job["timeout-minutes"]).toBe(30);
    expect(job.strategy).toBeUndefined();
    expect(job.name).toBeUndefined();
    const producer = object(producers[0]?.step);
    expect(producer.uses).toBe("./candidate-action");
    const inputs = object(producer.with);
    expect(inputs["session-mode"]).toBe("auto");
    expect(inputs["session-source-run-id"]).toBeUndefined();
    expect(inputs["task-access"]).toBe(
      "${{ steps.task.outputs.phase == 'save' && 'write' || 'read' }}",
    );
    expect(inputs["deepseek-api-key"]).toBe("${{ secrets.DEEPSEEK_API_KEY }}");
    expect(inputs["base-url"]).toBeUndefined();
    expect(inputs["max-turns"]).toBe("1");
    expect(inputs["run-tests"]).toBe("true");
    expect(JSON.parse(String(inputs["test-commands"]))).toEqual([
      ["npm", "ci", "--ignore-scripts"],
      ["npm", "run", "typecheck"],
      ["npm", "test"],
    ]);
    expect(workflow).toContain('[[ "$DISPATCH_SHA" == "$default_sha" ]]');
    expect(workflow).toContain(
      '[[ "$APPROVED_CANDIDATE_SHA" =~ $sha_pattern && "$APPROVED_CANDIDATE_SHA" == "$CANDIDATE_SHA" ]]',
    );
    expect(workflow).toContain("bash .github/e2e/assert-candidate-binding.sh");
    expect(JSON.stringify(jobs.gate)).not.toContain("secrets.");
    expect(workflow).not.toContain("continue-on-error: ${{");
  });

  it("independently distinguishes first use, successful history, failed history and unknown history", () => {
    const current = { runId: 20, runTitle: "dsh-session-Fixture-Key" };
    const run = {
      id: 10,
      path: ".github/workflows/session-e2e.yml",
      event: "workflow_dispatch",
      display_title: "dsh-session-fixture-key",
      status: "completed",
      conclusion: "success",
    };
    expect(fixture.selectSessionHistory([], current).status).toBe("first");
    expect(fixture.selectSessionHistory([run], current)).toEqual({
      status: "success",
      source: run,
    });
    expect(
      fixture.selectSessionHistory([run, { ...run, id: 11, conclusion: "failure" }], current)
        .status,
    ).toBe("failed");
    expect(
      fixture.selectSessionHistory(
        [run, { ...run, id: 11, status: "in_progress", conclusion: null }],
        current,
      ).status,
    ).toBe("unknown");
    expect(fixture.selectSessionHistory([{ ...run, id: 21 }], current).status).toBe("first");
    expect(
      fixture.selectSessionHistory([{ ...run, display_title: "dsh-session-other" }], current)
        .status,
    ).toBe("first");
  });

  it("requires the auto selection, source run and advancing generation rather than a fresh replacement", () => {
    const expected = identity({
      sessionMode: "auto",
      phase: "resume",
      generation: 3,
      runId: 12,
      sourceRunId: 11,
    });
    const result = successResult({
      taskOutput: { memory, challenge, phase: "resume" },
      policy: { trust: "trusted-read" },
      permissions: { workspaceWrite: false },
      isolation: { backend: "docker", processIsolated: true, workspaceAccess: "read-only" },
      session: {
        mode: "auto",
        selection: "resumed",
        status: "saved",
        generation: 3,
        sourceRunId: 11,
        sessionId: id,
        artifactId: 32,
        payloadSha256: "f".repeat(64),
      },
      write: {},
    });
    expect(Object.values(fixture.resultChecks(result, expected)).every(Boolean)).toBe(true);
    expect(
      fixture.resultChecks(
        { ...result, session: { ...object(result.session), selection: "created" } },
        expected,
      ).automaticSelection,
    ).toBe(false);
    expect(
      fixture.resultChecks(
        { ...result, session: { ...object(result.session), generation: 1 } },
        expected,
      ).checkpoint,
    ).toBe(false);
  });

  it.each(["failed", "unknown", "expired", "missing", "incompatible", "corrupt"])(
    "requires actual fail-closed Action output for the %s boundary",
    (expectedFailure) => {
      const result = {
        conclusion: "failure",
        error: {
          code: "SESSION_CHECKPOINT",
          message:
            expectedFailure === "corrupt"
              ? "Session ZIP file metadata is invalid"
              : `Automatic Session history is ${expectedFailure}`,
        },
        session: { mode: "auto", status: "failed" },
        loop: { turns: 0, toolCalls: 0 },
      };
      const expected = { expectedFailure };
      expect(Object.values(fixture.failureChecks(result, expected, "failure")).every(Boolean)).toBe(
        true,
      );
      expect(fixture.failureChecks(result, expected, "success").actionDenied).toBe(false);
      expect(
        fixture.failureChecks({ ...result, loop: { turns: 1 } }, expected, "failure")
          .noTaskExecution,
      ).toBe(false);
      expect(
        fixture.failureChecks(
          { ...result, error: { code: "SESSION_CHECKPOINT", message: "Unrelated failure" } },
          expected,
          "failure",
        ).exactBoundary,
      ).toBe(false);
    },
  );
});
