import { describe, expect, it, vi } from "vitest";

import type { AgentEngine, AgentTurnRequest, ToolProvider } from "../src/agent/contracts.js";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  AgentDeadlineError,
  AgentLoopLimitError,
  AgentNoProgressError,
  runAgentLoop,
} from "../src/agent/loop.js";
import { buildDshPrompt, WINDOWS_MAX_PROMPT_BYTES } from "../src/dsh/prompt.js";
import {
  DshCredentialLeakError,
  DshAbortedError,
  DshMalformedOutputError,
  DshProcessError,
} from "../src/dsh/errors.js";
import type { DshOutput } from "../src/dsh/schema.js";
import { parseTaskOutputSchema } from "../src/dsh/task-output.js";
import type { DshRuntime } from "../src/dsh/runner.js";
import type { DshTurnMetadata, AgentTask } from "../src/review/run.js";
import { DshAgentEngine } from "../src/review/run.js";
import { createDshFixtureManager } from "./helpers/dsh-runner-fixtures.js";
import { ValidationIntegrityError } from "../src/write/validation-integrity.js";
import { ValidationFailureError } from "../src/write/validate.js";
import { inputs } from "./helpers.js";

const lifecycleFixtures = createDshFixtureManager();
afterEach(lifecycleFixtures.dispose);

const isolation: DshTurnMetadata["isolationReport"] = {
  backend: "docker",
  credentialMediated: true,
  repoToolsEnabled: true,
  processIsolated: true,
  networkIsolated: false,
  workspaceAccess: "read-write",
  extensionProfile: "github-action",
  limitations: [],
};

const runtime: DshRuntime = {
  root: "runtime",
  dshHome: "home",
  packageRoot: "package",
  npmCache: "npm-cache",
};

function output(state: DshOutput["state"], extra: Partial<DshOutput> = {}): DshOutput {
  return {
    protocolVersion: 1,
    operation: "task",
    state,
    summary: state === "blocked" ? "Cannot continue safely" : "Task result",
    findings: [],
    ...extra,
  };
}

