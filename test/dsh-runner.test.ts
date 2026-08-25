import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DshAbortedError,
  DshConfigurationError,
  DshCredentialLeakError,
  DshIsolationUnavailableError,
  DshOutputLimitError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import type { DeepSeekProxyHandle, DeepSeekProxyOptions } from "../src/dsh/proxy.js";
import type {
  DshComposition,
  PreparedDockerDshComposition,
  RunDshCompositionPreparation,
} from "../src/dsh/composition.js";
import { NativeComposition } from "../src/dsh/native-composition.js";
import {
  assertExtensionPackagesDoNotShadowRuntime,
  assertInstalledRuntimeInventoryUnchanged,
  assertSupportedDshVersion,
  createDshRuntime,
  disposeDshRuntime,
  executeBoundedDshProcess,
  installedTopLevelPackageInventory,
  runDsh,
} from "../src/dsh/runner.js";
import { parseTaskOutputSchema } from "../src/dsh/task-output.js";
import type {
  DshProcessLimits,
  DshProcessResult,
  DshProcessSpec,
  DshRunRequest,
} from "../src/dsh/runner.js";
import { PHASE_TIMEOUTS } from "../src/dsh/timeouts.js";
import { resolveExtensionPlan, resolveNativeExtensionPlan } from "../src/extensions/plan.js";
import {
  parseMcpConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
  parsePluginConfiguration,
} from "../src/extensions/schema.js";

