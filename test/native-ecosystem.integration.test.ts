import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { healProfilesModuleFallback } from "@deepseek-ai/dsh-app-boot";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { writeNativeProfile } from "../src/dsh/native-composition.js";
import { resolveNativeExtensionPlan } from "../src/extensions/plan.js";
import {
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../src/extensions/schema.js";

const execFileAsync = promisify(execFile);
const temporary: string[] = [];
const require = createRequire(import.meta.url);
const installAnchor = require.resolve("@deepseek-ai/dsh/package.json");

interface DeepSeekMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

interface DeepSeekTool {
  readonly function?: { readonly name?: unknown };
}

interface DeepSeekRequest {
  readonly messages?: readonly DeepSeekMessage[];
  readonly tools?: readonly DeepSeekTool[];
}

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("locked rc.2 native ecosystem boot", () => {
  it("discovers repository Skills and invokes native MCP, Bundle, Plugin, Subagent, and Workflow capabilities", async () => {
    // This machine's home can itself be a Git worktree. Put the Windows
    // fixture under Public so the rc.2 no-.git fallback is exercised rather
    // than accidentally selecting an ancestor repository.
    const temporaryBase =
      process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir();
    const root = await mkdtemp(join(temporaryBase, "dsh-native-ecosystem-test-"));
    temporary.push(root);
    const dshHome = join(root, "home");
    const profileRoot = join(dshHome, "profiles", "github-action");
    const workspace = join(root, "workspace");
    const actionState = join(dshHome, "action-state");
    const bundlePackage = "@dsh-action/native-ecosystem-bundle";
    const pluginPackage = "@dsh-action/native-ecosystem-plugin";
    const installedBundle = join(profileRoot, "node_modules", ...bundlePackage.split("/"));
    const installedPlugin = join(profileRoot, "node_modules", ...pluginPackage.split("/"));
    const httpMcp = await startNativeHttpMcpFixture();
    for (const directory of [
      profileRoot,
      actionState,
      join(dshHome, "sessions"),
      join(dshHome, "attachments"),
      join(workspace, ".dsh", "skills", "native-dsh"),
      join(workspace, ".agents", "skills", "native-agents"),
      join(installedBundle, ".."),
      join(installedPlugin, ".."),
    ]) {
      await mkdir(directory, { recursive: true });
    }
    await Promise.all([
      cp(join(process.cwd(), "test", "fixtures", "native-ecosystem-bundle"), installedBundle, {
        recursive: true,
      }),
      cp(join(process.cwd(), "test", "fixtures", "native-ecosystem-plugin"), installedPlugin, {
        recursive: true,
      }),
    ]);
    await writeFile(
      join(workspace, ".dsh", "skills", "native-dsh", "SKILL.md"),
      "---\nname: native-dsh\ndescription: Native DSH project skill fixture\n---\nNATIVE_DSH_SKILL_BODY_MARKER\n",
    );
    await writeFile(
      join(workspace, ".agents", "skills", "native-agents", "SKILL.md"),
      "---\nname: native-agents\ndescription: Native agents project skill fixture\n---\nNATIVE_AGENTS_SKILL_BODY_MARKER\n",
    );
    await expect(stat(join(workspace, ".git"))).rejects.toThrow();
    const plan = resolveNativeExtensionPlan({
      mcp: parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "httpfixture",
              transport: "streamable-http",
              url: httpMcp.url,
              credentialHeaders: {
                Authorization: "Bearer native-http-owned-token",
              },
              toolCallTimeoutMs: 5_000,
              reconnect: {
                enabled: false,
                initialDelayMs: 500,
                maxDelayMs: 30_000,
                maxAttempts: 10,
              },
            },
          ],
        }),
      ),
      plugins: parseNativePluginConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          bundles: [{ id: "bundle", package: bundlePackage, source: "1.0.0" }],
          plugins: [
            {
              id: "plugin",
              package: pluginPackage,
              source: "1.0.0",
              config: { marker: "CORDIS_NATIVE" },
            },
          ],
        }),
      ),
      allowPluginInstall: true,
      policy: {
        trust: "trusted-read",
        allowed: true,
        reason: "native production Profile integration",
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
      },
    });
    await writeNativeProfile({
      profileRoot,
      manifestBase: { name: "locked-runtime", private: true, dependencies: {} },
      plan,
      moduleSpecifiers: { plugin: pathToFileURL(join(installedPlugin, "index.mjs")).href },
    });
    await writeFile(join(actionState, "native-observed-tools.jsonl"), "");
    await writeFile(join(dshHome, ".anonymous-user-id"), "11111111-1111-4111-8111-111111111111\n");
    await cp(
      join(process.cwd(), "assets", "dsh", "native-launcher.mjs"),
      join(profileRoot, "native-launcher.mjs"),
    );

    // The production installer supplies the same dependency closure under the
    // Profile package root. This public helper gives the isolated test Profile
    // that official installation-owned closure without acquiring anything.
    healProfilesModuleFallback(installAnchor, dshHome);

    const llm = await startNativeLlmFixture();
    try {
      const result = await execFileAsync(
        process.execPath,
        [
          "--expose-internals",
          join(profileRoot, "native-launcher.mjs"),
          "Use the requested native ecosystem capabilities and return review JSON.",
        ],
        {
          cwd: workspace,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            HOME: dshHome,
            DSH_HOME: dshHome,
            DSH_PERMISSION_MODE: "read-only",
            DSH_TELEMETRY_DISABLED: "1",
            DSH_TOOLS_MODE: "native",
            DEEPSEEK_API_KEY: "native-fixture-key",
            DEEPSEEK_BASE_URL: llm.baseUrl,
            DEEPSEEK_SEARCH_BASE_URL: llm.baseUrl,
          },
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );

      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        protocolVersion: 1,
        operation: "review",
        state: "final",
        summary: "native ecosystem booted",
      });
      const rootRequests = llm.requests.filter(
        (request) => !hasUserText(request, "CHILD_NATIVE_MARKER"),
      );
      expect(rootRequests.length).toBeGreaterThanOrEqual(7);
      const firstTools = toolNames(rootRequests[0]);
      for (const name of [
        "skill",
        "subagent",
        "workflow",
        "mcp__httpfixture__shout",
        "native_bundle_echo",
        "native_plugin_echo",
      ]) {
        expect(firstTools).toContain(name);
      }
      const transcript = JSON.stringify(llm.requests);
      expect(transcript).toContain("native-dsh");
      expect(transcript).toContain("native-agents");
      expect(transcript).toContain("NATIVE_DSH_SKILL_BODY_MARKER");
      expect(transcript).toContain("NATIVE-HTTP");
      expect(transcript).toContain("NATIVE_BUNDLE_MARKER");
      expect(transcript).toContain("NATIVE_PLUGIN_MARKER:CORDIS_NATIVE");
      const childRequests = llm.requests.filter((request) =>
        hasUserText(request, "CHILD_NATIVE_MARKER"),
      );
      expect(
        childRequests.length,
        JSON.stringify(
          llm.requests.map((request) => ({
            lastUser: lastUserText(request),
            toolResults: request.messages?.filter(({ role }) => role === "tool"),
          })),
        ),
      ).toBeGreaterThan(0);
      expect(transcript).toContain("CHILD_NATIVE_MARKER_OK");
      expect(transcript).toContain("NATIVE_WORKFLOW_MARKER");
      expect(new Set(httpMcp.authorization)).toEqual(new Set(["Bearer native-http-owned-token"]));

      const observation = JSON.parse(
        (await readFile(join(actionState, "native-observed-tools.jsonl"), "utf8")).trim(),
      ) as { readonly observedTools: readonly string[] };
      for (const name of [
        "skill",
        "subagent",
        "subagent_fork",
        "workflow",
        "list_agents",
        "mcp__httpfixture__shout",
        "native_bundle_echo",
        "native_plugin_echo",
      ]) {
        expect(observation.observedTools).toContain(name);
      }
    } finally {
      await llm.close();
      await httpMcp.close();
    }
  }, 100_000);
});

