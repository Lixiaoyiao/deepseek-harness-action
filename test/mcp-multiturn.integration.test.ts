import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { mcpPublicToolName, resolveExtensionPlan } from "../src/extensions/plan.js";
import { prepareControlledProfile } from "../src/extensions/profile.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import { messageToolResults, sendMessagesSse as sendSse } from "./fixtures/messages-sse.mjs";
import type { SecurityPolicy } from "../src/security/policy.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const trustedRead: SecurityPolicy = {
  trust: "trusted-read",
  allowed: true,
  reason: "controlled MCP integration test",
  capabilities: {
    readRepository: true,
    readCi: false,
    publishComments: true,
    executeRepositoryCode: false,
    loadExtensions: true,
    accessNetwork: true,
    modifyWorkspace: false,
    commit: false,
    push: false,
    createPullRequest: false,
    manageIssueLabels: false,
    manageIssueAssignees: false,
    updateIssueState: false,
    updatePullRequestMetadata: false,
  },
};

interface DeepSeekTool {
  readonly name?: unknown;
}

interface DeepSeekMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

interface DeepSeekRequest {
  readonly messages?: readonly DeepSeekMessage[] | undefined;
  readonly tools?: readonly DeepSeekTool[] | undefined;
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("fresh official DSH workers share Controller MCP limits", () => {
  it("invokes streamable-http twice, then denies the third call before dispatch", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(process.cwd(), ".dsh-mcp-multiturn-test-")),
    );
    temporary.push(root);
    const dshHome = join(root, "home");
    const workspace = join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));

    const mcpFixture = await startMcpFixture();
    const llmFixture = await startDeepSeekFixture();
    try {
      const allowedRuntimeName = mcpPublicToolName("fixture", "ping");
      const deniedRuntimeName = mcpPublicToolName("fixture", "admin.reset");
      const plan = resolveExtensionPlan({
        allowedTools: ["mcp.fixture.ping"],
        mcp: parseMcpConfiguration(
          JSON.stringify({
            schemaVersion: 1,
            servers: [
              {
                id: "fixture",
                transport: "streamable-http",
                url: mcpFixture.url,
                headers: { Authorization: "Bearer controller-selected-fixture" },
                reconnect: { enabled: false },
                maxCalls: 10,
                tools: [
                  {
                    id: "ping",
                    name: "ping",
                    description: "Return the supplied turn marker",
                    permissions: ["read", "network"],
                    timeoutMs: 5_000,
                    maxOutputBytes: 16_384,
                    maxCalls: 2,
                  },
                  {
                    id: "admin",
                    name: "admin.reset",
                    description: "Configured but not Controller-authorized",
                    permissions: ["read", "network"],
                    timeoutMs: 5_000,
                    maxOutputBytes: 16_384,
                    maxCalls: 2,
                  },
                ],
              },
            ],
          }),
        ),
        plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
        allowPluginInstall: false,
        policy: trustedRead,
      });
      const manifestBase = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")));
      const profile = await prepareControlledProfile({
        dshHome,
        plan,
        nativeTools: [],
        workspaceWrite: false,
        expectedOperation: "task",
        task: "Call the allowed MCP ping tool exactly once, then finish.",
        workerWorkspacePath: workspace,
        policyPluginPath: pathToFileURL(join(process.cwd(), "assets", "dsh", "action-policy.mjs"))
          .href,
        workspacePluginPath: pathToFileURL(
          join(process.cwd(), "assets", "dsh", "action-workspace.mjs"),
        ).href,
        workerStatePath: join(dshHome, "action-state", "tool-counts.json"),
        workerAuditPath: join(dshHome, "action-state", "tool-receipts.jsonl"),
        manifestBase,
      });
      const launcher = join(process.cwd(), "assets", "dsh", "action-launcher.mjs");

      for (let turn = 1; turn <= 3; turn += 1) {
        const result = await execFileAsync(
          process.execPath,
          [launcher, `Turn ${String(turn)}: call the allowed MCP ping tool once.`],
          {
            cwd: root,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              DSH_HOME: dshHome,
              DSH_TELEMETRY_DISABLED: "1",
              DSH_TOOLS_MODE: "native",
              DEEPSEEK_API_KEY: "controlled-fixture-key",
              DEEPSEEK_BASE_URL: llmFixture.baseUrl,
            },
            timeout: 60_000,
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        expect(result.stderr).toBe("");
        expect(result.stdout).toContain("fixture turn complete");
      }

      expect(mcpFixture.toolCalls).toEqual([{ message: "from-model" }, { message: "from-model" }]);
      expect(new Set(mcpFixture.authorization)).toEqual(
        new Set(["Bearer controller-selected-fixture"]),
      );

      const firstRequests = llmFixture.requests.filter(
        (request) => messageToolResults(request).length === 0,
      );
      expect(firstRequests).toHaveLength(3);
      for (const request of firstRequests) {
        expect(toolNames(request)).toEqual([allowedRuntimeName]);
      }
      expect(llmFixture.requests.flatMap((request) => toolNames(request))).not.toContain(
        deniedRuntimeName,
      );

      const counts = z
        .looseObject({
          schemaVersion: z.number(),
          tools: z.record(z.string(), z.number()),
          groups: z.record(z.string(), z.number()),
        })
        .parse(JSON.parse(await readFile(profile.statePath, "utf8")));
      expect(counts).toEqual({
        schemaVersion: 1,
        tools: { "mcp.fixture.ping": 2 },
        groups: { "mcp.fixture": 2 },
      });

      const events = (await readFile(profile.auditPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) =>
          z
            .looseObject({
              phase: z.union([z.literal("started"), z.literal("completed")]),
              id: z.string(),
              runtimeName: z.string(),
              provider: z.string(),
              ok: z.boolean(),
              counted: z.boolean(),
            })
            .parse(JSON.parse(line)),
        );
      expect(events.filter(({ phase }) => phase === "started")).toHaveLength(2);
      const receipts = events.filter(({ phase }) => phase === "completed");
      expect(receipts).toHaveLength(3);
      expect(receipts.map(({ counted }) => counted)).toEqual([true, true, false]);
      expect(
        receipts.map(({ id, runtimeName, provider, ok }) => ({ id, runtimeName, provider, ok })),
      ).toEqual([
        { id: "mcp.fixture.ping", runtimeName: allowedRuntimeName, provider: "mcp", ok: true },
        { id: "mcp.fixture.ping", runtimeName: allowedRuntimeName, provider: "mcp", ok: true },
        {
          id: "mcp.fixture.ping",
          runtimeName: allowedRuntimeName,
          provider: "mcp",
          ok: false,
        },
      ]);
    } finally {
      await Promise.all([mcpFixture.close(), llmFixture.close()]);
    }
  }, 90_000);
});

