import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { type Agent } from "@deepseek-ai/dsh-agent";
import { CallId } from "@deepseek-ai/dsh-llm";
import { createScope, type Scope } from "@deepseek-ai/dsh-scope";
import { SessionId } from "@deepseek-ai/dsh-session";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime, { type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it } from "vitest";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function textTool(name: string, body: ToolDefinition["execute"]): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    output: {
      schema: { type: "string" },
      render: (_arguments, value) => [
        { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
      ],
    },
    execute: body,
  };
}

interface SetupOptions {
  readonly expectedOperation?: "task" | "review" | "diagnose" | "fix" | "implement";
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxCalls?: number;
  readonly tool?: ToolDefinition;
  readonly persistedState?: unknown;
  readonly registerAllowedGlobally?: boolean;
  readonly knownRuntimeTools?: readonly string[];
}

async function loadPolicy() {
  const policyPath = new URL("../assets/dsh/action-policy.mjs", import.meta.url);
  return (await import(policyPath.href)) as {
    readonly apply: (ctx: Context, config: unknown) => void;
  };
}

async function setup(options: SetupOptions) {
  const root = await mkdtemp(join(tmpdir(), "dsh-action-policy-"));
  temporary.push(root);
  const context = new Context();
  await context.plugin(SystemPrompt);
  await context.plugin(ToolRuntime);
  await context.plugin(AgentRegistry);
  if (options.registerAllowedGlobally !== false) {
    context.tools.register(options.tool ?? textTool("allowed", () => Promise.resolve("ok")));
  }
  context.tools.register(textTool("unauthorized", () => Promise.resolve("not allowed")));
  const policy = await loadPolicy();
  const statePath = join(root, "counts.json");
  const auditPath = join(root, "receipts.jsonl");
  if (options.persistedState !== undefined) {
    await writeFile(statePath, JSON.stringify(options.persistedState), "utf8");
  }
  try {
    policy.apply(context, {
      expectedOperation: options.expectedOperation ?? "task",
      allowedRuntimeTools: ["allowed"],
      knownRuntimeTools: options.knownRuntimeTools ?? ["allowed", "unauthorized"],
      rules: [
        {
          id: "mcp.fixture.allowed",
          runtimeName: "allowed",
          provider: "mcp",
          groupId: "mcp.fixture",
          timeoutMs: options.timeoutMs ?? 1_000,
          maxOutputBytes: options.maxOutputBytes ?? 1_024,
          maxCalls: options.maxCalls ?? 2,
          groupMaxCalls: 10,
        },
      ],
      statePath,
      auditPath,
    });
  } catch (error) {
    await context.fiber.dispose();
    throw error;
  }
  return { context, statePath, auditPath };
}

function invoke(context: Context, name: string, callId: string, agent?: Agent) {
  return context.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name,
    arguments: {},
    ...(agent === undefined ? {} : { agent }),
  });
}

async function createScopedAgent(
  context: Context,
  tools: readonly ToolDefinition[] = [],
  origin?: "subagent",
): Promise<{
  readonly agent: Agent;
  readonly scope: Scope;
}> {
  let parent: Context | undefined;
  await context.inject(["tools"], (injected) => {
    parent = injected;
  });
  if (parent === undefined) throw new Error("tools injection did not activate");
  const identity: Record<string, unknown> = {};
  const scope = createScope(parent, identity);
  const id = SessionId(`policy-agent-${String(Math.random()).slice(2)}`);
  const agent = identity as unknown as Agent;
  const agentContext = scope.ctx.extend({ agent });
  Object.assign(identity, {
    id,
    options: {},
    session: {
      id,
      header: {
        version: 0,
        id,
        createdAt: 0,
        ...(origin === undefined ? {} : { origin }),
      },
    },
    inbox: {},
    status: "idle",
    ctx: agentContext,
    cancel: () => undefined,
    whenIdle: () => Promise.resolve(),
    runMaintenance: () => Promise.reject(new Error("not implemented")),
    send: () => undefined,
    followup: () => undefined,
    steer: () => undefined,
    inject: () => undefined,
  });
  for (const tool of tools) agentContext.tools.register(tool);
  context.agents.register(agent);
  return { agent, scope };
}

