import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, afterEach, expect, it } from "vitest";
import { DshAbortedError } from "../src/dsh/errors.js";
import { runDsh, type DshRunDependencies } from "../src/dsh/runner.js";
import {
  PINNED_NODE_IMAGE,
  CONTAINER_LAUNCHER,
  fakeProxy,
  networkInspectResult,
  actionStateDirectory,
  request,
  createDshFixtureManager,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

async function runWithHeadlessOutput(
  stdout: string,
  exitCode = 0,
  resultRepairFetch?: DshRunDependencies["resultRepairFetch"],
) {
  const fixture = await fixtures();
  return await runDsh(
    request({
      workspacePath: fixture.workspace,
      isolation: "docker",
      containerImage: PINNED_NODE_IMAGE,
    }),
    {
      assetsDirectory: fixture.assets,
      temporaryDirectory: fixture.root,
      startProxy: () => Promise.resolve(fakeProxy()),
      ...(resultRepairFetch === undefined ? {} : { resultRepairFetch }),
      executeProcess: (spec) =>
        Promise.resolve(
          networkInspectResult(spec) ?? {
            stdout: spec.args.includes(CONTAINER_LAUNCHER) ? stdout : "",
            stderr: "",
            exitCode: spec.args.includes(CONTAINER_LAUNCHER) ? exitCode : 0,
            signal: null,
          },
        ),
    },
  );
}

const usageSession = { type: "session", sessionId: "usage-fixture", cwd: "/workspace" };
const reportedStep = {
  type: "status",
  phase: "step_end",
  turn: 0,
  step: 0,
  usage: {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
    totalTokens: 420,
    reasoningTokens: 5,
  },
};
const usageFinal = {
  type: "final",
  text: JSON.stringify({
    protocolVersion: 1,
    operation: "review",
    state: "final",
    summary: "Done",
    findings: [],
  }),
};
const usageStream = (...events: unknown[]) =>
  events.map((event) => JSON.stringify(event)).join("\n") + "\n";

describe("runDsh evidence", () => {
  it("preserves disjoint official token buckets through the public worker result", async () => {
    const result = await runWithHeadlessOutput(usageStream(usageSession, reportedStep, usageFinal));
    expect(result.usage).toEqual({
      source: "headless-worker",
      completeness: "complete",
      reportedSteps: 1,
      observedSteps: 1,
      tokens: reportedStep.usage,
    });
    expect(result.output.summary).toBe("Done");
  });

  it.each([
    { failure: "nonzero exit", exitCode: 9, tail: [] as unknown[], code: "DSH_PROCESS_FAILED" },
    { failure: "missing final", exitCode: 0, tail: [] as unknown[], code: "DSH_MALFORMED_OUTPUT" },
    {
      failure: "invalid event",
      exitCode: 0,
      tail: [{ type: "unknown" }],
      code: "DSH_MALFORMED_OUTPUT",
    },
  ])(
    "retains known steps as partial telemetry after $failure",
    async ({ exitCode, tail, code }) => {
      await expect(
        runWithHeadlessOutput(usageStream(usageSession, reportedStep, ...tail), exitCode),
      ).rejects.toMatchObject({
        code,
        telemetry: {
          usage: {
            source: "headless-worker",
            completeness: "partial",
            reportedSteps: 1,
            observedSteps: 1,
            tokens: reportedStep.usage,
          },
        },
      });
    },
  );

  it.each([false, true])(
    "checks raw/decoded credential leaks before failed-stream usage: escaped=%s",
    async (escaped) => {
      const secret = "controller-real-key";
      const stream = usageStream(usageSession, reportedStep, { type: "unknown", secret });
      const leaked = escaped ? stream.replace(secret, "\\u0063ontroller-real-key") : stream;
      await expect(runWithHeadlessOutput(leaked, 9)).rejects.toMatchObject({
        code: "DSH_CREDENTIAL_LEAK",
      });
    },
  );
  it("labels worker usage partial when a separate formatting call repairs the business result", async () => {
    const terminal = {
      type: "final",
      text: JSON.stringify({
        protocolVersion: 1,
        operation: "review",
        state: "final",
        summary: "Done",
        findings: [],
        extra: true,
      }),
    };
    const result = await runWithHeadlessOutput(
      usageStream(usageSession, reportedStep, terminal),
      0,
      () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              choices: [
                { finish_reason: "stop", message: { role: "assistant", content: usageFinal.text } },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
            }),
            { status: 200 },
          ),
        ),
    );
    expect(result.output.summary).toBe("Done");
    expect(result.usage).toEqual({
      source: "headless-worker",
      completeness: "partial",
      reportedSteps: 1,
      observedSteps: 1,
      tokens: reportedStep.usage,
    });
  });

  it.each(["controller-real-key", "ephemeral-worker-token"])(
    "rejects a DSH tool receipt containing a controller credential: %s",
    async (leakedSecret) => {
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
              if (spec.args[1] === "inspect") {
                return {
                  stdout: "172.30.0.1\n",
                  stderr: "",
                  exitCode: 0,
                  signal: null,
                };
              }
              if (spec.args.includes(CONTAINER_LAUNCHER)) {
                const suffix = ":/dsh-home/action-state:rw";
                const stateMount = spec.args.find((argument) => argument.endsWith(suffix));
                if (stateMount === undefined) throw new Error("missing action-state mount");
                const stateDirectory = stateMount.slice(0, -suffix.length);
                await writeFile(
                  join(stateDirectory, "tool-receipts.jsonl"),
                  `${JSON.stringify({
                    schemaVersion: 1,
                    phase: "completed",
                    callId: "receipt-leak",
                    id: "workspace.read",
                    runtimeName: "read",
                    provider: "builtin",
                    counted: false,
                    ok: false,
                    durationMs: 1,
                    code: leakedSecret,
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
              }
              return { stdout: "", stderr: "", exitCode: 0, signal: null };
            },
          },
        ),
      ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
    },
  );

  it.each(["abort", "credential-leak"] as const)(
    "preserves a primary %s failure when the receipt log is also malformed",
    async (mode) => {
      const fixture = await fixtures();
      const proxy = fakeProxy();
      const controllerCredential = "ghs_controller-primary-secret";
      const primary = new DshAbortedError();
      let failure: unknown;

      try {
        await runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation: "docker",
            containerImage: PINNED_NODE_IMAGE,
            controllerCredentials: [controllerCredential],
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
              await writeFile(
                join(actionStateDirectory(spec), "tool-receipts.jsonl"),
                "not-json\n",
              );
              if (mode === "abort") throw primary;
              return {
                stdout: JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: controllerCredential,
                  findings: [],
                }),
                stderr: "",
                exitCode: 0,
                signal: null,
              };
            },
          },
        );
      } catch (error: unknown) {
        failure = error;
      }

      if (mode === "abort") expect(failure).toBe(primary);
      else expect(failure).toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
      expect(String(failure)).not.toContain(controllerCredential);
    },
  );

  it("fails closed on a malformed receipt after an otherwise successful worker", async () => {
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
            await writeFile(join(actionStateDirectory(spec), "tool-receipts.jsonl"), "not-json\n");
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
    ).rejects.toThrow(/malformed tool receipt/u);
  });

  it("aggregates raw admission and completion events into one public receipt", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const result = await runDsh(
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
            [
              {
                schemaVersion: 1,
                phase: "started",
                callId: "completed-call",
                id: "workspace.read",
                runtimeName: "read",
                provider: "builtin",
                counted: true,
                ok: false,
                durationMs: 0,
                code: "ACTION_TOOL_INCOMPLETE",
              },
              {
                schemaVersion: 1,
                phase: "completed",
                callId: "completed-call",
                id: "workspace.read",
                runtimeName: "read",
                provider: "builtin",
                counted: true,
                ok: true,
                durationMs: 7,
              },
            ]
              .map((receipt) => JSON.stringify(receipt))
              .join("\n") + "\n",
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
    );

    expect(result.toolReceipts).toEqual([
      {
        schemaVersion: 1,
        callId: "completed-call",
        id: "workspace.read",
        runtimeName: "read",
        provider: "builtin",
        counted: true,
        completed: true,
        ok: true,
        durationMs: 7,
      },
    ]);
  });

  it("retains an incomplete counted receipt when the worker crashes after admission", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let failure: unknown;
    try {
      await runDsh(
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
                callId: "crashed-call",
                id: "workspace.read",
                runtimeName: "read",
                provider: "builtin",
                counted: true,
                ok: false,
                durationMs: 0,
                code: "ACTION_TOOL_INCOMPLETE",
              })}\n`,
            );
            return { stdout: "", stderr: "worker crashed", exitCode: 9, signal: null };
          },
        },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({
      code: "DSH_PROCESS_FAILED",
      telemetry: {
        extensionAudit: { profile: "github-action" },
        toolReceipts: [
          {
            callId: "crashed-call",
            counted: true,
            completed: false,
            ok: false,
            code: "ACTION_TOOL_INCOMPLETE",
          },
        ],
      },
    });
  });

  it("fails closed when invocation counters have no matching durable receipt", async () => {
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
            await writeFile(
              join(actionStateDirectory(spec), "tool-counts.json"),
              `${JSON.stringify({
                schemaVersion: 1,
                tools: { "workspace.read": 1 },
                groups: { "builtin.workspace": 1 },
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
    ).rejects.toThrow(/do not reconcile/u);
  });
});
