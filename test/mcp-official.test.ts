import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { Context } from "@deepseek-ai/cordis";
import { CallId } from "@deepseek-ai/dsh-llm";
import { apply as applyOfficialMcpClient } from "@deepseek-ai/dsh-mcp-client";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { mcpPublicToolName } from "../src/extensions/plan.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));

describe("official @deepseek-ai/dsh-mcp-client rc.2", () => {
  let context: Context;

  beforeAll(async () => {
    context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await applyOfficialMcpClient(context, {
      transport: "stdio",
      serverName: "fixture",
      command: process.execPath,
      args: [fixture],
      env: {},
      cwd: process.cwd(),
      toolCallTimeoutMs: 200,
      failOnStartupError: true,
      reconnect: { enabled: false },
    });
  }, 20_000);

  afterAll(async () => {
    await context.fiber.dispose();
  });

  it("discovers and invokes a real stdio MCP tool through the official client", async () => {
    expect(context.tools.schemas().map(({ name }) => name)).toContain("mcp__fixture__add");
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("action-mcp-add"),
      name: "mcp__fixture__add",
      arguments: { left: 19, right: 23 },
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "42" }],
    });
  });

  it("locks the Action mapping to rc.2 public-name normalization", () => {
    const expected = mcpPublicToolName("fixture", "admin.reset");
    expect(expected).toMatch(/^mcp__fixture__admin_reset_[0-9a-f]{12}$/u);
    expect(context.tools.schemas().map(({ name }) => name)).toContain(expected);
    const utf16Expected = mcpPublicToolName("fixture", "emoji.💥");
    expect(context.tools.schemas().map(({ name }) => name)).toContain(utf16Expected);
  });

  it("enforces the official MCP tool-call timeout", async () => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("action-mcp-timeout"),
      name: "mcp__fixture__slow",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/timed?\s*out|timeout/iu);
  });

  it("returns controlled failures after a server crashes with reconnect disabled", async () => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("action-mcp-crash"),
      name: "mcp__fixture__crash",
      arguments: {},
    });
    expect(result.isError).toBe(false);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    const afterCrash = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("action-mcp-after-crash"),
      name: "mcp__fixture__add",
      arguments: { left: 1, right: 1 },
    });
    expect(afterCrash.isError).toBe(true);
  });
});

// Adapted from the official rc.2 dsh-mcp-client stateless HTTP fixture.
describe("official streamable-http transport", () => {
  let context: Context;
  let server: Server;
  let url: string;
  const authorization: (string | undefined)[] = [];

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    authorization.push(request.headers.authorization);
    const mcp = new McpServer(
      { name: "dsh-action-http-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "shout",
      { description: "Upper-case text", inputSchema: { message: z.string() } },
      ({ message }) =>
        Promise.resolve({ content: [{ type: "text", text: message.toUpperCase() }] }),
    );
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport as Transport);
    await transport.handleRequest(request, response);
  }

  beforeAll(async () => {
    server = createServer((request, response) => {
      handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address");
    url = `http://127.0.0.1:${String(address.port)}/mcp`;
    context = new Context();
    await context.plugin(SystemPrompt);
    await context.plugin(ToolRuntime);
    await applyOfficialMcpClient(context, {
      transport: "streamable-http",
      serverName: "httpfixture",
      url,
      headers: { Authorization: "Bearer controlled-test-token" },
      toolCallTimeoutMs: 5_000,
      failOnStartupError: true,
      reconnect: { enabled: false },
    });
  }, 20_000);

  afterAll(async () => {
    await context.fiber.dispose();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  it("invokes tools and forwards only configured headers", async () => {
    const result = await context.tools.execute({
      signal: new AbortController().signal,
      callId: CallId("action-http-shout"),
      name: "mcp__httpfixture__shout",
      arguments: { message: "controlled" },
    });
    expect(result).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "CONTROLLED" }],
    });
    expect(authorization.length).toBeGreaterThan(0);
    expect(new Set(authorization)).toEqual(new Set(["Bearer controlled-test-token"]));
  });
});