const temporaryPaths: string[] = [];
const PINNED_NODE_IMAGE = `node@sha256:${"a".repeat(64)}`;
const CONTAINER_PACKAGE_ROOT = "/opt/dsh-action/package";
const CONTAINER_LAUNCHER = "/opt/dsh-action/package/action-launcher.mjs";
const CONTAINER_NATIVE_LAUNCHER = "/opt/dsh-action/package/native-launcher.mjs";

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
  await writeFile(join(assets, "native-launcher.mjs"), "export default async function main() {}\n");
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
    webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
    dshVersion: "0.1.1-rc.2",
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

  it("terminates the process tree when the run is cancelled", async () => {
    const controller = new AbortController();
    const execution = executeBoundedDshProcess(
      spec('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000)'),
      limits({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 25);
    await expect(execution).rejects.toBeInstanceOf(DshAbortedError);
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
  it("passes the trusted task schema to the prompt and returns only Controller-validated taskOutput", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const taskOutputSchema = parseTaskOutputSchema(
      JSON.stringify({
        type: "object",
        properties: { status: { type: "string", enum: ["ready"] } },
        required: ["status"],
        additionalProperties: false,
      }),
    );
    if (taskOutputSchema === undefined) throw new Error("expected task output schema");
    const result = await runDsh(
      request({
        operation: "task",
        workspacePath: fixture.workspace,
        dshExecutable: fixture.executable,
        taskOutputSchema,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          captured = spec;
          return Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "task",
              state: "final",
              summary: "Complete",
              findings: [],
              taskOutput: { status: "ready" },
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(result.output.taskOutput).toEqual({ status: "ready" });
    expect(captured?.args.join("\n")).toContain("TRUSTED_TASK_OUTPUT_SCHEMA_JSON");
  });

  it("fails closed if a direct caller places a Controller credential in the task schema", async () => {
    const fixture = await fixtures();
    const taskOutputSchema = parseTaskOutputSchema(
      JSON.stringify({ type: "object", description: "controller-real-key" }),
    );
    if (taskOutputSchema === undefined) throw new Error("expected task output schema");
    await expect(
      runDsh(
        request({
          operation: "task",
          workspacePath: fixture.workspace,
          dshExecutable: fixture.executable,
          taskOutputSchema,
        }),
        { assetsDirectory: fixture.assets, temporaryDirectory: fixture.root },
      ),
    ).rejects.toBeInstanceOf(DshCredentialLeakError);
  });

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
    expect(() => assertSupportedDshVersion("0.1.1-rc.2")).not.toThrow();
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

  it("uses the DshComposition boundary for launch artifacts and runtime identity", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const proxy = fakeProxy();
    const customPatchPath = join(fixture.root, "composition.patch.yml");
    const customToolPolicyPath = join(fixture.root, "composition-tool-policy.patch.yml");
    await writeFile(customPatchPath, "[]\n");
    await writeFile(customToolPolicyPath, "[]\n");
    const prepare = vi.fn(() =>
      Promise.resolve({
        isolation: "none" as const,
        launchPlan: {
          command: process.execPath,
          args: ["--custom-composition", customPatchPath, customToolPolicyPath],
          cwd: fixture.workspace,
        },
      }),
    );
    const runtimeToolNames = vi.fn(() => ["read"]);
    const composition = {
      id: "test-composition",
      toolPolicyOwner: "controller",
      profileSchemaVersion: 7,
      actionManagedExtensionProfile: true,
      extensionPlanProfile: "github-action",
      assertCompatible: vi.fn(),
      promptToolPolicy: vi.fn(() => ({ policyOwner: "controller" as const, nativeTools: [] })),
      runtimeToolNames,
      requiresWebSearchProxy: vi.fn(() => false),
      isolationMetadata: vi.fn(() => ({
        repoToolsEnabled: false,
        extensionProfile: "none" as const,
        limitations: [],
      })),
      prepare,
    } satisfies DshComposition;
    let captured: DshProcessSpec | undefined;

    try {
      await runDsh(
        request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }),
        {
          assetsDirectory: fixture.assets,
          environment: { PATH: process.env.PATH },
          runtime,
          composition,
          startProxy: () => Promise.resolve(proxy),
          executeProcess: (spec) => {
            captured = spec;
            return Promise.resolve({
              stdout: JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "Composed.",
                findings: [],
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          },
        },
      );

      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "none",
          assetsDirectory: fixture.assets,
          runtime,
          nativeTools: [],
        }),
      );
      expect(captured?.args).toContain(customPatchPath);
      expect(captured?.args).toContain(customToolPolicyPath);
      expect(runtimeToolNames).toHaveBeenCalledWith([]);
      expect(runtime.binding?.binding).toMatchObject({
        compositionId: "test-composition",
        profileSchemaVersion: 7,
        nativeRuntimeTools: ["read"],
      });
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("uses prepared Docker composition paths and its post-install finalizer", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const proxy = fakeProxy();
    const customPolicyPath = join(fixture.root, "custom-policy.mjs");
    const customWorkspacePath = join(fixture.root, "custom-workspace.mjs");
    const customLauncherSource = join(fixture.root, "custom-entry.mjs");
    await Promise.all([
      writeFile(customPolicyPath, "export default class CustomPolicy {}\n"),
      writeFile(customWorkspacePath, "export default class CustomWorkspace {}\n"),
      writeFile(customLauncherSource, "export default async function customEntry() {}\n"),
    ]);
    const postInstallPreparation = vi.fn();
    const finalizeAfterInstall = vi.fn(
      (runPreparation: RunDshCompositionPreparation): Promise<PreparedDockerDshComposition> =>
        runPreparation(() => {
          postInstallPreparation();
          return Promise.resolve(prepared);
        }),
    );
    const prepared: PreparedDockerDshComposition = {
      isolation: "docker",
      launchPlan: {
        command: "node",
        args: ["/opt/custom/custom-entry.mjs"],
        workdir: "/workspace",
        mounts: [
          {
            sourcePath: customLauncherSource,
            destinationPath: "/opt/custom/custom-entry.mjs",
            readOnly: true,
          },
          {
            sourcePath: customPolicyPath,
            destinationPath: "/opt/dsh-action/action-policy.mjs",
            readOnly: true,
          },
          {
            sourcePath: customWorkspacePath,
            destinationPath: "/opt/dsh-action/action-workspace.mjs",
            readOnly: true,
          },
        ],
      },
      finalizeAfterInstall,
    };
    const prepare = vi.fn(() => Promise.resolve(prepared));
    const composition = {
      id: "test-docker-composition",
      toolPolicyOwner: "controller",
      profileSchemaVersion: 9,
      actionManagedExtensionProfile: true,
      extensionPlanProfile: "github-action",
      assertCompatible: vi.fn(),
      promptToolPolicy: vi.fn(() => ({
        policyOwner: "controller" as const,
        nativeTools: ["workspace.read", "workspace.search"] as const,
      })),
      runtimeToolNames: vi.fn(() => ["glob", "grep", "read", "read_image"]),
      requiresWebSearchProxy: vi.fn(() => false),
      isolationMetadata: vi.fn(() => ({
        repoToolsEnabled: true,
        extensionProfile: "github-action" as const,
        limitations: [],
      })),
      prepare,
    } satisfies DshComposition;
    let captured: DshProcessSpec | undefined;

    try {
      await runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
        assetsDirectory: fixture.assets,
        environment: { PATH: process.env.PATH },
        runtime,
        composition,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          const inspect = networkInspectResult(spec);
          if (inspect !== undefined) return Promise.resolve(inspect);
          const isDsh = spec.args.includes("/opt/custom/custom-entry.mjs");
          if (isDsh) captured = spec;
          return Promise.resolve({
            stdout: isDsh
              ? JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: "Docker composition used.",
                  findings: [],
                })
              : "",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      });

      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "docker",
          assetsDirectory: fixture.assets,
          runtime,
          nativeTools: ["workspace.read", "workspace.search"],
        }),
      );
      expect(finalizeAfterInstall).toHaveBeenCalledOnce();
      expect(postInstallPreparation).toHaveBeenCalledOnce();
      expect(captured?.args).toContain(`${runtime.packageRoot}:${CONTAINER_PACKAGE_ROOT}:ro`);
      expect(captured?.args).toContain(`${customPolicyPath}:/opt/dsh-action/action-policy.mjs:ro`);
      expect(captured?.args).toContain(
        `${customWorkspacePath}:/opt/dsh-action/action-workspace.mjs:ro`,
      );
      expect(captured?.args).toContain(`${customLauncherSource}:/opt/custom/custom-entry.mjs:ro`);
      expect(captured?.args).toContain("/opt/custom/custom-entry.mjs");
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

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

  it.each(["none", "docker"] as const)(
    "rejects a Controller credential in the complete %s worker prompt before launch",
    async (isolation) => {
      const fixture = await fixtures();
      const controllerCredential = "ghs_controller-prompt-secret";
      const startProxy = vi.fn(() => Promise.resolve(fakeProxy()));
      const executeProcess = vi.fn();
      let failure: unknown;

      try {
        await runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation,
            ...(isolation === "none" ? { dshExecutable: fixture.executable } : {}),
            controllerCredentials: [controllerCredential],
            prompt: `review packet ${controllerCredential}`,
          }),
          {
            assetsDirectory: fixture.assets,
            temporaryDirectory: fixture.root,
            startProxy,
            executeProcess,
          },
        );
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
      expect(String(failure)).not.toContain(controllerCredential);
      expect(startProxy).not.toHaveBeenCalled();
      expect(executeProcess).not.toHaveBeenCalled();
    },
  );

  it.each(["none", "docker"] as const)(
    "rejects a Controller credential in the final %s worker argv/environment",
    async (isolation) => {
      const fixture = await fixtures();
      const proxy = fakeProxy();
      const workerExecutions: DshProcessSpec[] = [];

      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation,
            ...(isolation === "none" ? { dshExecutable: fixture.executable } : {}),
            // Exercise the final launch scanner by making an invalid proxy
            // capability collide with a Controller-owned credential.
            controllerCredentials: [proxy.workerToken],
          }),
          {
            assetsDirectory: fixture.assets,
            temporaryDirectory: fixture.root,
            startProxy: () => Promise.resolve(proxy),
            executeProcess: (spec) => {
              if (spec.args.includes(CONTAINER_LAUNCHER)) workerExecutions.push(spec);
              return Promise.resolve(
                networkInspectResult(spec) ?? {
                  stdout: "",
                  stderr: "",
                  exitCode: 0,
                  signal: null,
                },
              );
            },
          },
        ),
      ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
      expect(workerExecutions).toHaveLength(0);
    },
  );

  it("rejects an explicit Controller credential in stdout without echoing it", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const controllerCredential = "ghs_controller-stdout-secret";
    let failure: unknown;

    try {
      await runDsh(
        request({
          workspacePath: fixture.workspace,
          dshExecutable: fixture.executable,
          controllerCredentials: [controllerCredential],
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy: () => Promise.resolve(proxy),
          executeProcess: () =>
            Promise.resolve({
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
            }),
        },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
    expect(String(failure)).not.toContain(controllerCredential);
  });

  it("preserves a successful result when proxy cleanup rejects", async () => {
    const fixture = await fixtures();
    const warning = vi.fn();
    const close = vi.fn(() => Promise.reject(new Error("close failed")));
    const proxy = { ...fakeProxy(), close };

    await expect(
      runDsh(request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }), {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        warning,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: () =>
          Promise.resolve({
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
          }),
      }),
    ).resolves.toMatchObject({ output: { summary: "Done." } });
    expect(close).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("primary result was preserved"));
  });

  it("preserves the original execution failure when proxy cleanup rejects", async () => {
    const fixture = await fixtures();
    const warning = vi.fn();
    const primary = new DshTimeoutError(123);
    const close = vi.fn(() => Promise.reject(new Error("close failed")));
    let caught: unknown;

    try {
      await runDsh(
        request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          warning,
          startProxy: () => Promise.resolve({ ...fakeProxy(), close }),
          executeProcess: () => Promise.reject(primary),
        },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBe(primary);
    expect(close).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
  });

  it("hard-bounds proxy startup and closes a proxy that resolves after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const fixture = await fixtures();
      const proxy = fakeProxy();
      let resolveProxy: ((value: DeepSeekProxyHandle) => void) | undefined;
      let markStarted: (() => void) | undefined;
      const started = new Promise<void>((resolveStarted) => {
        markStarted = resolveStarted;
      });
      const running = runDsh(
        request({
          workspacePath: fixture.workspace,
          dshExecutable: fixture.executable,
          timeoutMs: 2 * PHASE_TIMEOUTS.setupMs,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy: () => {
            markStarted?.();
            return new Promise<DeepSeekProxyHandle>((resolve) => {
              resolveProxy = resolve;
            });
          },
          executeProcess: vi.fn(),
        },
      );

      await started;
      const outcome = expect(running).rejects.toBeInstanceOf(DshTimeoutError);
      await vi.advanceTimersByTimeAsync(PHASE_TIMEOUTS.setupMs);
      await outcome;
      resolveProxy?.(proxy);
      await vi.advanceTimersByTimeAsync(0);
      expect(proxy.closeMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts proxy startup and closes a proxy that resolves after cancellation", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const controller = new AbortController();
    const cancellation = new DshAbortedError();
    let resolveProxy: ((value: DeepSeekProxyHandle) => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const running = runDsh(
      request({
        workspacePath: fixture.workspace,
        dshExecutable: fixture.executable,
        timeoutMs: 2 * PHASE_TIMEOUTS.setupMs,
        signal: controller.signal,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => {
          markStarted?.();
          return new Promise<DeepSeekProxyHandle>((resolve) => {
            resolveProxy = resolve;
          });
        },
        executeProcess: vi.fn(),
      },
    );

    await started;
    controller.abort(cancellation);
    await expect(running).rejects.toBe(cancellation);
    resolveProxy?.(proxy);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(proxy.closeMock).toHaveBeenCalledOnce();
  });

  it("binds normalized workspace, chat endpoint, and host executable across reused turns", async () => {
    const fixture = await fixtures();
    const alternateWorkspace = join(fixture.root, "alternate-workspace");
    const alternateExecutable = join(fixture.root, "alternate-bin.js");
    await mkdir(alternateWorkspace);
    await writeFile(alternateExecutable, "");
    const runtime = await createDshRuntime(fixture.root);
    const executeProcess = (): Promise<DshProcessResult> =>
      Promise.resolve({
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
    const dependencies = {
      assetsDirectory: fixture.assets,
      runtime,
      startProxy: () => Promise.resolve(fakeProxy()),
      executeProcess,
    } as const;

    try {
      await runDsh(
        request({
          workspacePath: join(fixture.workspace, "."),
          dshExecutable: fixture.executable,
          baseUrl: "https://API.DEEPSEEK.COM:443/v1/?ignored=yes#fragment",
        }),
        dependencies,
      );

      expect(runtime.binding?.binding).toMatchObject({
        workspacePath: await realpath(fixture.workspace),
        chatBaseUrl: "https://api.deepseek.com/v1",
        dshExecutableIdentity: await realpath(fixture.executable),
      });
      expect(runtime.binding?.binding).not.toHaveProperty("webSearchBaseUrl");

      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            dshExecutable: fixture.executable,
            baseUrl: "https://api.deepseek.com/v1",
            webSearchBaseUrl: "https://changed-but-disabled.example.test/anthropic/v1",
          }),
          dependencies,
        ),
      ).resolves.toBeDefined();

      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            dshExecutable: fixture.executable,
            baseUrl: "https://chat.example.test/v1",
          }),
          dependencies,
        ),
      ).rejects.toThrow(/binding changed:.*chatBaseUrl/u);
      await expect(
        runDsh(
          request({
            workspacePath: alternateWorkspace,
            dshExecutable: fixture.executable,
            baseUrl: "https://api.deepseek.com/v1",
          }),
          dependencies,
        ),
      ).rejects.toThrow(/binding changed:.*workspacePath/u);
      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            dshExecutable: alternateExecutable,
            baseUrl: "https://api.deepseek.com/v1",
          }),
          dependencies,
        ),
      ).rejects.toThrow(/binding changed:.*dshExecutableIdentity/u);
    } finally {
      await disposeDshRuntime(runtime);
    }
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

  it("fails closed before execution when Bash would share bridge extension egress", async () => {
    const fixture = await fixtures();
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
                  permissions: ["read", "workspace-write", "network"],
                },
              ],
            },
          ],
        }),
      ),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
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
    });
    const startProxy = vi.fn();
    const executeProcess = vi.fn();

    await expect(
      runDsh(
        request({
          operation: "fix",
          trust: "trusted-write",
          isolation: "docker",
          containerImage: PINNED_NODE_IMAGE,
          workspacePath: fixture.workspace,
          nativeTools: ["native.bash"],
          extensions,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy,
          executeProcess,
        },
      ),
    ).rejects.toThrow(/native\.bash cannot share a worker with a bridge-networked extension/u);
    expect(startProxy).not.toHaveBeenCalled();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("counts proxy startup and process execution against one overall deadline", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let clock = 1_000;
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
        now: () => clock,
        startProxy: () => {
          clock = 1_375;
          return Promise.resolve(proxy);
        },
        executeProcess: (_spec, limits) => {
          limitsSeen = limits;
          clock = 1_500;
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

  it("applies independent setup and agent caps while forwarding the request signal", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const controller = new AbortController();
    const observed: { readonly spec: DshProcessSpec; readonly limits: DshProcessLimits }[] = [];
    let clock = 1_000;

    await runDsh(
      request({
        isolation: "docker",
        workspacePath: fixture.workspace,
        deadlineMs: clock + 20 * 60_000,
        timeoutMs: PHASE_TIMEOUTS.agentTurnMs,
        signal: controller.signal,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        now: () => clock,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec, limits) => {
          observed.push({ spec, limits });
          const inspected = networkInspectResult(spec);
          if (spec.args.includes("ci")) clock += 4 * 60_000;
          if (spec.args[0] === "network" && spec.args[1] === "create") clock += 60_000;
          if (inspected !== undefined) {
            clock += 60_000;
            return Promise.resolve(inspected);
          }
          const isDsh = spec.args.includes(CONTAINER_LAUNCHER);
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

    const runtimeInstall = observed.find(({ spec }) => spec.args.includes("ci"));
    const networkCreate = observed.find(
      ({ spec }) => spec.args[0] === "network" && spec.args[1] === "create",
    );
    const networkInspect = observed.find(({ spec }) => spec.args[1] === "inspect");
    const worker = observed.find(({ spec }) => spec.args.includes(CONTAINER_LAUNCHER));
    const networkCleanup = observed.find(
      ({ spec }) => spec.args[0] === "network" && spec.args[1] === "rm",
    );
    expect(runtimeInstall?.limits.timeoutMs).toBe(PHASE_TIMEOUTS.runtimeInstallMs);
    expect(networkCreate?.limits.timeoutMs).toBe(PHASE_TIMEOUTS.setupMs);
    expect(networkInspect?.limits.timeoutMs).toBe(PHASE_TIMEOUTS.setupMs);
    expect(worker?.limits.timeoutMs).toBe(PHASE_TIMEOUTS.agentTurnMs);
    for (const phase of [runtimeInstall, networkCreate, networkInspect, worker]) {
      expect(phase?.limits.signal).toBe(controller.signal);
    }
    expect(networkCleanup?.limits).toMatchObject({ timeoutMs: PHASE_TIMEOUTS.cleanupMs });
    expect(networkCleanup?.limits.signal).toBeUndefined();
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
    let controlledProfilePatch: string | undefined;
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
          controlledProfilePatch = await readFile(
            join(
              packageMount.slice(0, -`:${CONTAINER_PACKAGE_ROOT}:ro`.length),
              "cordis.patch.yml",
            ),
            "utf8",
          );
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
    const installerCacheMount = installSpec?.args.find((argument) =>
      argument.endsWith(":/tmp/npm-cache:rw"),
    );
    expect(installSpec?.args).toContain("ci");
    expect(installSpec?.args).toContain("--ignore-scripts");
    expect(installSpec?.args).toContain("--omit=dev");
    expect(installSpec?.args).toContain("--no-audit");
    expect(installSpec?.args).toContain("4g");
    expect(installSpec?.args).toContain("NODE_OPTIONS=--max-old-space-size=3072");
    expect(installSpec?.args.some((argument) => argument.includes("@deepseek-ai/dsh@"))).toBe(
      false,
    );
    expect(installerCacheMount).toBeDefined();
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
    expect(captured?.args).not.toContain(installerCacheMount);
    expect(captured?.args.some((argument) => argument.endsWith(":/tmp/npm-cache:rw"))).toBe(false);
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
    expect(controlledProfilePatch).toContain('"expectedOperation": "fix"');
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

  it("mediates web search through exact proxy options and worker-only proxy environment", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const proxy = {
      ...fakeProxy(),
      workerWebSearchBaseUrl: "http://host.docker.internal:3456/anthropic/v1",
    };
    let proxyOptions: DeepSeekProxyOptions | undefined;
    let captured: DshProcessSpec | undefined;

    await runDsh(
      request({
        isolation: "docker",
        workspacePath: fixture.workspace,
        nativeTools: ["workspace.read", "native.web-search"],
      }),
      {
        assetsDirectory: fixture.assets,
        runtime,
        startProxy: (options) => {
          proxyOptions = options;
          return Promise.resolve(proxy);
        },
        executeProcess: (spec) => {
          const inspected = networkInspectResult(spec);
          if (inspected !== undefined) return Promise.resolve(inspected);
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

    expect(proxyOptions).toMatchObject({
      apiKey: "controller-real-key",
      baseUrl: "https://api.deepseek.com",
      webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
      allowWebSearch: true,
      bindHost: "0.0.0.0",
      workerHost: "172.30.0.1",
    });
    expect(captured?.args).toContain(
      "DEEPSEEK_SEARCH_BASE_URL=http://host.docker.internal:3456/anthropic/v1",
    );
    expect(captured?.args.join(" ")).not.toContain("https://api.deepseek.com/anthropic/v1");
    expect(Object.values(captured?.env ?? {})).not.toContain("controller-real-key");
    expect(runtime.binding?.binding.webSearchBaseUrl).toBe("https://api.deepseek.com/anthropic/v1");

    await expect(
      runDsh(
        request({
          isolation: "docker",
          workspacePath: fixture.workspace,
          nativeTools: ["workspace.read", "native.web-search"],
          webSearchBaseUrl: "https://search.example.test/anthropic/v1",
        }),
        {
          assetsDirectory: fixture.assets,
          runtime,
          startProxy: vi.fn(),
          executeProcess: vi.fn(),
        },
      ),
    ).rejects.toThrow(/binding changed:.*webSearchBaseUrl/u);
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