function task(contextPacket: unknown = { identity: "TASK-ID" }): AgentTask {
  return {
    operation: "task",
    requestedAccess: "write",
    policy: {
      trust: "trusted-write",
      allowed: true,
      reason: "test",
      capabilities: {
        readRepository: true,
        readCi: false,
        publishComments: true,
        executeRepositoryCode: true,
        loadExtensions: true,
        accessNetwork: true,
        modifyWorkspace: true,
        commit: true,
        push: true,
        createPullRequest: true,
        manageIssueLabels: true,
        manageIssueAssignees: true,
        updateIssueState: true,
        updatePullRequestMetadata: true,
      },
    },
    contextPacket,
    instructions: "repair the task",
    workspacePath: "workspace",
    tools: {
      native: ["workspace.read", "workspace.edit"],
      workspace: ["workspace.read", "workspace.edit"],
      manifests: [
        {
          id: "command.test",
          description: "Run tests",
          provider: "command",
          permissions: ["execute"],
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
      commands: [],
      github: [],
      permission: {
        profile: "strict",
        requestedTools: ["workspace.read", "workspace.edit"],
        disallowedTools: [],
        deniedTools: [],
      },
      permissionDenials: [],
    },
  };
}

function engine(
  responses: readonly DshOutput[],
  requests: AgentTurnRequest[],
): AgentEngine<DshOutput, DshTurnMetadata> {
  let index = 0;
  return {
    id: "fake",
    version: "1",
    runTurn: (request) => {
      requests.push(request);
      const next = responses[index];
      index += 1;
      if (next === undefined) throw new Error("Unexpected turn");
      return Promise.resolve({
        output: next,
        durationMs: 10,
        metadata: { isolationReport: isolation },
      });
    },
  };
}

function repairTurnFailureEngine(
  error: Error,
  requests: AgentTurnRequest[],
): AgentEngine<DshOutput, DshTurnMetadata> {
  let turn = 0;
  return {
    id: "fake-repair-failure",
    version: "1",
    runTurn: (request) => {
      requests.push(request);
      turn += 1;
      if (turn > 1) return Promise.reject(error);
      return Promise.resolve({
        output: output("final"),
        durationMs: 10,
        metadata: { isolationReport: isolation },
      });
    },
  };
}

describe("Controller Session lifecycle hooks", () => {
  it("keeps usage partial when an unreported turn precedes a measured turn", async () => {
    let turn = 0;
    const result = await runAgentLoop(
      task(),
      inputs({ maxTurns: 2 }),
      {
        deadlineMs: Date.now() + 60_000,
        toolProvider: {
          id: "fixture",
          manifest: () => [],
          invoke: (call) => Promise.resolve({ ...call, ok: true, output: {} }),
        },
        blocked: () => Promise.resolve("blocked"),
        finalize: () => Promise.resolve("done"),
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => ({
          id: "unknown-then-measured",
          version: "1",
          runTurn: () => {
            turn += 1;
            return Promise.resolve({
              durationMs: 10,
              output:
                turn === 1
                  ? output("needs_tool", { toolRequest: { id: "command.test", input: {} } })
                  : output("final"),
              metadata: {
                isolationReport: isolation,
                ...(turn === 1
                  ? {}
                  : {
                      usage: {
                        source: "headless-worker" as const,
                        completeness: "complete" as const,
                        reportedSteps: 1,
                        observedSteps: 1,
                        tokens: { inputTokens: 100, outputTokens: 20 },
                      },
                    }),
              },
            });
          },
        }),
      },
    );
    expect(result.agent.usage).toEqual({
      source: "headless-worker",
      completeness: "partial",
      reportedSteps: 1,
      observedSteps: 1,
      tokens: { inputTokens: 100, outputTokens: 20 },
    });
  });
  it("sums worker-reported usage across turns without inventing missing cache buckets", async () => {
    let turn = 0;
    const result = await runAgentLoop(
      task(),
      inputs({ maxTurns: 2 }),
      {
        deadlineMs: Date.now() + 60_000,
        toolProvider: {
          id: "fixture",
          manifest: () => [],
          invoke: (call) => Promise.resolve({ ...call, ok: true, output: {} }),
        },
        blocked: () => Promise.resolve("blocked"),
        finalize: () => Promise.resolve("done"),
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => ({
          id: "fixture",
          version: "1",
          runTurn: () => {
            turn += 1;
            return Promise.resolve({
              durationMs: 10,
              output:
                turn === 1
                  ? output("needs_tool", { toolRequest: { id: "command.test", input: {} } })
                  : output("final"),
              metadata: {
                isolationReport: isolation,
                usage: {
                  source: "headless-worker" as const,
                  completeness: "complete" as const,
                  reportedSteps: 1,
                  observedSteps: 1,
                  tokens:
                    turn === 1
                      ? { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300 }
                      : { inputTokens: 50, outputTokens: 5 },
                },
              },
            });
          },
        }),
      },
    );
    expect(result.agent.usage).toEqual({
      source: "headless-worker",
      completeness: "complete",
      reportedSteps: 2,
      observedSteps: 2,
      tokens: { inputTokens: 150, outputTokens: 25 },
    });
  });
  it("allows cold setup before the worker cap while enforcing the immutable run deadline", async () => {
    vi.useFakeTimers();
    try {
      const requests: AgentTurnRequest[] = [];
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 20 * 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => ({
            id: "cold-start",
            version: "1",
            runTurn: async (request) => {
              requests.push(request);
              await new Promise<void>((resolve) => setTimeout(resolve, 4 * 60_000));
              await new Promise<void>((resolve) => setTimeout(resolve, 9 * 60_000));
              return {
                output: output("final"),
                durationMs: 13 * 60_000,
                metadata: { isolationReport: isolation },
              };
            },
          }),
        },
      );
      const outcome = running.then(
        (result) => result,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(13 * 60_000);
      expect(await outcome).toMatchObject({ finalization: "done" });
      expect(requests[0]?.timeoutMs).toBe(10 * 60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a hanging engine turn at the overall deadline and disposes engine and runtime", async () => {
    vi.useFakeTimers();
    try {
      let turnSignal: AbortSignal | undefined;
      const dispose = vi.fn(() => Promise.resolve());
      const disposeRuntime = vi.fn(() => Promise.resolve());
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: 20 * 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          now: () => 0,
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime,
          createEngine: () => ({
            id: "stalled",
            version: "1",
            dispose,
            runTurn: (request) => {
              turnSignal = request.signal;
              return new Promise(() => undefined);
            },
          }),
        },
      );
      const outcome = expect(running).rejects.toBeInstanceOf(AgentDeadlineError);
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      await outcome;
      expect(turnSignal?.aborted).toBe(true);
      expect(dispose).toHaveBeenCalledOnce();
      expect(disposeRuntime).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds Session restoration and disposes the acquired runtime before any worker starts", async () => {
    vi.useFakeTimers();
    try {
      const disposeRuntime = vi.fn(() => Promise.resolve());
      const createEngine = vi.fn(() => engine([output("final")], []));
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: 20 * 60_000,
          onRuntimeReady: () => new Promise<void>(() => undefined),
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          now: () => 0,
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime,
          createEngine,
        },
      );
      const outcome = expect(running).rejects.toThrow(/Session restoration.*timeout/u);
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(createEngine).not.toHaveBeenCalled();
      expect(disposeRuntime).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("restores before creating a worker and saves after finalization before disposal", async () => {
    const order: string[] = [];
    const value = { ...runtime };
    const result = await runAgentLoop(
      task(),
      inputs(),
      {
        deadlineMs: Date.now() + 10_000,
        onRuntimeReady: (created) => {
          expect(created).toBe(value);
          order.push("restore");
          return Promise.resolve();
        },
        blocked: () => Promise.resolve("blocked"),
        finalize: () => {
          order.push("confirmed-write");
          return Promise.resolve("published");
        },
        onRuntimeCompleted: (created, completed) => {
          expect(created).toBe(value);
          expect(completed.finalization).toBe("published");
          order.push("save");
          return Promise.resolve();
        },
      },
      {
        createRuntime: () => Promise.resolve(value),
        createEngine: () => {
          order.push("worker");
          return engine([output("final")], []);
        },
        disposeRuntime: () => {
          order.push("dispose");
          return Promise.resolve();
        },
      },
    );
    expect(result.finalization).toBe("published");
    expect(order).toEqual(["restore", "worker", "confirmed-write", "save", "dispose"]);
  });
  it("refuses to start a worker after a corrupt checkpoint and still disposes the private runtime", async () => {
    const createEngine = vi.fn();
    const dispose = vi.fn(() => Promise.resolve());
    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 10_000,
          onRuntimeReady: () => {
            throw new Error("corrupt checkpoint");
          },
          blocked: () => Promise.resolve(),
          finalize: () => Promise.resolve(),
        },
        {
          createRuntime: () => Promise.resolve({ ...runtime }),
          createEngine,
          disposeRuntime: dispose,
        },
      ),
    ).rejects.toThrow("corrupt checkpoint");
    expect(createEngine).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });
  it("does not publish a checkpoint for a blocked task", async () => {
    const save = vi.fn(() => Promise.resolve());
    await runAgentLoop(
      task(),
      inputs(),
      {
        deadlineMs: Date.now() + 10_000,
        blocked: () => Promise.resolve(),
        finalize: () => Promise.resolve(),
        onRuntimeCompleted: save,
      },
      {
        createRuntime: () => Promise.resolve({ ...runtime }),
        createEngine: () => engine([output("blocked")], []),
        disposeRuntime: () => Promise.resolve(),
      },
    );
    expect(save).not.toHaveBeenCalled();
  });
  it("never reexecutes finalization when checkpoint publication fails after a confirmed write", async () => {
    const finalize = vi.fn(() => Promise.resolve("confirmed-write"));
    const createEngine = vi.fn(() => engine([output("final")], []));
    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 10_000,
          blocked: () => Promise.resolve("blocked"),
          finalize,
          onRuntimeCompleted: () => {
            throw new Error("uncertain artifact upload");
          },
        },
        {
          createRuntime: () => Promise.resolve({ ...runtime }),
          createEngine,
          disposeRuntime: () => Promise.resolve(),
        },
      ),
    ).rejects.toThrow("uncertain artifact upload");
    expect(finalize).toHaveBeenCalledOnce();
    expect(createEngine).toHaveBeenCalledOnce();
  });
});

