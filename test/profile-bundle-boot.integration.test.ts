import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveExtensionPlan } from "../src/extensions/plan.js";
import {
  prepareControlledProfile,
  resolveInstalledPluginModuleSpecifiers,
} from "../src/extensions/profile.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import type { SecurityPolicy } from "../src/security/policy.js";

const PACKAGE_NAME = "@dsh-action/official-profile-bundle";
const PACKAGE_VERSION = "1.2.3";
const ALLOWED_TOOL = "plugin__fixture__allowed";
const HIDDEN_TOOL = "plugin__fixture__hidden";
const HIDDEN_MARKER = "OFFICIAL_PROFILE_BUNDLE_HIDDEN_TOOL_EXECUTED";
const execFileAsync = promisify(execFile);
const temporary: string[] = [];

const trustedRead: SecurityPolicy = {
  trust: "trusted-read",
  allowed: true,
  reason: "official Profile Bundle boot test",
  capabilities: {
    readRepository: true,
    readCi: false,
    publishComments: true,
    executeRepositoryCode: false,
    loadExtensions: true,
    accessNetwork: false,
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
  readonly function?: { readonly name?: unknown };
}

interface DeepSeekMessage {
  readonly role?: unknown;
}

interface DeepSeekRequest {
  readonly messages?: readonly DeepSeekMessage[];
  readonly tools?: readonly DeepSeekTool[];
}

interface ToolReceipt {
  readonly id: string;
  readonly runtimeName: string;
  readonly provider: string;
  readonly ok: boolean;
}

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("official rc.2 Profile package extension boot", () => {
  it.each([
    { kind: "bundle", label: "Bundle", planKey: "bundles", groupId: "bundle.fixture" },
    {
      kind: "plugin",
      label: "direct Cordis plugin",
      planKey: "plugins",
      groupId: "plugin.fixture",
    },
  ] as const)(
    "loads a pinned allowed $label into ToolRuntime and hides its unauthorized tool",
    async ({ kind, planKey, groupId }) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-profile-bundle-boot-test-"));
      temporary.push(root);
      const dshHome = join(root, "home");
      const workspace = join(root, "workspace");
      await mkdir(workspace);

      const definition = {
        id: "fixture",
        package: PACKAGE_NAME,
        source: PACKAGE_VERSION,
        tools: [
          {
            id: "allowed",
            name: ALLOWED_TOOL,
            description: "Return a controlled package-extension marker",
            permissions: ["read"],
            maxCalls: 1,
          },
          {
            id: "hidden",
            name: HIDDEN_TOOL,
            description: "Configured but not Controller-authorized",
            permissions: ["read"],
            maxCalls: 1,
          },
        ],
      };
      const plugins = parsePluginConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          bundles: kind === "bundle" ? [definition] : [],
          plugins: kind === "plugin" ? [{ ...definition, config: { fixture: "direct" } }] : [],
        }),
      );
      const plan = resolveExtensionPlan({
        allowedTools: ["plugin.fixture.allowed"],
        mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
        plugins,
        allowPluginInstall: true,
        policy: trustedRead,
      });
      expect(plan.packageDependencies).toEqual({ [PACKAGE_NAME]: PACKAGE_VERSION });
      expect(plan[planKey]).toHaveLength(1);

      const manifestBase = JSON.parse(
        await readFile(join(process.cwd(), "package.json"), "utf8"),
      ) as Record<string, unknown>;
      const profileOptions = {
        dshHome,
        plan,
        nativeTools: [],
        workspaceWrite: false,
        expectedOperation: "task",
        task: "Call the allowed Bundle tool, then finish.",
        workerWorkspacePath: workspace,
        policyPluginPath: pathToFileURL(join(process.cwd(), "assets", "dsh", "action-policy.mjs"))
          .href,
        workspacePluginPath: pathToFileURL(
          join(process.cwd(), "assets", "dsh", "action-workspace.mjs"),
        ).href,
        workerStatePath: join(dshHome, "action-state", "tool-counts.json"),
        workerAuditPath: join(dshHome, "action-state", "tool-receipts.jsonl"),
        manifestBase,
      } as const;
      let profile = await prepareControlledProfile(profileOptions);

      const fixtureSource = join(process.cwd(), "test", "fixtures", "official-profile-bundle");
      const installedFixture = join(profile.profileDir, "node_modules", ...PACKAGE_NAME.split("/"));
      await mkdir(join(installedFixture, ".."), { recursive: true });
      await cp(fixtureSource, installedFixture, { recursive: true });
      if (kind === "plugin") {
        const pluginModuleSpecifiers = await resolveInstalledPluginModuleSpecifiers({
          packageRoot: profile.profileDir,
          workerProfilePath: profile.profileDir,
          plan,
        });
        profile = await prepareControlledProfile({ ...profileOptions, pluginModuleSpecifiers });
      }

      const require = createRequire(import.meta.url);
      const { loadProfile } = await import("@deepseek-ai/dsh-app-boot");
      const installAnchor = require.resolve("@deepseek-ai/dsh/package.json");
      const loaded = loadProfile("dsh-action-test", "github-action", installAnchor, dshHome);
      const fixtureLayer = loaded.layers.find((layer) => layer.packageName === PACKAGE_NAME);
      if (kind === "bundle") {
        expect(fixtureLayer?.packageDir).toBe(installedFixture);
        expect(
          JSON.parse(await readFile(join(fixtureLayer?.packageDir ?? "", "package.json"), "utf8")),
        ).toMatchObject({ name: PACKAGE_NAME, version: PACKAGE_VERSION });
      } else {
        // A direct plugin must be mounted by the generated Cordis row, not by
        // smuggling its package into the Profile's Bundle list.
        expect(fixtureLayer).toBeUndefined();
        const patch = JSON.parse(await readFile(profile.patchPath, "utf8")) as {
          readonly insert?: readonly { readonly id?: string; readonly name?: string }[];
        }[];
        const installedEntry = join(installedFixture, "index.mjs");
        expect(patch.flatMap((row) => row.insert ?? [])).toContainEqual(
          expect.objectContaining({
            id: "dsh-action-plugin-fixture",
            name:
              process.platform === "win32" ? pathToFileURL(installedEntry).href : installedEntry,
          }),
        );
      }

      const llmFixture = await startDeepSeekFixture();
      try {
        const launcher = join(process.cwd(), "assets", "dsh", "action-launcher.mjs");
        const result = await execFileAsync(
          process.execPath,
          [launcher, "Call the allowed Bundle tool, then try the hidden tool."],
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
        expect(result.stdout).toContain("official Bundle boot complete");

        expect(llmFixture.requests).toHaveLength(3);
        for (const request of llmFixture.requests) {
          expect(toolNames(request)).toEqual([ALLOWED_TOOL]);
        }
        const transcript = JSON.stringify(llmFixture.requests);
        expect(transcript).toContain("official-profile-bundle@1.2.3:allowed");
        expect(transcript).not.toContain(HIDDEN_MARKER);
        expect(transcript).toMatch(/unknown tool|not authorized|not available/iu);

        const counts = JSON.parse(await readFile(profile.statePath, "utf8")) as {
          readonly tools: Readonly<Record<string, number>>;
          readonly groups: Readonly<Record<string, number>>;
        };
        expect(counts).toMatchObject({
          tools: { "plugin.fixture.allowed": 1 },
          groups: { [groupId]: 1 },
        });
        expect(counts.tools["plugin.fixture.hidden"]).toBeUndefined();

        const receipts = (await readFile(profile.auditPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as ToolReceipt);
        expect(receipts).toContainEqual(
          expect.objectContaining({
            id: "plugin.fixture.allowed",
            runtimeName: ALLOWED_TOOL,
            provider: "plugin",
            ok: true,
          }),
        );
        expect(receipts).not.toContainEqual(
          expect.objectContaining({ runtimeName: HIDDEN_TOOL, ok: true }),
        );
      } finally {
        await llmFixture.close();
      }
    },
    80_000,
  );
});

function toolNames(request: DeepSeekRequest): string[] {
  return (request.tools ?? [])
    .map((tool) => tool.function?.name)
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

async function startDeepSeekFixture(): Promise<{
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
        const toolResults = body.messages?.filter((message) => message.role === "tool").length ?? 0;
        if (toolResults === 0) {
          sendSse(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "allowed-bundle-call",
                  type: "function",
                  function: { name: ALLOWED_TOOL, arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          );
          return;
        }
        if (toolResults === 1) {
          sendSse(
            response,
            {
              tool_calls: [
                {
                  index: 0,
                  id: "hidden-bundle-call",
                  type: "function",
                  function: { name: HIDDEN_TOOL, arguments: "{}" },
                },
              ],
            },
            "tool_calls",
          );
          return;
        }
        sendSse(response, { content: "official Bundle boot complete" }, "stop");
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
