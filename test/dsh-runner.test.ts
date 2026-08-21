import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DshConfigurationError,
  DshIsolationUnavailableError,
  DshOutputLimitError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import type { DeepSeekProxyHandle } from "../src/dsh/proxy.js";
import {
  assertExtensionPackagesDoNotShadowRuntime,
  assertInstalledRuntimeInventoryUnchanged,
  assertSupportedDshVersion,
  executeBoundedDshProcess,
  installedTopLevelPackageInventory,
  runDsh,
} from "../src/dsh/runner.js";
import type {
  DshProcessLimits,
  DshProcessResult,
  DshProcessSpec,
  DshRunRequest,
} from "../src/dsh/runner.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";

const temporaryPaths: string[] = [];
const PINNED_NODE_IMAGE = `node@sha256:${"a".repeat(64)}`;
const CONTAINER_PACKAGE_ROOT = "/opt/dsh-action/package";
const CONTAINER_LAUNCHER = "/opt/dsh-action/package/action-launcher.mjs";

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

async function fixtures(): Promise<{
  root: string;
  workspace: string;
  assets: string;
  executable: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-runner-test-"));
  temporaryPaths.push(root);
  const workspace = join(root, "workspace");
  const assets = join(root, "assets");
  await import("node:fs/promises").then(async ({ mkdir }) => {
    await mkdir(workspace);
    await mkdir(assets);
  });
  await writeFile(join(assets, "strict-untrusted.patch.yml"), "[]\n");
  await writeFile(join(assets, "trusted-read.patch.yml"), "[]\n");
  await writeFile(join(assets, "trusted-write.patch.yml"), "[]\n");
  await writeFile(join(assets, "action-policy.mjs"), "export default class ActionPolicy {}\n");
  await writeFile(
    join(assets, "action-workspace.mjs"),
    "export default class ActionWorkspace {}\n",
  );
  await writeFile(join(assets, "action-launcher.mjs"), "export default async function main() {}\n");
  const executable = join(root, "bin.js");
  await writeFile(executable, "");
  return { root, workspace, assets, executable };
}

function request(overrides: Partial<DshRunRequest>): DshRunRequest {
  return {
    operation: "review",
    prompt: "review packet",
    trust: "trusted-read",
    isolation: "none",
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    apiKey: "controller-real-key",
    baseUrl: "https://api.deepseek.com",
    dshVersion: "0.1.0-rc.8",
    containerImage: "node:24-bookworm",
    ...overrides,
  };
}

function fakeProxy(): DeepSeekProxyHandle & { readonly closeMock: ReturnType<typeof vi.fn> } {
  const closeMock = vi.fn(() => Promise.resolve());
  return {
    workerBaseUrl: "http://127.0.0.1:3456",
    workerToken: "ephemeral-worker-token",
    boundHost: "127.0.0.1",
    port: 3456,
    close: closeMock,
    closeMock,
  };
}

function networkInspectResult(spec: DshProcessSpec): DshProcessResult | undefined {
  return spec.args[1] === "inspect"
    ? { stdout: "172.30.0.1\n", stderr: "", exitCode: 0, signal: null }
    : undefined;
}

function actionStateDirectory(spec: DshProcessSpec): string {
  const suffix = ":/dsh-home/action-state:rw";
  const mount = spec.args.find((argument) => argument.endsWith(suffix));
  if (mount === undefined) throw new Error("missing action-state mount");
  return mount.slice(0, -suffix.length);
}