function validationFailure(stderr: string): ValidationFailureError {
  return new ValidationFailureError({
    argv: ["npm", "test"],
    result: {
      exitCode: 1,
      stdout: "x".repeat(20_000),
      stderr,
      timedOut: false,
      outputTruncated: false,
    },
  });
}

function validationIntegrityFailure(): ValidationIntegrityError {
  return new ValidationIntegrityError({
    schemaVersion: 1,
    mode: "strict",
    status: "blocked",
    changeCount: 1,
    dangerousChangeCount: 1,
    controlPlaneChangeCount: 1,
    testChangeCount: 0,
    changes: [],
    truncated: false,
  });
}

describe("controller-owned agent loop", () => {
  it("revalidates configured taskOutput at the Controller-owned outer loop", async () => {
    const taskOutputSchema = parseTaskOutputSchema(
      JSON.stringify({
        type: "object",
        properties: { status: { type: "string", enum: ["ready"] } },
        required: ["status"],
        additionalProperties: false,
      }),
    );
    const result = await runAgentLoop(
      task(),
      inputs({ taskOutputSchema }),
      {
        deadlineMs: Date.now() + 60_000,
        blocked: () => Promise.resolve("blocked"),
        finalize: (agent) => Promise.resolve(agent.output.taskOutput),
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => engine([output("final", { taskOutput: { status: "ready" } })], []),
      },
    );
    expect(result.finalization).toEqual({ status: "ready" });
    expect(result.agent.output.taskOutput).toEqual({ status: "ready" });

    await expect(
      runAgentLoop(
        task(),
        inputs({ taskOutputSchema }),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => engine([output("final", { taskOutput: { status: "forged" } })], []),
        },
      ),
    ).rejects.toBeInstanceOf(DshMalformedOutputError);
  });

  it("caps an Agent turn independently and forwards the run cancellation signal", async () => {
    const controller = new AbortController();
    const requests: AgentTurnRequest[] = [];
    const result = await runAgentLoop(
      task(),
      inputs(),
      {
        deadlineMs: 2_000_000,
        signal: controller.signal,
        blocked: () => Promise.resolve("blocked"),
        finalize: () => Promise.resolve("done"),
      },
      {
        now: () => 1_000,
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => engine([output("final")], requests),
      },
    );

    expect(result.finalization).toBe("done");
    expect(requests[0]?.deadlineMs).toBe(2_000_000);
    expect(requests[0]?.timeoutMs).toBe(10 * 60_000);
    expect(requests[0]?.signal?.aborted).toBe(false);
    controller.abort();
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  it("stops before invoking the Agent when the run was cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new DshProcessError(null, "SIGTERM", "cancelled"));
    const runTurn = vi.fn();
    const createRuntime = vi.fn(() => Promise.resolve(runtime));

    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          signal: controller.signal,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          createRuntime,
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => ({ id: "cancelled", version: "1", runTurn }),
        },
      ),
    ).rejects.toThrow("cancelled");
    expect(createRuntime).not.toHaveBeenCalled();
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("hard-bounds a hanging turn progress hook by its phase cap", async () => {
    vi.useFakeTimers();
    try {
      const onTurn = vi.fn(() => new Promise<void>(() => undefined));
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: 20 * 60_000,
          onTurn,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          now: () => 0,
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => engine([output("final")], []),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onTurn).toHaveBeenCalledOnce();
      const outcome = expect(running).rejects.toThrow(/turn progress hook exceeded/u);
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-bounds a hanging validation retry progress hook", async () => {
    vi.useFakeTimers();
    try {
      const onValidationRetry = vi.fn(() => new Promise<void>(() => undefined));
      const running = runAgentLoop(
        task(),
        inputs({ maxTurns: 2 }),
        {
          deadlineMs: 20 * 60_000,
          onValidationRetry,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.reject(validationFailure("retry")),
        },
        {
          now: () => 0,
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => engine([output("final")], []),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(onValidationRetry).toHaveBeenCalledOnce();
      const outcome = expect(running).rejects.toThrow(/validation retry progress hook exceeded/u);
      await vi.advanceTimersByTimeAsync(60_000);
      await outcome;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes tool -> validation error -> repair -> pass with newest feedback preserved", async () => {
    const requests: AgentTurnRequest[] = [];
    const disposeRuntime = vi.fn(() => Promise.resolve());
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [],
      invoke: (call) =>
        Promise.resolve({
          callId: call.callId,
          id: call.id,
          ok: false,
          output: {
            exitCode: 1,
            stdout: `tool output ${"o".repeat(20_000)}`,
            stderr: `tool error ${"e".repeat(20_000)} TOOL_TAIL`,
            timedOut: false,
            effect: "scheduled",
            target: "repository:42/issue:7",
            attempts: 0,
            reconciled: false,
          },
        }),
    };
    let finalizations = 0;
    const result = await runAgentLoop(
      task({ identity: "TASK-ID", large: "z".repeat(100_000) }),
      inputs({ maxTurns: 3 }),
      {
        deadlineMs: Date.now() + 60_000,
        toolProvider: provider,
        blocked: () => Promise.resolve("blocked"),
        finalize: () => {
          finalizations += 1;
          if (finalizations === 1) {
            throw validationFailure(`start-${"e".repeat(20_000)}-TAIL_ERROR`);
          }
          return Promise.resolve("done");
        },
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime,
        createEngine: () =>
          engine(
            [
              output("needs_tool", {
                toolRequest: { id: "command.test", input: {} },
              }),
              output("final"),
              output("final", { summary: "Repaired" }),
            ],
            requests,
          ),
        workspaceFingerprint: () => Promise.resolve("revision-1"),
      },
    );
    expect(result.finalization).toBe("done");
    expect(result.stats).toMatchObject({ turns: 3, toolCalls: 1, validationRetries: 1 });
    expect(result.stats.toolReceipts).toHaveLength(1);
    expect(result.stats.toolReceipts[0]?.callId).toMatch(/^call-[a-f0-9]{40}$/u);
    expect(result.stats.toolReceipts[0]).toMatchObject({
      effect: "scheduled",
      target: "repository:42/issue:7",
      attempts: 0,
      reconciled: false,
    });
    const toolFeedbackPrompt = buildDshPrompt({
      operation: "task",
      prompt: JSON.stringify(requests[1]?.context),
      trust: "trusted-write",
      toolCatalog: task().tools.manifests,
      maxBytes: WINDOWS_MAX_PROMPT_BYTES,
    });
    expect(toolFeedbackPrompt).toContain("TOOL_TAIL");
    const repairContext = requests[2]?.context;
    const prompt = buildDshPrompt({
      operation: "task",
      prompt: JSON.stringify(repairContext),
      trust: "trusted-write",
      toolCatalog: task().tools.manifests,
      maxBytes: WINDOWS_MAX_PROMPT_BYTES,
    });
    expect(prompt).toContain("TAIL_ERROR");
    expect(prompt).toContain("TASK-ID");
    expect(prompt).not.toContain("\uFFFD");
    expect(disposeRuntime).toHaveBeenCalledOnce();
  });

  it("keeps MCP receipts across fresh multi-turn DSH workers", async () => {
    let turn = 0;
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [],
      invoke: (call) =>
        Promise.resolve({ callId: call.callId, id: call.id, ok: true, output: { passed: true } }),
    };
    const result = await runAgentLoop(
      task(),
      inputs({ maxTurns: 2 }),
      {
        deadlineMs: Date.now() + 60_000,
        toolProvider: provider,
        blocked: () => Promise.resolve("blocked"),
        finalize: () => Promise.resolve("done"),
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => ({
          id: "fake-mcp",
          version: "1",
          runTurn: () => {
            turn += 1;
            return Promise.resolve({
              output:
                turn === 1
                  ? output("needs_tool", { toolRequest: { id: "command.test", input: {} } })
                  : output("final"),
              durationMs: 10,
              metadata: {
                isolationReport: isolation,
                toolReceipts: [
                  {
                    schemaVersion: 1,
                    callId: `mcp-turn-${String(turn)}`,
                    id: "mcp.fixture.lookup",
                    runtimeName: "mcp__fixture__lookup",
                    provider: "mcp",
                    counted: true,
                    completed: true,
                    ok: true,
                    durationMs: 2,
                  },
                ],
              },
            });
          },
        }),
      },
    );
    expect(result.finalization).toBe("done");
    expect(result.agent.toolReceipts?.map(({ callId }) => callId)).toEqual([
      "mcp-turn-1",
      "mcp-turn-2",
    ]);
  });

  it("unions native observed inventory across fresh multi-turn DSH workers", async () => {
    let turn = 0;
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [],
      invoke: (call) =>
        Promise.resolve({ callId: call.callId, id: call.id, ok: true, output: { passed: true } }),
    };
    const result = await runAgentLoop(
      task(),
      inputs({ dshMode: "native", maxTurns: 2 }),
      {
        deadlineMs: Date.now() + 60_000,
        toolProvider: provider,
        blocked: () => Promise.resolve("blocked"),
        finalize: () => Promise.resolve("done"),
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => ({
          id: "fake-native",
          version: "1",
          runTurn: () => {
            turn += 1;
            return Promise.resolve({
              output:
                turn === 1
                  ? output("needs_tool", { toolRequest: { id: "command.test", input: {} } })
                  : output("final"),
              durationMs: 10,
              metadata: {
                isolationReport: isolation,
                observedTools: turn === 1 ? ["read", "glob"] : ["grep", "read"],
              },
            });
          },
        }),
      },
    );

    expect(result.agent.observedTools).toEqual(["glob", "grep", "read"]);
  });

  it("detects no progress from stable failure identity and workspace despite noisy logs", async () => {
    const requests: AgentTurnRequest[] = [];
    let attempt = 0;
    await expect(
      runAgentLoop(
        task(),
        inputs({ maxTurns: 3 }),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => {
            attempt += 1;
            throw validationFailure(`timestamp=${String(attempt)}-${Math.random().toString()}`);
          },
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => engine([output("final"), output("final")], requests),
          workspaceFingerprint: () => Promise.resolve("same-revision"),
        },
      ),
    ).rejects.toBeInstanceOf(AgentNoProgressError);
    expect(requests).toHaveLength(2);
  });

  it("routes blocked through a non-writing hook and never calls finalization", async () => {
    const requests: AgentTurnRequest[] = [];
    const finalize = vi.fn(() => Promise.resolve("wrote"));
    const blocked = vi.fn(() => Promise.resolve("blocked"));
    const result = await runAgentLoop(
      task(),
      inputs(),
      { deadlineMs: Date.now() + 60_000, blocked, finalize },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.resolve(),
        createEngine: () => engine([output("blocked")], requests),
      },
    );
    expect(result.finalization).toBe("blocked");
    expect(blocked).toHaveBeenCalledOnce();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("does not let a blocked repair turn erase a pending validation-integrity failure", async () => {
    const requests: AgentTurnRequest[] = [];
    const integrity = validationIntegrityFailure();
    const blocked = vi.fn(() => Promise.resolve("blocked"));
    const finalize = vi.fn(() => Promise.reject(integrity));

    await expect(
      runAgentLoop(
        task(),
        inputs({ maxTurns: 2 }),
        { deadlineMs: Date.now() + 60_000, blocked, finalize },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => engine([output("final"), output("blocked")], requests),
          workspaceFingerprint: () => Promise.resolve("weakened-validation-entrypoint"),
        },
      ),
    ).rejects.toBe(integrity);
    expect(requests).toHaveLength(2);
    expect(finalize).toHaveBeenCalledOnce();
    expect(blocked).not.toHaveBeenCalled();
  });

  it("preserves a pending validation-integrity failure when a repair tool request exhausts turns", async () => {
    const requests: AgentTurnRequest[] = [];
    const integrity = validationIntegrityFailure();
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [],
      invoke: (call) =>
        Promise.resolve({
          callId: call.callId,
          id: call.id,
          ok: true,
          output: { repaired: false },
        }),
    };
    const finalize = vi.fn(() => Promise.reject(integrity));

    await expect(
      runAgentLoop(
        task(),
        inputs({ maxTurns: 2 }),
        {
          deadlineMs: Date.now() + 60_000,
          toolProvider: provider,
          blocked: () => Promise.resolve("blocked"),
          finalize,
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () =>
            engine(
              [
                output("final"),
                output("needs_tool", { toolRequest: { id: "command.test", input: {} } }),
              ],
              requests,
            ),
          workspaceFingerprint: () => Promise.resolve("weakened-validation-entrypoint"),
        },
      ),
    ).rejects.toBe(integrity);
    expect(requests).toHaveLength(2);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("does not let malformed repair output erase a pending validation-integrity failure", async () => {
    const requests: AgentTurnRequest[] = [];
    const integrity = validationIntegrityFailure();
    const onEngineFailure = vi.fn();
    const malformed = new DshMalformedOutputError(
      "DSH stdout was not one complete JSON value",
    ).attachTelemetry({
      durationMs: 25,
      isolationReport: isolation,
      toolReceipts: [
        {
          schemaVersion: 1,
          callId: "repair-malformed",
          id: "native.bash",
          runtimeName: "bash",
          provider: "builtin",
          counted: true,
          completed: true,
          ok: true,
          durationMs: 4,
        },
      ],
    });
    const finalize = vi.fn(() => Promise.reject(integrity));

    await expect(
      runAgentLoop(
        task(),
        inputs({ maxTurns: 2 }),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize,
          onEngineFailure,
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => repairTurnFailureEngine(malformed, requests),
          workspaceFingerprint: () => Promise.resolve("weakened-validation-entrypoint"),
        },
      ),
    ).rejects.toBe(integrity);
    expect(requests).toHaveLength(2);
    expect(finalize).toHaveBeenCalledOnce();
    expect(onEngineFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 35,
        toolReceipts: [expect.objectContaining({ callId: "repair-malformed", ok: true })],
      }),
      expect.objectContaining({ turns: 2, validationRetries: 1 }),
    );
  });

  it("does not let a pending validation failure hide a repair-turn credential leak", async () => {
    const requests: AgentTurnRequest[] = [];
    const integrity = validationIntegrityFailure();
    const credentialLeak = new DshCredentialLeakError("stdout").attachTelemetry({
      durationMs: 25,
      isolationReport: isolation,
    });
    const finalize = vi.fn(() => Promise.reject(integrity));

    await expect(
      runAgentLoop(
        task(),
        inputs({ maxTurns: 2 }),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize,
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => repairTurnFailureEngine(credentialLeak, requests),
          workspaceFingerprint: () => Promise.resolve("weakened-validation-entrypoint"),
        },
      ),
    ).rejects.toBe(credentialLeak);
    expect(requests).toHaveLength(2);
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("rechecks the deadline after progress hooks and disposes runtime if engine creation fails", async () => {
    let now = 0;
    const disposeRuntime = vi.fn(() => Promise.resolve());
    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: 10,
          onTurn: () => {
            now = 11;
          },
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          now: () => now,
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime,
          createEngine: () => engine([output("final")], []),
        },
      ),
    ).rejects.toBeInstanceOf(AgentDeadlineError);
    expect(disposeRuntime).toHaveBeenCalledOnce();

    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime,
          createEngine: () => {
            throw new Error("engine failed");
          },
        },
      ),
    ).rejects.toThrow("engine failed");
    expect(disposeRuntime).toHaveBeenCalledTimes(2);
  });

  it("preserves a completed outcome when best-effort cleanup fails", async () => {
    const cleanupErrors: string[] = [];
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [],
      invoke: () => Promise.reject(new Error("not called")),
      dispose: () => Promise.reject(new Error("provider cleanup failed")),
    };
    const result = await runAgentLoop(
      task(),
      inputs(),
      {
        deadlineMs: Date.now() + 60_000,
        toolProvider: provider,
        blocked: () => Promise.resolve("blocked"),
        finalize: () => Promise.resolve("published"),
        onCleanupError: (component, error) => {
          cleanupErrors.push(
            `${component}:${error instanceof Error ? error.message : String(error)}`,
          );
        },
      },
      {
        createRuntime: () => Promise.resolve(runtime),
        disposeRuntime: () => Promise.reject(new Error("runtime cleanup failed")),
        createEngine: () => ({
          ...engine([output("final")], []),
          dispose: () => Promise.reject(new Error("engine cleanup failed")),
        }),
      },
    );
    expect(result.finalization).toBe("published");
    expect(cleanupErrors).toEqual([
      "tool-provider:provider cleanup failed",
      "engine:engine cleanup failed",
      "runtime:runtime cleanup failed",
    ]);
  });

  it("shares one cleanup grace period without skipping later disposers", async () => {
    vi.useFakeTimers();
    try {
      const cleanupErrors: string[] = [];
      const engineDispose = vi.fn(() => Promise.reject(new Error("late engine cleanup failure")));
      const runtimeDispose = vi.fn(() => Promise.reject(new Error("late runtime cleanup failure")));
      const provider: ToolProvider = {
        id: "command",
        manifest: () => [],
        invoke: () => Promise.reject(new Error("not called")),
        dispose: () => new Promise<void>(() => undefined),
      };
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          toolProvider: provider,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("published"),
          onCleanupError: (component) => {
            cleanupErrors.push(component);
          },
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: runtimeDispose,
          createEngine: () => ({
            ...engine([output("final")], []),
            dispose: engineDispose,
          }),
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(running).resolves.toMatchObject({ finalization: "published" });
      expect(cleanupErrors).toEqual(["tool-provider", "engine", "runtime"]);
      expect(engineDispose).toHaveBeenCalledOnce();
      expect(runtimeDispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers runtime disposal until the engine actually settles when provider cleanup consumed the grace", async () => {
    vi.useFakeTimers();
    try {
      let finishEngineDisposal: (() => void) | undefined;
      const quiescence = new Promise<void>((resolve) => {
        finishEngineDisposal = resolve;
      });
      const engineDispose = vi.fn(() => quiescence);
      const runtimeDispose = vi.fn(() => Promise.resolve());
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          toolProvider: {
            id: "fixture",
            manifest: () => [],
            invoke: () => Promise.reject(new Error("unused")),
            dispose: () => new Promise<void>(() => undefined),
          },
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("published"),
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: runtimeDispose,
          createEngine: () => ({ ...engine([output("final")], []), dispose: engineDispose }),
        },
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(running).resolves.toMatchObject({ finalization: "published" });
      expect(engineDispose).toHaveBeenCalledOnce();
      expect(runtimeDispose).not.toHaveBeenCalled();
      finishEngineDisposal?.();
      await vi.advanceTimersByTimeAsync(0);
      expect(runtimeDispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a hung cleanup reporter without postponing later disposers or replacing success", async () => {
    vi.useFakeTimers();
    try {
      const completed = vi.fn();
      const engineDispose = vi.fn(() => Promise.resolve());
      const runtimeDispose = vi.fn(() => Promise.resolve());
      const report = vi.fn(() => new Promise<void>(() => undefined));
      const running = runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          toolProvider: {
            id: "fixture",
            manifest: () => [],
            invoke: () => Promise.reject(new Error("unused")),
            dispose: () => Promise.reject(new Error("provider shutdown failed")),
          },
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("published"),
          onCleanupError: report,
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: runtimeDispose,
          createEngine: () => ({ ...engine([output("final")], []), dispose: engineDispose }),
        },
      ).then((result) => {
        completed();
        return result;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(completed).toHaveBeenCalledOnce();
      await expect(running).resolves.toMatchObject({ finalization: "published" });
      expect(report).toHaveBeenCalled();
      expect(engineDispose).toHaveBeenCalledOnce();
      expect(runtimeDispose).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("DSH engine disposal cancels and waits for a real active worker before returning", async () => {
    const fixture = await lifecycleFixtures.fixtures();
    const executable = join(fixture.root, "active-worker.mjs");
    const readyPath = join(fixture.workspace, "worker-ready");
    await writeFile(
      executable,
      'import { writeFileSync } from "node:fs"; process.on("SIGTERM", () => setTimeout(() => process.exit(0), 25)); writeFileSync("worker-ready", String(process.pid)); function alive(){ setTimeout(alive, 1000); } alive();',
    );
    const policy = { ...task().policy, trust: "trusted-read" as const };
    const realEngine: AgentEngine<DshOutput, DshTurnMetadata> = new DshAgentEngine(
      inputs({
        isolation: "none",
        dshExecutable: executable,
        deepseekApiKey: "controller-deepseek-test-key",
        githubToken: "controller-github-test-key",
      }),
      policy,
    );
    const controller = new AbortController();
    let workerPid: number | undefined;
    const turnRequest: AgentTurnRequest = {
      schemaVersion: 1,
      operation: "task",
      requestedAccess: "read",
      instructions: "test",
      context: {},
      tools: [],
      workspacePath: fixture.workspace,
      deadlineMs: Date.now() + 60_000,
      timeoutMs: 60_000,
      signal: controller.signal,
    };
    const execution = realEngine.runTurn(turnRequest).then(
      (value) => value,
      (error: unknown) => error,
    );
    try {
      await expect
        .poll(
          async () => {
            const pid = Number(await readFile(readyPath, "utf8").catch(() => "pending"));
            if (!Number.isSafeInteger(pid) || pid <= 0) return false;
            workerPid = pid;
            return true;
          },
          { timeout: 10_000 },
        )
        .toBe(true);
      await expect(realEngine.runTurn(turnRequest)).rejects.toThrow(/overlapping turns/u);
      await Promise.all([realEngine.dispose?.(), realEngine.dispose?.()]);
      expect(controller.signal.aborted).toBe(false);
      if (workerPid === undefined) throw new Error("Worker did not publish its PID");
      const stoppedPid = workerPid;
      expect(() => process.kill(stoppedPid, 0)).toThrow();
      expect(await execution).toBeInstanceOf(DshAbortedError);
      await expect(realEngine.runTurn(turnRequest)).rejects.toThrow(/disposed DSH engine/u);
    } finally {
      controller.abort();
      await execution;
    }
  });

  it("reports an auditable failed receipt before propagating a provider error", async () => {
    const states: { toolCalls: number; receipts: number; error: boolean | undefined }[] = [];
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [],
      invoke: () => Promise.reject(new Error("tool transport failed")),
    };
    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          toolProvider: provider,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
          onState: (_agent, stats) => {
            states.push({
              toolCalls: stats.toolCalls,
              receipts: stats.toolReceipts.length,
              error: stats.toolReceipts.at(-1)?.error,
            });
          },
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () =>
            engine([output("needs_tool", { toolRequest: { id: "command.test", input: {} } })], []),
        },
      ),
    ).rejects.toThrow("tool transport failed");
    expect(states.at(-1)).toEqual({ toolCalls: 1, receipts: 1, error: true });
  });

  it("publishes DSH failure telemetry with incomplete runtime receipts", async () => {
    const onEngineFailure = vi.fn();
    const error = new DshProcessError(9, null, "crashed").attachTelemetry({
      durationMs: 25,
      isolationReport: isolation,
      observedTools: ["read", "glob"],
      toolReceipts: [
        {
          schemaVersion: 1,
          callId: "mcp-crash",
          id: "mcp.fixture.lookup",
          runtimeName: "mcp__fixture__lookup",
          provider: "mcp",
          counted: true,
          completed: false,
          ok: false,
          durationMs: 0,
          code: "ACTION_TOOL_INCOMPLETE",
        },
      ],
    });
    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
          onEngineFailure,
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () => ({
            id: "failing-dsh",
            version: "1",
            runTurn: () => Promise.reject(error),
          }),
        },
      ),
    ).rejects.toBe(error);
    expect(onEngineFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        durationMs: 25,
        observedTools: ["glob", "read"],
        toolReceipts: [expect.objectContaining({ callId: "mcp-crash", completed: false })],
      }),
      expect.objectContaining({ turns: 1 }),
    );
  });

  it("fails closed when the model requests a tool without an authorized provider", async () => {
    await expect(
      runAgentLoop(
        task(),
        inputs(),
        {
          deadlineMs: Date.now() + 60_000,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () =>
            engine([output("needs_tool", { toolRequest: { id: "command.test", input: {} } })], []),
        },
      ),
    ).rejects.toThrow("requested unavailable tool");
  });

  it("bounds generic tool payloads and stops at the configured turn limit", async () => {
    const provider: ToolProvider = {
      id: "future-provider",
      manifest: () => [],
      invoke: (call) =>
        Promise.resolve({
          callId: call.callId,
          id: call.id,
          ok: true,
          output: { opaquePayload: "x".repeat(20_000) },
        }),
    };
    await expect(
      runAgentLoop(
        task(),
        inputs({ maxTurns: 1 }),
        {
          deadlineMs: Date.now() + 60_000,
          toolProvider: provider,
          blocked: () => Promise.resolve("blocked"),
          finalize: () => Promise.resolve("done"),
        },
        {
          createRuntime: () => Promise.resolve(runtime),
          disposeRuntime: () => Promise.resolve(),
          createEngine: () =>
            engine([output("needs_tool", { toolRequest: { id: "command.test", input: {} } })], []),
        },
      ),
    ).rejects.toBeInstanceOf(AgentLoopLimitError);
  });
});