function toolNames(request: DeepSeekRequest | undefined): string[] {
  return (request?.tools ?? [])
    .map((tool) => tool.function?.name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

function lastUserText(request: DeepSeekRequest): string {
  const user = [...(request.messages ?? [])].reverse().find(({ role }) => role === "user");
  return JSON.stringify(user?.content ?? "");
}

function hasUserText(request: DeepSeekRequest, marker: string): boolean {
  return (request.messages ?? []).some(
    ({ role, content }) => role === "user" && JSON.stringify(content).includes(marker),
  );
}

async function readJsonRequest(request: IncomingMessage): Promise<DeepSeekRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    if (typeof chunk === "string") chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw new TypeError("DeepSeek fixture received a non-byte request chunk");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as DeepSeekRequest;
}

function sendSse(response: ServerResponse, delta: Record<string, unknown>, finishReason: string) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function sendToolCall(
  response: ServerResponse,
  index: number,
  name: string,
  args: Record<string, unknown>,
) {
  sendSse(
    response,
    {
      tool_calls: [
        {
          index: 0,
          id: `native-call-${String(index)}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

async function startNativeLlmFixture(): Promise<{
  readonly baseUrl: string;
  readonly requests: DeepSeekRequest[];
  readonly close: () => Promise<void>;
}> {
  const requests: DeepSeekRequest[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    readJsonRequest(request)
      .then((body) => {
        requests.push(body);
        if (hasUserText(body, "Generate the session title")) {
          sendSse(response, { content: "Native Ecosystem" }, "stop");
          return;
        }
        if (hasUserText(body, "CHILD_NATIVE_MARKER")) {
          sendSse(response, { content: "CHILD_NATIVE_MARKER_OK" }, "stop");
          return;
        }
        const results = body.messages?.filter(({ role }) => role === "tool").length ?? 0;
        switch (results) {
          case 0:
            sendToolCall(response, results, "skill", { name: "native-dsh" });
            return;
          case 1:
            sendToolCall(response, results, "mcp__httpfixture__shout", {
              message: "native-http",
            });
            return;
          case 2:
            sendToolCall(response, results, "native_bundle_echo", {});
            return;
          case 3:
            sendToolCall(response, results, "native_plugin_echo", {});
            return;
          case 4:
            sendToolCall(response, results, "subagent", {
              description: "Native child marker",
              prompt: "Return CHILD_NATIVE_MARKER exactly.",
              run_in_background: false,
            });
            return;
          case 5:
            sendToolCall(response, results, "workflow", {
              script: "return { marker: 'NATIVE_WORKFLOW_MARKER', value: args.value };",
              meta: {
                name: "native-workflow-smoke",
                description: "Verify the locked rc.2 workflow engine",
              },
              args: { value: 7 },
            });
            return;
          default:
            sendSse(
              response,
              {
                content: JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: "native ecosystem booted",
                  findings: [],
                }),
              },
              "stop",
            );
        }
      })
      .catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    requests,
    close: () => closeServer(server),
  };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
  });
}

async function startNativeHttpMcpFixture(): Promise<{
  readonly url: string;
  readonly authorization: (string | undefined)[];
  readonly close: () => Promise<void>;
}> {
  const authorization: (string | undefined)[] = [];
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization);
    const mcp = new McpServer(
      { name: "dsh-action-native-http-fixture", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.registerTool(
      "shout",
      { description: "Upper-case native text", inputSchema: { message: z.string() } },
      ({ message }) =>
        Promise.resolve({ content: [{ type: "text", text: message.toUpperCase() }] }),
    );
    const transport = new StreamableHTTPServerTransport({});
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    mcp
      .connect(transport as Transport)
      .then(async () => await transport.handleRequest(request, response))
      .catch((error: unknown) => response.writeHead(500).end(String(error)));
  });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    authorization,
    close: () => closeServer(server),
  };
}
