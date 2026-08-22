import { describe, expect, it, vi } from "vitest";

import type { AgentEngine, AgentTurnRequest, ToolProvider } from "../src/agent/contracts.js";
import {
  AgentDeadlineError,
  AgentLoopLimitError,
  AgentNoProgressError,
  runAgentLoop,
} from "../src/agent/loop.js";
import { buildDshPrompt, WINDOWS_MAX_PROMPT_BYTES } from "../src/dsh/prompt.js";
import { DshProcessError } from "../src/dsh/errors.js";
import type { DshOutput } from "../src/dsh/schema.js";
import type { DshRuntime } from "../src/dsh/runner.js";
import type { DshTurnMetadata, AgentTask } from "../src/review/run.js";
import { ValidationFailureError } from "../src/write/validate.js";
import { inputs } from "./helpers.js";

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

describe("controller-owned agent loop", () => {
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
    expect(requests[0]?.signal).toBe(controller.signal);
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
