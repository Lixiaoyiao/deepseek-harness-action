import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import { DshAbortedError, DshOutputLimitError } from "../src/dsh/errors.js";
import { startDeepSeekProxy } from "../src/dsh/proxy.js";
import { NativeComposition } from "../src/dsh/native-composition.js";
import { runDsh } from "../src/dsh/runner.js";
import { parseTaskOutputSchema } from "../src/dsh/task-output.js";
import type { DshProcessSpec } from "../src/dsh/runner.js";
import {
  PINNED_NODE_IMAGE,
  CONTAINER_LAUNCHER,
  CONTAINER_NATIVE_LAUNCHER,
  fakeProxy,
  networkInspectResult,
  actionStateDirectory,
  request,
  createDshFixtureManager,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

describe("runDsh output", () => {
  it("passes the trusted task schema to the prompt and returns only Controller-validated taskOutput", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const taskOutputSchema = parseTaskOutputSchema(
      JSON.stringify({
        type: "object",
        properties: { status: { type: "string", enum: ["ready"] } },
        required: ["status"],
        additionalProperties: false,
      }),
    );
    if (taskOutputSchema === undefined) throw new Error("expected task output schema");
    const result = await runDsh(
      request({
        operation: "task",
        workspacePath: fixture.workspace,
        dshExecutable: fixture.executable,
        taskOutputSchema,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          captured = spec;
          return Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "task",
              state: "final",
              summary: "Complete",
              findings: [],
              taskOutput: { status: "ready" },
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(result.output.taskOutput).toEqual({ status: "ready" });
    expect(captured?.args.join("\n")).toContain("TRUSTED_TASK_OUTPUT_SCHEMA_JSON");
  });

  it.each([
    { mode: "controlled", representation: "prose", state: "final" },
    { mode: "native", representation: "prose", state: "final" },
    { mode: "controlled", representation: "leftover-request", state: "final" },
    { mode: "native", representation: "leftover-request", state: "final" },
    { mode: "controlled", representation: "leftover-request", state: "blocked" },
    { mode: "native", representation: "leftover-request", state: "blocked" },
    { mode: "controlled", representation: "ndjson-prose", state: "final" },
    { mode: "native", representation: "ndjson-prose", state: "final" },
    { mode: "controlled", representation: "ndjson-leftover", state: "final" },
  ] as const)(
    "repairs $mode $state $representation over the real Controller proxy without repeating worker effects",
    async ({ mode, representation, state }) => {
      const fixture = await fixtures();
      const output = {
        protocolVersion: 1,
        operation: "task",
        state,
        summary: "README inspected.",
        findings: [],
      };
      const raw = representation.endsWith("prose")
        ? "README inspected."
        : JSON.stringify({
            ...output,
            toolRequest: {
              id: "command.prepare-validation",
              input: {},
              reason: "RESIDUAL_REQUEST_DO_NOT_EXECUTE",
            },
          });
      const workerStdout = representation.startsWith("ndjson")
        ? [
            { type: "session", sessionId: "session-test", cwd: "/workspace" },
            { type: "tool_call", callId: "already-done", tool: "never-replay", input: {} },
            { type: "final", text: raw },
          ]
            .map((event) => JSON.stringify(event))
            .join("\n") + "\n"
        : raw;
      const upstream = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: { role: "assistant", content: JSON.stringify(output) },
            },
          ],
        }),
      );
      const warning = vi.fn();
      let workerExecutions = 0;
      let workerSpec: DshProcessSpec | undefined;
      const result = await runDsh(
        request({
          operation: "task",
          prompt: "private-original-task-context",
          trustedInstructions: "private-original-operator-instruction",
          workspacePath: fixture.workspace,
          ...(mode === "native" ? { isolation: "docker" } : { dshExecutable: fixture.executable }),
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          environment: { PATH: process.env.PATH, GITHUB_TOKEN: "controller-github-token" },
          warning,
          ...(mode === "native" ? { composition: new NativeComposition() } : {}),
          startProxy: (options) =>
            startDeepSeekProxy({
              ...options,
              bindHost: "127.0.0.1",
              workerHost: "127.0.0.1",
              fetchImplementation: upstream,
            }),
          executeProcess: async (spec) => {
            const inspected = networkInspectResult(spec);
            if (inspected !== undefined) return inspected;
            const worker = mode === "controlled" || spec.args.includes(CONTAINER_NATIVE_LAUNCHER);
            if (worker) {
              workerExecutions += 1;
              workerSpec = spec;
              // A single existing side effect is enough to make an execution retry unsafe.
              await writeFile(join(fixture.workspace, "execution-count"), String(workerExecutions));
              if (mode === "native")
                await writeFile(
                  join(actionStateDirectory(spec), "native-observed-tools.jsonl"),
                  JSON.stringify({
                    schemaVersion: 1,
                    source: "ctx.tools.schemas(agent)",
                    observedTools: ["read"],
                  }) + "\n",
                  { flag: "a" },
                );
            }
            return {
              stdout: worker ? workerStdout : "",
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        },
      );
      expect(result.output).toEqual(output);
      expect(result.rawStdout).toBe(workerStdout);
      expect(result.output).not.toHaveProperty("toolRequest");
      expect(workerExecutions).toBe(1);
      expect(await readFile(join(fixture.workspace, "execution-count"), "utf8")).toBe("1");
      if (mode === "native") expect(result.observedTools).toEqual(["read"]);
      expect(upstream).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("one tool-free formatting repair"),
      );
      const upstreamRequest = upstream.mock.calls[0]?.[1];
      expect(upstreamRequest?.headers).toMatchObject({
        authorization: "Bearer controller-real-key",
      });
      for (const excluded of [
        "private-original-task-context",
        "private-original-operator-instruction",
        "controller-real-key",
        "controller-github-token",
        "never-replay",
      ]) {
        expect(upstreamRequest?.body).not.toContain(excluded);
      }
      expect(JSON.stringify(workerSpec)).not.toContain("controller-real-key");
      expect(JSON.stringify(workerSpec)).not.toContain("controller-github-token");
    },
  );

  it.each([
    "process",
    "credential",
    "escaped-credential",
    "limit",
    "cancel",
    "empty",
    "stream-error",
    "stream-incomplete",
    "stream-exit",
  ] as const)("does not format or rerun a worker after %s failure", async (kind) => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const resultRepairFetch = vi.fn<typeof fetch>();
    const executeProcess = vi.fn(() => {
      if (kind === "limit") throw new DshOutputLimitError("stdout", 100);
      if (kind === "cancel") throw new DshAbortedError();
      const escaped = JSON.stringify({
        protocolVersion: 1,
        operation: "review",
        state: "final",
        summary: "controller-real-key",
        findings: [],
      }).replace("controller", "\\u0063ontroller");
      return Promise.resolve({
        stdout:
          kind === "credential"
            ? "controller-real-key"
            : kind === "escaped-credential"
              ? escaped
              : kind === "empty"
                ? "  \n"
                : kind.startsWith("stream-")
                  ? [
                      { type: "session", sessionId: "session-test", cwd: "/workspace" },
                      ...(kind === "stream-error" ? [{ type: "error", message: "failure" }] : []),
                      ...(kind === "stream-incomplete"
                        ? []
                        : [{ type: "final", text: "malformed result" }]),
                    ]
                      .map((event) => JSON.stringify(event))
                      .join("\n") + "\n"
                  : "invalid result",
        stderr: "",
        exitCode: kind === "process" || kind === "stream-exit" ? 1 : 0,
        signal: null,
      });
    });
    await expect(
      runDsh(request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }), {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess,
        resultRepairFetch,
      }),
    ).rejects.toMatchObject({
      code:
        kind === "process" || kind === "stream-exit"
          ? "DSH_PROCESS_FAILED"
          : kind === "limit"
            ? "DSH_OUTPUT_LIMIT"
            : kind === "cancel"
              ? "DSH_ABORTED"
              : kind === "empty" || kind.startsWith("stream-")
                ? "DSH_MALFORMED_OUTPUT"
                : "DSH_CREDENTIAL_LEAK",
    });
    expect(executeProcess).toHaveBeenCalledOnce();
    expect(resultRepairFetch).not.toHaveBeenCalled();
    expect(proxy.closeMock).toHaveBeenCalledOnce();
  });

  it("applies the Windows argv budget after JSON escaping and final prompt assembly", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const context = JSON.stringify({
      changedFiles: Array.from({ length: 2_000 }, (_, index) => ({
        path: `C:\\repository\\路径\\${String(index)}\\"quoted"-🔐.ts`,
        patch: "+".repeat(40),
      })),
    });
    await runDsh(
      request({
        workspacePath: fixture.workspace,
        dshExecutable: fixture.executable,
        prompt: context,
        trustedInstructions: '<>&\\"'.repeat(5_000),
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        platform: "win32",
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          captured = spec;
          return Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "review",
              state: "final",
              summary: "Done.",
              findings: [],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    const promptArg = captured?.args.at(-1);
    expect(promptArg).toBeDefined();
    expect(Buffer.byteLength(promptArg ?? "", "utf8")).toBeLessThanOrEqual(24 * 1024);
    expect(promptArg).toContain("truncated=true");
    expect(promptArg).not.toContain("\ufffd");
  });

  it("fails closed when a successful worker leaves a counted call unfinished", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    await expect(
      runDsh(
        request({
          workspacePath: fixture.workspace,
          isolation: "docker",
          containerImage: PINNED_NODE_IMAGE,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy: () => Promise.resolve(proxy),
          executeProcess: async (spec) => {
            const inspected = networkInspectResult(spec);
            if (inspected !== undefined) return inspected;
            if (!spec.args.includes(CONTAINER_LAUNCHER)) {
              return { stdout: "", stderr: "", exitCode: 0, signal: null };
            }
            const stateDirectory = actionStateDirectory(spec);
            await writeFile(
              join(stateDirectory, "tool-counts.json"),
              `${JSON.stringify({
                schemaVersion: 1,
                tools: { "workspace.read": 1 },
                groups: { "builtin.workspace": 1 },
              })}\n`,
            );
            await writeFile(
              join(stateDirectory, "tool-receipts.jsonl"),
              `${JSON.stringify({
                schemaVersion: 1,
                phase: "started",
                callId: "unfinished-call",
                id: "workspace.read",
                runtimeName: "read",
                provider: "builtin",
                counted: true,
                ok: false,
                durationMs: 0,
                code: "ACTION_TOOL_INCOMPLETE",
              })}\n`,
            );
            return {
              stdout: JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "Done.",
                findings: [],
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        },
      ),
    ).rejects.toMatchObject({ code: "DSH_CONFIGURATION" });
  });
});