function toolNames(request: DeepSeekRequest): string[] {
  return (request.tools ?? [])
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

async function readJsonRequest(request: IncomingMessage): Promise<DeepSeekRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw new TypeError("DeepSeek fixture received a non-byte request chunk");
  }
  return z
    .looseObject({
      messages: z
        .array(z.looseObject({ role: z.unknown().optional(), content: z.unknown().optional() }))
        .optional(),
      tools: z.array(z.looseObject({ name: z.unknown().optional() })).optional(),
    })
    .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
}

async function startDeepSeekFixture(): Promise<{
  readonly baseUrl: string;
  readonly requests: DeepSeekRequest[];
  readonly close: () => Promise<void>;
}> {
  const requests: DeepSeekRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/v1/messages")) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    readJsonRequest(request)
      .then((body) => {
        requests.push(body);
        const followsTool = messageToolResults(body).length > 0;
        if (followsTool) {
          sendSse(response, { content: "fixture turn complete" }, "stop");
          return;
        }
        sendSse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: `fixture-call-${String(requests.length)}`,
                type: "function",
                function: { name: "mcp__fixture__ping", arguments: '{"message":"from-model"}' },
              },
            ],
          },
          "tool_calls",
        );
      })
      .catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  const baseUrl = await listen(server);
  return { baseUrl, requests, close: () => closeServer(server) };
}

async function startMcpFixture(): Promise<{
  readonly url: string;
  readonly toolCalls: { readonly message: string }[];
  readonly authorization: (string | undefined)[];
  readonly close: () => Promise<void>;
}> {
  const toolCalls: { readonly message: string }[] = [];
  const authorization: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization);
    const mcp = new McpServer(
      { name: "dsh-action-multiturn-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "ping",
      { description: "Return a controlled marker", inputSchema: { message: z.string() } },
      ({ message }) => {
        toolCalls.push({ message });
        return Promise.resolve({ content: [{ type: "text", text: `pong:${message}` }] });
      },
    );
    mcp.registerTool("admin.reset", { description: "Must stay hidden", inputSchema: {} }, () =>
      Promise.resolve({ content: [{ type: "text", text: "unauthorized" }] }),
    );
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK declares a string|undefined sessionId getter against its own exact-optional Transport interface.
      .connect(transport as Transport)
      .then(() => transport.handleRequest(request, response))
      .catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  const origin = await listen(server);
  return {
    url: `${origin}/mcp`,
    toolCalls,
    authorization,
    close: () => closeServer(server),
  };
}
