import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import { DshIsolationUnavailableError } from "../src/dsh/errors.js";
import type { DeepSeekProxyOptions } from "../src/dsh/proxy.js";
import { NativeComposition } from "../src/dsh/native-composition.js";
import { createDshRuntime, disposeDshRuntime, runDsh } from "../src/dsh/runner.js";
import type { DshProcessSpec } from "../src/dsh/runner.js";
import { resolveExtensionPlan, resolveNativeExtensionPlan } from "../src/extensions/plan.js";
import {
  parseMcpConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
  parsePluginConfiguration,
} from "../src/extensions/schema.js";
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

describe("runDsh native", () => {
  it("consumes the NativeComposition Docker launch plan and reports runtime-observed tools", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const realGitHubToken = "github-controller-secret";
    const environmentDeepSeekKey = "environment-controller-key";
    const proxy = {
      ...fakeProxy(),
      workerWebSearchBaseUrl: "http://host.docker.internal:3456/anthropic/v1",
    };
    let proxyOptions: DeepSeekProxyOptions | undefined;
    let captured: DshProcessSpec | undefined;

    try {
      const result = await runDsh(
        request({ isolation: "docker", workspacePath: fixture.workspace }),
        {
          assetsDirectory: fixture.assets,
          environment: {
            PATH: process.env.PATH,
            GITHUB_TOKEN: realGitHubToken,
            DEEPSEEK_API_KEY: environmentDeepSeekKey,
          },
          runtime,
          composition: new NativeComposition(),
          startProxy: (options) => {
            proxyOptions = options;
            return Promise.resolve(proxy);
          },
          executeProcess: async (spec) => {
            const inspected = networkInspectResult(spec);
            if (inspected !== undefined) return inspected;
            const isNativeWorker = spec.args.includes(CONTAINER_NATIVE_LAUNCHER);
            if (isNativeWorker) {
              captured = spec;
              await writeFile(
                join(actionStateDirectory(spec), "native-observed-tools.jsonl"),
                `${JSON.stringify({
                  schemaVersion: 1,
                  source: "ctx.tools.schemas(agent)",
                  observedTools: ["read", "glob", "grep", "read"],
                })}\n`,
                { encoding: "utf8", flag: "a" },
              );
            }
            return {
              stdout: isNativeWorker
                ? JSON.stringify({
                    protocolVersion: 1,
                    operation: "review",
                    state: "final",
                    summary: "Native composition used.",
                    findings: [],
                  })
                : "",
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        },
      );

      expect(result.observedTools).toEqual(["glob", "grep", "read"]);
      expect(result).not.toHaveProperty("toolReceipts");
      expect(result.isolationReport).toMatchObject({
        backend: "docker",
        extensionProfile: "none",
        repoToolsEnabled: true,
      });
      expect(proxyOptions).toMatchObject({
        apiKey: "controller-real-key",
        allowWebSearch: true,
        webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
      });
      expect(captured?.args).toContain(CONTAINER_NATIVE_LAUNCHER);
      expect(captured?.args).not.toContain(CONTAINER_LAUNCHER);
      expect(captured?.args.join("\u0000")).not.toContain("action-policy.mjs");
      expect(captured?.args.join("\u0000")).not.toContain("action-workspace.mjs");
      expect(captured?.args).toContain("DEEPSEEK_API_KEY=ephemeral-worker-token");
      const workerLaunch = [captured?.command ?? "", ...(captured?.args ?? [])].join("\u0000");
      const workerEnvironment = Object.values(captured?.env ?? {}).join("\u0000");
      for (const controllerCredential of [
        "controller-real-key",
        realGitHubToken,
        environmentDeepSeekKey,
      ]) {
        expect(workerLaunch).not.toContain(controllerCredential);
        expect(workerEnvironment).not.toContain(controllerCredential);
      }
      expect(captured?.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(captured?.env.DEEPSEEK_API_KEY).toBe("ephemeral-worker-token");
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("gives a networked native MCP to the official graph and reports whole-worker authority", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const extensionCredential = "native-mcp-owned-secret";
    const realGitHubToken = "github-controller-secret";
    const plan = resolveNativeExtensionPlan({
      mcp: parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "remote",
              transport: "streamable-http",
              url: "https://mcp.example.test/rpc",
              credentialHeaders: { "X-Service": `Bearer ${extensionCredential}` },
              toolCallTimeoutMs: 8_000,
            },
          ],
        }),
      ),
      plugins: parseNativePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-read",
        allowed: true,
        reason: "native MCP runner test",
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
    const proxy = {
      ...fakeProxy(),
      workerWebSearchBaseUrl: "http://host.docker.internal:3456/anthropic/v1",
    };
    let captured: DshProcessSpec | undefined;

    try {
      const result = await runDsh(
        request({
          isolation: "docker",
          containerImage: PINNED_NODE_IMAGE,
          workspacePath: fixture.workspace,
          extensions: plan,
        }),
        {
          assetsDirectory: fixture.assets,
          environment: { PATH: process.env.PATH, GITHUB_TOKEN: realGitHubToken },
          runtime,
          composition: new NativeComposition(),
          startProxy: () => Promise.resolve(proxy),
          executeProcess: async (spec) => {
            const inspected = networkInspectResult(spec);
            if (inspected !== undefined) return inspected;
            const isNativeWorker = spec.args.includes(CONTAINER_NATIVE_LAUNCHER);
            if (isNativeWorker) {
              captured = spec;
              await writeFile(
                join(actionStateDirectory(spec), "native-observed-tools.jsonl"),
                `${JSON.stringify({
                  schemaVersion: 1,
                  source: "ctx.tools.schemas(agent)",
                  observedTools: ["read", "workflow", "mcp__remote__lookup"],
                })}\n`,
                { encoding: "utf8", flag: "a" },
              );
            }
            return {
              stdout: isNativeWorker
                ? JSON.stringify({
                    protocolVersion: 1,
                    operation: "review",
                    state: "final",
                    summary: "Native MCP composition used.",
                    findings: [],
                  })
                : "",
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        },
      );

      expect(result.observedTools).toContain("mcp__remote__lookup");
      expect(result).not.toHaveProperty("toolReceipts");
      expect(result).not.toHaveProperty("effectiveTools");
      expect(result.extensionAudit).toMatchObject({
        profile: "headless-native",
        workerNetwork: true,
        entries: [{ id: "remote", inventoryOwner: "dsh", requestsNetwork: true }],
      });
      expect(JSON.stringify(result.extensionAudit)).not.toContain(extensionCredential);
      expect(result.isolationReport).toMatchObject({
        networkIsolated: false,
        workspaceAccess: "read-only",
        extensionProfile: "headless-native",
      });
      expect(result.isolationReport.limitations.join(" ")).toMatch(
        /entire native worker.*share that egress path/iu,
      );
      expect(captured?.args).toContain("bridge");
      expect(captured?.args).toContain(`${fixture.workspace}:/workspace:ro`);
      const launch = [captured?.command ?? "", ...(captured?.args ?? [])].join("\0");
      expect(launch).not.toContain(realGitHubToken);
      expect(launch).not.toContain("controller-real-key");
      expect(await readFile(join(runtime.packageRoot, "cordis.patch.yml"), "utf8")).toContain(
        extensionCredential,
      );
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("mounts the whole native worker read-write only under trusted-write authority", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const plan = resolveNativeExtensionPlan({
      mcp: parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "writer",
              transport: "stdio",
              command: "writer-mcp",
              workspaceWrite: true,
            },
          ],
        }),
      ),
      plugins: parseNativePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-write",
        allowed: true,
        reason: "native write runner test",
        capabilities: {
          readRepository: true,
          readCi: false,
          publishComments: true,
          executeRepositoryCode: true,
          loadExtensions: true,
          accessNetwork: true,
          modifyWorkspace: true,
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
    const proxy = {
      ...fakeProxy(),
      workerWebSearchBaseUrl: "http://host.docker.internal:3456/anthropic/v1",
    };
    let captured: DshProcessSpec | undefined;

    try {
      const result = await runDsh(
        request({
          isolation: "docker",
          trust: "trusted-write",
          containerImage: PINNED_NODE_IMAGE,
          workspacePath: fixture.workspace,
          extensions: plan,
          nativeTools: [],
        }),
        {
          assetsDirectory: fixture.assets,
          environment: { PATH: process.env.PATH },
          runtime,
          composition: new NativeComposition(),
          startProxy: () => Promise.resolve(proxy),
          executeProcess: async (spec) => {
            const inspected = networkInspectResult(spec);
            if (inspected !== undefined) return inspected;
            const isNativeWorker = spec.args.includes(CONTAINER_NATIVE_LAUNCHER);
            if (isNativeWorker) {
              captured = spec;
              await writeFile(
                join(actionStateDirectory(spec), "native-observed-tools.jsonl"),
                `${JSON.stringify({
                  schemaVersion: 1,
                  source: "ctx.tools.schemas(agent)",
                  observedTools: ["read", "write", "mcp__writer__apply"],
                })}\n`,
                { encoding: "utf8", flag: "a" },
              );
            }
            return {
              stdout: isNativeWorker
                ? JSON.stringify({
                    protocolVersion: 1,
                    operation: "review",
                    state: "final",
                    summary: "Native write composition used.",
                    findings: [],
                  })
                : "",
              stderr: "",
              exitCode: 0,
              signal: null,
            };
          },
        },
      );

      expect(result.isolationReport).toMatchObject({
        networkIsolated: true,
        workspaceAccess: "read-write",
        extensionProfile: "headless-native",
      });
      expect(result.extensionAudit).toMatchObject({
        entries: [{ id: "writer", requestsWorkspaceWrite: true }],
      });
      expect(captured?.args).toContain(`${fixture.workspace}:/workspace:rw`);
      const networkIndex = captured?.args.indexOf("--network") ?? -1;
      expect(captured?.args[networkIndex + 1]).toMatch(/^dsh-action-internal-/u);
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("fails native host and controlled-shaped extension launches before proxy or execution", async () => {
    const fixture = await fixtures();
    const startProxy = vi.fn();
    const executeProcess = vi.fn();
    const composition = new NativeComposition();

    await expect(
      runDsh(
        request({
          isolation: "none",
          workspacePath: fixture.workspace,
          dshExecutable: fixture.executable,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          composition,
          startProxy,
          executeProcess,
        },
      ),
    ).rejects.toBeInstanceOf(DshIsolationUnavailableError);

    const extensions = resolveExtensionPlan({
      allowedTools: ["mcp.remote.search"],
      mcp: parseMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "remote",
              transport: "streamable-http",
              url: "https://mcp.example.test/rpc",
              tools: [
                {
                  id: "search",
                  name: "search",
                  description: "Search",
                  permissions: ["read", "network"],
                },
              ],
            },
          ],
        }),
      ),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-read",
        allowed: true,
        reason: "test",
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
    await expect(
      runDsh(
        request({
          isolation: "docker",
          containerImage: PINNED_NODE_IMAGE,
          workspacePath: fixture.workspace,
          extensions,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          composition,
          startProxy,
          executeProcess,
        },
      ),
    ).rejects.toThrow(/definition-only headless-native extension plan/u);

    expect(startProxy).not.toHaveBeenCalled();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("rejects an ambient Controller credential aliased into native extension config", async () => {
    const fixture = await fixtures();
    const ambientGitHubCredential = "ambient-gh-controller-secret";
    const extensions = resolveNativeExtensionPlan({
      mcp: parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "alias",
              transport: "stdio",
              command: "alias-mcp",
              env: { EXT_VALUE: ambientGitHubCredential },
            },
          ],
        }),
      ),
      plugins: parseNativePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-read",
        allowed: true,
        reason: "ambient alias test",
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
    const startProxy = vi.fn();
    const executeProcess = vi.fn();

    await expect(
      runDsh(
        request({
          isolation: "docker",
          workspacePath: fixture.workspace,
          containerImage: PINNED_NODE_IMAGE,
          extensions,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          composition: new NativeComposition(),
          environment: { PATH: process.env.PATH, GH_TOKEN: ambientGitHubCredential },
          startProxy,
          executeProcess,
        },
      ),
    ).rejects.toThrow(/must not contain a controller credential/u);
    expect(startProxy).not.toHaveBeenCalled();
    expect(executeProcess).not.toHaveBeenCalled();
  });
});