describe("executeBoundedDshProcess", () => {
  const spec = (source: string): DshProcessSpec => ({
    command: process.execPath,
    args: ["--eval", source],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
  });
  const limits = (overrides: Partial<DshProcessLimits> = {}): DshProcessLimits => ({
    // A saturated Windows worker can take several seconds just to start a child
    // Node process during the full coverage run. Keep the production timeout
    // behavior covered by the explicit 50 ms case below.
    timeoutMs: 10_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    maxCombinedBytes: 2_048,
    killGraceMs: 50,
    ...overrides,
  });

  it("captures stdout and stderr", async () => {
    const result = await executeBoundedDshProcess(
      spec('process.stdout.write("ok"); process.stderr.write("note")'),
      limits(),
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", stderr: "note" });
  });

  it("fails closed on timeout even when a process handles SIGTERM", async () => {
    await expect(
      executeBoundedDshProcess(
        spec('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000)'),
        limits({ timeoutMs: 50 }),
      ),
    ).rejects.toBeInstanceOf(DshTimeoutError);
  }, 15_000);

  it("kills on stdout and aggregate output caps", async () => {
    await expect(
      executeBoundedDshProcess(
        spec('process.stdout.write("x".repeat(200))'),
        limits({ maxStdoutBytes: 100 }),
      ),
    ).rejects.toBeInstanceOf(DshOutputLimitError);
    await expect(
      executeBoundedDshProcess(
        spec('process.stdout.write("x".repeat(80)); process.stderr.write("y".repeat(80))'),
        limits({ maxCombinedBytes: 100 }),
      ),
    ).rejects.toBeInstanceOf(DshOutputLimitError);
  });
});

describe("runDsh", () => {
  it("prevents extension installation from shadowing the locked runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-runtime-inventory-test-"));
    temporaryPaths.push(root);
    const packageRoot = join(root, "package");
    await mkdir(join(packageRoot, "node_modules", "zod"), { recursive: true });
    await mkdir(join(packageRoot, "node_modules", "@scope", "stable"), { recursive: true });
    await writeFile(
      join(packageRoot, "node_modules", "zod", "package.json"),
      '{"name":"zod","version":"4.4.3"}\n',
    );
    await writeFile(
      join(packageRoot, "node_modules", "@scope", "stable", "package.json"),
      '{"name":"@scope/stable","version":"1.2.3"}\n',
    );
    const baseline = await installedTopLevelPackageInventory(packageRoot);
    expect(baseline).toEqual({ zod: "4.4.3", "@scope/stable": "1.2.3" });
    expect(() =>
      assertExtensionPackagesDoNotShadowRuntime(
        { packageDependencies: { zod: "4.4.3" } },
        baseline,
      ),
    ).toThrow(/shadow a Controller-owned runtime dependency/u);
    expect(() =>
      assertInstalledRuntimeInventoryUnchanged(baseline, {
        zod: "4.5.0",
        "@scope/stable": "1.2.3",
      }),
    ).toThrow(/changed runtime package zod/u);
  });

  it("binds policy patches to the audited DSH version", () => {
    expect(() => assertSupportedDshVersion("0.1.0-rc.8")).not.toThrow();
    expect(() => assertSupportedDshVersion("latest")).toThrow(/exact semver/u);
    expect(() => assertSupportedDshVersion("0.1.0-rc.6")).toThrow(/no audited/u);
  });

  it("adapts the orchestrator seam, parses output, and keeps controller secrets out of worker env/argv", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const output = {
      protocolVersion: 1,
      operation: "review",
      state: "final",
      summary: "Looks sound.",
      findings: [],
    };
    const result = await runDsh(
      request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        environment: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: "github-secret",
          DEEPSEEK_API_KEY: "environment-real-key",
        },
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          captured = spec;
          return Promise.resolve({
            stdout: JSON.stringify(output),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(result.output).toEqual(output);
    expect(result.isolationReport).toMatchObject({
      backend: "none",
      credentialMediated: true,
      repoToolsEnabled: false,
      networkIsolated: false,
    });
    expect(captured?.args.slice(0, 6)).toEqual([
      "--expose-internals",
      fixture.executable,
      "--profile",
      "headless",
      "--patch",
      join(fixture.assets, "strict-untrusted.patch.yml"),
    ]);
    expect(captured?.args.join(" ")).not.toContain("controller-real-key");
    expect(Object.values(captured?.env ?? {})).not.toContain("controller-real-key");
    expect(captured?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(captured?.env.DEEPSEEK_API_KEY).toBe("ephemeral-worker-token");
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

  it("requires Docker for untrusted work", async () => {
    await expect(runDsh(request({ trust: "untrusted" }))).rejects.toBeInstanceOf(
      DshIsolationUnavailableError,
    );
  });

  it("requires Docker for trusted writes", async () => {
    await expect(
      runDsh(request({ operation: "fix", trust: "trusted-write" })),
    ).rejects.toBeInstanceOf(DshIsolationUnavailableError);
  });

  it.each(["--privileged", "--network=host", " node:24-bookworm", "node:24 bookworm"])(
    "rejects a Docker option or malformed image reference %s for read-only workers",
    async (containerImage) => {
      const startProxy = vi.fn();
      const executeProcess = vi.fn();
      await expect(
        runDsh(request({ isolation: "docker", containerImage }), { startProxy, executeProcess }),
      ).rejects.toBeInstanceOf(DshConfigurationError);
      expect(startProxy).not.toHaveBeenCalled();
      expect(executeProcess).not.toHaveBeenCalled();
    },
  );

  it.each([
    "node:24-bookworm",
    `node@sha256:${"a".repeat(63)}`,
    `node@sha256:${"A".repeat(64)}`,
    `node@@sha256:${"a".repeat(64)}`,
    ` node@sha256:${"a".repeat(64)}`,
  ])("rejects mutable or malformed trusted-write image %s", async (containerImage) => {
    const startProxy = vi.fn();
    const executeProcess = vi.fn();
    await expect(
      runDsh(
        request({
          operation: "fix",
          trust: "trusted-write",
          isolation: "docker",
          containerImage,
        }),
        { startProxy, executeProcess },
      ),
    ).rejects.toBeInstanceOf(DshConfigurationError);
    expect(startProxy).not.toHaveBeenCalled();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("counts proxy startup and process execution against one overall deadline", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const clock = vi
      .fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_375)
      .mockReturnValueOnce(1_500);
    let limitsSeen: DshProcessLimits | undefined;
    await runDsh(
      request({
        workspacePath: fixture.workspace,
        dshExecutable: fixture.executable,
        timeoutMs: 1_000,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        now: clock,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (_spec, limits) => {
          limitsSeen = limits;
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
    expect(limitsSeen?.timeoutMs).toBe(625);
  });

  it("rejects model output containing a known controller credential", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    await expect(
      runDsh(request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }), {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "review",
              state: "final",
              summary: "controller-real-key",
              findings: [],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          }),
      }),
    ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
  });

  it.each(["path-secret", "query-secret", "header-secret"])(
    "rejects DSH output containing an MCP endpoint or header secret: %s",
    async (leakedSecret) => {
      const fixture = await fixtures();
      const proxy = fakeProxy();
      const extensions = resolveExtensionPlan({
        allowedTools: ["mcp.remote.search"],
        mcp: parseMcpConfiguration(
          JSON.stringify({
            schemaVersion: 1,
            servers: [
              {
                id: "remote",
                transport: "streamable-http",
                url: "https://mcp.example.test/rpc/path-secret?token=query-secret",
                headers: { Authorization: "Bearer header-secret" },
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
          },
        },
      });
      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation: "docker",
            containerImage: PINNED_NODE_IMAGE,
            extensions,
          }),
          {
            assetsDirectory: fixture.assets,
            temporaryDirectory: fixture.root,
            startProxy: () => Promise.resolve(proxy),
            executeProcess: (spec) =>
              Promise.resolve(
                spec.args.includes(CONTAINER_LAUNCHER)
                  ? {
                      stdout: JSON.stringify({
                        protocolVersion: 1,
                        operation: "review",
                        state: "final",
                        summary: "Done.",
                        findings: [],
                      }),
                      stderr: `MCP connection failed at ${leakedSecret}`,
                      exitCode: 0,
                      signal: null,
                    }
                  : { stdout: "", stderr: "", exitCode: 0, signal: null },
              ),
          },
        ),
      ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
    },
  );

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

  it("builds a hardened Docker argv around the locked github-action Profile", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    let copiedLauncher: string | undefined;
    const observedSpecs: DshProcessSpec[] = [];
    const result = await runDsh(
      request({
        operation: "fix",
        trust: "trusted-write",
        isolation: "docker",
        containerImage: PINNED_NODE_IMAGE,
        workspacePath: fixture.workspace,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: (options) => {
          expect(options.bindHost).toBe("0.0.0.0");
          expect(options.workerHost).toBe("172.30.0.1");
          return Promise.resolve(proxy);
        },
        executeProcess: async (spec) => {
          observedSpecs.push(spec);
          if (spec.args[1] === "inspect") {
            return Promise.resolve({
              stdout: "172.30.0.1\n",
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          }
          if (!spec.args.includes(CONTAINER_LAUNCHER)) {
            return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
          }
          captured = spec;
          const packageMount = spec.args.find((argument) =>
            argument.endsWith(`:${CONTAINER_PACKAGE_ROOT}:ro`),
          );
          if (packageMount === undefined) throw new Error("missing package-root mount");
          copiedLauncher = await readFile(
            join(
              packageMount.slice(0, -`:${CONTAINER_PACKAGE_ROOT}:ro`.length),
              "action-launcher.mjs",
            ),
            "utf8",
          );
          return Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "fix",
              state: "final",
              summary: "Fixed.",
              findings: [],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(observedSpecs).toHaveLength(5);
    const installSpec = observedSpecs[0];
    const createNetworkSpec = observedSpecs[1];
    const inspectNetworkSpec = observedSpecs[2];
    const removeNetworkSpec = observedSpecs[4];
    const internalNetwork = createNetworkSpec?.args.at(-1);
    expect(installSpec?.args).toContain("ci");
    expect(installSpec?.args).toContain("--ignore-scripts");
    expect(installSpec?.args).toContain("--omit=dev");
    expect(installSpec?.args).toContain("--no-audit");
    expect(installSpec?.args).toContain("4g");
    expect(installSpec?.args).toContain("NODE_OPTIONS=--max-old-space-size=3072");
    expect(installSpec?.args.some((argument) => argument.includes("@deepseek-ai/dsh@"))).toBe(
      false,
    );
    expect(createNetworkSpec?.args.slice(0, 3)).toEqual(["network", "create", "--internal"]);
    expect(inspectNetworkSpec?.args.slice(0, 4)).toEqual([
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ]);
    expect(removeNetworkSpec?.args).toEqual(["network", "rm", internalNetwork]);
    expect(captured?.command).toBe("docker");
    expect(captured?.args).toContain("--read-only");
    expect(captured?.args).toContain("--user");
    expect(captured?.args).toContain("no-new-privileges");
    expect(captured?.args).toContain(PINNED_NODE_IMAGE);
    expect(captured?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(captured?.env).not.toHaveProperty("GH_TOKEN");
    expect(Object.values(captured?.env ?? {})).not.toContain("controller-real-key");
    expect(captured?.args.some((argument) => argument.includes("controller-real-key"))).toBe(false);
    expect(captured?.args).toContain(`${fixture.workspace}:/workspace:rw`);
    expect(captured?.args).toContain(
      `${join(fixture.assets, "action-policy.mjs")}:/opt/dsh-action/action-policy.mjs:ro`,
    );
    expect(captured?.args).toContain(
      `${join(fixture.assets, "action-workspace.mjs")}:/opt/dsh-action/action-workspace.mjs:ro`,
    );
    expect(captured?.args).not.toContain(
      `${join(fixture.assets, "action-launcher.mjs")}:${CONTAINER_LAUNCHER}:ro`,
    );
    expect(copiedLauncher).toBe("export default async function main() {}\n");
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home:ro"))).toBe(true);
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/action-state:rw"))).toBe(
      true,
    );
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/sessions:rw"))).toBe(
      true,
    );
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/attachments:rw"))).toBe(
      true,
    );
    expect(
      captured?.args.some((argument) => argument.endsWith(":/dsh-home/profiles/github-action:ro")),
    ).toBe(true);
    expect(
      captured?.args.some((argument) => argument.endsWith(":/opt/dsh-action/package:ro")),
    ).toBe(true);
    expect(captured?.args).toContain(internalNetwork);
    expect(captured?.args).toContain("host.docker.internal:172.30.0.1");
    expect(captured?.args).not.toContain("--profile");
    expect(captured?.args).not.toContain("--patch");
    expect(captured?.args).toContain(CONTAINER_LAUNCHER);
    expect(captured?.args).not.toContain(
      "/opt/dsh-action/package/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    expect(captured?.args).toContain("--expose-internals");
    expect(captured?.args).toContain("HOME=/dsh-home");
    expect(captured?.args).toContain("DSH_HOME=/dsh-home");
    expect(captured?.args).toContain("npm_config_cache=/tmp/npm-cache");
    expect(captured?.args).toContain("DSH_PERMISSION_MODE=workspace-write");
    expect(captured?.args).toContain("DEEPSEEK_API_KEY=ephemeral-worker-token");
    expect(captured?.args).not.toContain("npx");
    expect(captured?.termination).toMatchObject({ command: "docker" });
    expect(result.isolationReport).toMatchObject({
      networkIsolated: true,
      extensionProfile: "github-action",
    });
  });

  it("enables only read/search tools for trusted Docker reviews", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const observedSpecs: DshProcessSpec[] = [];
    const result = await runDsh(
      request({ isolation: "docker", workspacePath: fixture.workspace }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          observedSpecs.push(spec);
          if (spec.args[1] === "inspect") {
            return Promise.resolve({
              stdout: "172.30.0.1\n",
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          }
          const isDsh = spec.args.includes(CONTAINER_LAUNCHER);
          if (isDsh) captured = spec;
          return Promise.resolve({
            stdout: isDsh
              ? JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: "Done.",
                  findings: [],
                })
              : "",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );
    expect(result.isolationReport.repoToolsEnabled).toBe(true);
    expect(result.isolationReport.workspaceAccess).toBe("read-only");
    expect(result.isolationReport.networkIsolated).toBe(true);
    expect(result.isolationReport.extensionProfile).toBe("github-action");
    expect(captured?.args).toContain(`${fixture.workspace}:/workspace:ro`);
    const createNetworkSpec = observedSpecs.find(
      (spec) => spec.args[0] === "network" && spec.args[1] === "create",
    );
    expect(createNetworkSpec?.args).toContain("--internal");
    expect(captured?.args).toContain(createNetworkSpec?.args.at(-1));
    expect(captured?.args).toContain(CONTAINER_LAUNCHER);
    expect(captured?.args).not.toContain("--profile");
  });

  it("resolves the launcher and policy plugins from the action package instead of the caller workspace", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const callerWorkspace = join(fixture.root, "caller-workspace");
    const callerAssets = join(callerWorkspace, "assets", "dsh");
    await mkdir(callerAssets, { recursive: true });
    await writeFile(join(callerAssets, "action-policy.mjs"), "malicious caller policy\n");
    await writeFile(join(callerAssets, "action-workspace.mjs"), "malicious caller workspace\n");
    await writeFile(join(callerAssets, "action-launcher.mjs"), "malicious caller launcher\n");
    vi.spyOn(process, "cwd").mockReturnValue(callerWorkspace);
    let captured: DshProcessSpec | undefined;
    let copiedLauncher: string | undefined;

    await runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
      temporaryDirectory: fixture.root,
      environment: { PATH: process.env.PATH, GITHUB_ACTION_PATH: callerWorkspace },
      startProxy: () => Promise.resolve(proxy),
      executeProcess: async (spec) => {
        if (spec.args[1] === "inspect") {
          return Promise.resolve({
            stdout: "172.30.0.1\n",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        }
        const isDsh = spec.args.includes(CONTAINER_LAUNCHER);
        if (isDsh) {
          captured = spec;
          const packageMount = spec.args.find((argument) =>
            argument.endsWith(`:${CONTAINER_PACKAGE_ROOT}:ro`),
          );
          if (packageMount === undefined) throw new Error("missing package-root mount");
          copiedLauncher = await readFile(
            join(
              packageMount.slice(0, -`:${CONTAINER_PACKAGE_ROOT}:ro`.length),
              "action-launcher.mjs",
            ),
            "utf8",
          );
        }
        return Promise.resolve({
          stdout: isDsh
            ? JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "Done.",
                findings: [],
              })
            : "",
          stderr: "",
          exitCode: 0,
          signal: null,
        });
      },
    });

    const packagedPolicy = fileURLToPath(
      new URL("../assets/dsh/action-policy.mjs", import.meta.url),
    );
    const packagedWorkspace = fileURLToPath(
      new URL("../assets/dsh/action-workspace.mjs", import.meta.url),
    );
    const packagedLauncher = fileURLToPath(
      new URL("../assets/dsh/action-launcher.mjs", import.meta.url),
    );
    expect(captured?.args).toContain(`${packagedPolicy}:/opt/dsh-action/action-policy.mjs:ro`);
    expect(captured?.args).toContain(
      `${packagedWorkspace}:/opt/dsh-action/action-workspace.mjs:ro`,
    );
    expect(captured?.args).not.toContain(`${packagedLauncher}:${CONTAINER_LAUNCHER}:ro`);
    await expect(readFile(packagedLauncher, "utf8")).resolves.toBe(copiedLauncher);
    expect(captured?.args.join(" ")).not.toContain(callerWorkspace);
  });
});