describe("Action-owned DSH ToolRuntime policy", () => {
  it("places the root JSON protocol after tool guidance without constraining subagents", async () => {
    const { context } = await setup({});
    context.systemPrompt.section({
      name: "tool:web_search",
      order: 110,
      text: "Cite URLs as Markdown links.",
    });
    const { agent: rootAgent } = await createScopedAgent(context);
    const rootAssembly = await context.systemPrompt.assemble({
      agent: rootAgent,
      scope: rootAgent,
    });
    const rootSections = rootAssembly.sections.map(({ name }) => name);
    expect(rootSections.indexOf("dsh-action:root-output-protocol")).toBeGreaterThan(
      rootSections.indexOf("tool:web_search"),
    );
    expect(rootAssembly.sections.at(-1)?.name).toBe("dsh-action:root-output-protocol");
    expect(rootAssembly.sections.at(-1)?.text).toContain(
      "exactly one JSON object matching that contract",
    );
    expect(rootAssembly.sections.at(-1)?.text).toContain('Controller-selected operation is "task"');
    expect(rootAssembly.sections.at(-1)?.text).toContain('operation field must be exactly "task"');
    expect(rootAssembly.sections.at(-1)?.text).toContain(
      "Only an exact ID present inside the Controller-authored TRUSTED_TOOL_CATALOG_JSON array",
    );
    expect(rootAssembly.sections.at(-1)?.text).toContain(
      "An ID absent from that array is never requestable through needs_tool",
    );
    expect(rootAssembly.sections.at(-1)?.text).toContain(
      "Never imitate, prepare for, or replace a listed Controller catalog tool",
    );
    expect(renderPrompt(rootAssembly)).toContain("never permits bytes outside the JSON object");

    const { agent: childAgent } = await createScopedAgent(context, [], "subagent");
    const childAssembly = await context.systemPrompt.assemble({
      agent: childAgent,
      scope: childAgent,
    });
    expect(
      childAssembly.sections.find(({ name }) => name === "dsh-action:root-output-protocol")?.text,
    ).toBe("");
    expect(renderPrompt(childAssembly)).not.toContain("DSH Action root-output protocol");
    expect(renderPrompt(childAssembly)).not.toContain(
      "Only an exact ID present inside the Controller-authored TRUSTED_TOOL_CATALOG_JSON array",
    );
    await context.fiber.dispose();
  });

  it("rejects unknown tools and persists the invocation limit", async () => {
    const { context, statePath } = await setup({ maxCalls: 1 });
    expect((await invoke(context, "allowed", "first")).isError).toBe(false);
    const limited = await invoke(context, "allowed", "second");
    expect(limited).toMatchObject({ isError: true });
    expect(JSON.stringify(limited.content)).toContain("invocation limit");
    const unauthorized = await invoke(context, "unauthorized", "third");
    expect(unauthorized).toMatchObject({ isError: true });
    expect(JSON.stringify(unauthorized.content)).toContain("not authorized by the Controller");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      tools: { "mcp.fixture.allowed": 1 },
    });
    await context.fiber.dispose();
  });

  it("bounds output and records safe receipts", async () => {
    const { context, auditPath } = await setup({ maxOutputBytes: 32 });
    const result = await invoke(context, "allowed", "bounded");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("output exceeded");
    const receipts: unknown[] = (await readFile(auditPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(receipts).toEqual([
      expect.objectContaining({
        phase: "started",
        counted: true,
        id: "mcp.fixture.allowed",
        runtimeName: "allowed",
        provider: "mcp",
      }),
      expect.objectContaining({
        phase: "completed",
        counted: true,
        id: "mcp.fixture.allowed",
        runtimeName: "allowed",
        provider: "mcp",
        ok: false,
        code: "ACTION_TOOL_OUTPUT_LIMIT",
      }),
    ]);
    expect(JSON.stringify(receipts)).not.toContain("not allowed");
    await context.fiber.dispose();
  });

  it("counts canonical structured values even when their rendered content is small", async () => {
    const quietLargeTool: ToolDefinition = {
      name: "allowed",
      description: "allowed",
      parameters: { type: "object", properties: {} },
      output: {
        schema: { type: "string" },
        render: () => [{ type: "text", text: "small projection" }],
      },
      execute: () => Promise.resolve("x".repeat(4_096)),
    };
    const { context } = await setup({ maxOutputBytes: 256, tool: quietLargeTool });
    const result = await invoke(context, "allowed", "structured-limit");
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("output exceeded");
    await context.fiber.dispose();
  });

  it("fails closed on malformed or forged persisted invocation counts", async () => {
    await expect(
      setup({
        persistedState: {
          schemaVersion: 1,
          tools: { "mcp.fixture.allowed": -1 },
          groups: {},
        },
      }),
    ).rejects.toThrow(/non-negative safe integer/u);
    await expect(
      setup({
        persistedState: {
          schemaVersion: 1,
          tools: { "mcp.fixture.unknown": 0 },
          groups: {},
        },
      }),
    ).rejects.toThrow(/unknown key/u);
  });

  it("rejects conflicting group limits and unknown rule fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-action-policy-config-"));
    temporary.push(root);
    const context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    context.tools.register(textTool("first", () => Promise.resolve("first")));
    context.tools.register(textTool("second", () => Promise.resolve("second")));
    const policy = await loadPolicy();
    const base = {
      expectedOperation: "task",
      allowedRuntimeTools: ["first", "second"],
      knownRuntimeTools: ["first", "second"],
      statePath: join(root, "counts.json"),
      auditPath: join(root, "receipts.jsonl"),
    };
    expect(() =>
      policy.apply(context, {
        ...base,
        rules: [
          {
            id: "mcp.fixture.first",
            runtimeName: "first",
            provider: "mcp",
            groupId: "mcp.fixture",
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxCalls: 2,
            groupMaxCalls: 2,
          },
          {
            id: "mcp.fixture.second",
            runtimeName: "second",
            provider: "mcp",
            groupId: "mcp.fixture",
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxCalls: 2,
            groupMaxCalls: 3,
          },
        ],
      }),
    ).toThrow(/conflicting invocation limits/u);
    expect(() =>
      policy.apply(context, {
        ...base,
        rules: [
          {
            id: "mcp.fixture.first",
            runtimeName: "first",
            provider: "mcp",
            groupId: "mcp.fixture",
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxCalls: 2,
            groupMaxCalls: 2,
            modelMayOverride: true,
          },
          {
            id: "mcp.fixture.second",
            runtimeName: "second",
            provider: "mcp",
            groupId: "mcp.fixture",
            timeoutMs: 1_000,
            maxOutputBytes: 1_024,
            maxCalls: 2,
            groupMaxCalls: 2,
          },
        ],
      }),
    ).toThrow(/unknown key modelMayOverride/u);
    expect(() =>
      policy.apply(context, {
        ...base,
        expectedOperation: "deploy",
        rules: [],
      }),
    ).toThrow(/expectedOperation must be a supported Controller operation/u);
    expect(() =>
      policy.apply(context, {
        allowedRuntimeTools: [],
        knownRuntimeTools: [],
        rules: [],
        statePath: base.statePath,
        auditPath: base.auditPath,
      }),
    ).toThrow(/expectedOperation must be a supported Controller operation/u);
    await context.fiber.dispose();
  });

  it("returns a controlled timeout for cooperative same-process tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-action-policy-timeout-"));
    temporary.push(root);
    const context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    context.tools.register(
      textTool(
        "slow",
        (_arguments, execution) =>
          new Promise((resolvePromise) => {
            execution.signal.addEventListener("abort", () => resolvePromise("stopped"), {
              once: true,
            });
          }),
      ),
    );
    const policy = await loadPolicy();
    policy.apply(context, {
      expectedOperation: "task",
      allowedRuntimeTools: ["slow"],
      knownRuntimeTools: ["slow"],
      rules: [
        {
          id: "plugin.fixture.slow",
          runtimeName: "slow",
          provider: "plugin",
          groupId: "plugin.fixture",
          timeoutMs: 20,
          maxOutputBytes: 1_024,
          maxCalls: 1,
          groupMaxCalls: 1,
        },
      ],
      statePath: join(root, "counts.json"),
      auditPath: join(root, "receipts.jsonl"),
    });
    const result = await invoke(context, "slow", "timeout");
    expect(result).toMatchObject({
      isError: true,
      error: { info: { code: "ACTION_TOOL_TIMEOUT" } },
    });
    await context.fiber.dispose();
  });

  it("allows an authorized agent-scoped tool while tolerating an absent unselected tool", async () => {
    const { context } = await setup({
      registerAllowedGlobally: false,
      knownRuntimeTools: ["allowed", "unauthorized", "stale_unselected"],
    });
    const { agent } = await createScopedAgent(context, [
      textTool("allowed", () => Promise.resolve("scoped-ok")),
    ]);
    expect(context.tools.schemas(agent).map(({ name }) => name)).toEqual(["allowed"]);
    const result = await invoke(context, "allowed", "scoped-allowed", agent);
    expect(result).toMatchObject({ isError: false, value: "scoped-ok" });
    await context.fiber.dispose();
  });

  it("fails closed when an agent-scoped tool survives outside the allowlist", async () => {
    const { context } = await setup({});
    await expect(
      createScopedAgent(context, [
        textTool("scoped_extra", () => Promise.resolve("must not be visible")),
      ]),
    ).rejects.toThrow(/unaudited tool scoped_extra/u);
    await context.fiber.dispose();
  });

  it("bounds definition finalizeContent after the post-execute pipeline", async () => {
    const expandingTool: ToolDefinition = {
      ...textTool("allowed", () => Promise.resolve("small")),
      finalizeContent: () => [{ type: "text", text: `EXPANDED:${"x".repeat(8_192)}` }],
    };
    const { context } = await setup({ maxOutputBytes: 256, tool: expandingTool });
    const { agent } = await createScopedAgent(context);
    const result = await invoke(context, "allowed", "final-content-limit", agent);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("output exceeded");
    expect(JSON.stringify(result.content)).not.toContain("EXPANDED:");
    await context.fiber.dispose();
  });
});
