import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DshConfigurationError,
  DshIsolationUnavailableError,
  DshOutputLimitError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import type { DeepSeekProxyHandle } from "../src/dsh/proxy.js";
import { executeBoundedDshProcess, runDsh } from "../src/dsh/runner.js";
import type { DshProcessLimits, DshProcessSpec, DshRunRequest } from "../src/dsh/runner.js";

const temporaryPaths: string[] = [];
const PINNED_NODE_IMAGE = `node@sha256:${"a".repeat(64)}`;

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
    dshVersion: "0.1.0-rc.6",
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

describe("executeBoundedDshProcess", () => {
  const spec = (source: string): DshProcessSpec => ({
    command: process.execPath,
    args: ["--eval", source],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
  });
  const limits = (overrides: Partial<DshProcessLimits> = {}): DshProcessLimits => ({
    timeoutMs: 2_000,
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
  });

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
  it("adapts the orchestrator seam, parses output, and keeps controller secrets out of worker env/argv", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const output = { operation: "review", summary: "Looks sound.", findings: [] };
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
            stdout: JSON.stringify({ operation: "review", summary: "Done.", findings: [] }),
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
            stdout: JSON.stringify({ operation: "review", summary: "Done.", findings: [] }),
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
              operation: "review",
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

  it("builds a hardened Docker argv and selects the trusted patch", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const observedSpecs: DshProcessSpec[] = [];
    await runDsh(
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
          expect(options.workerHost).toBe("host.docker.internal");
          return Promise.resolve(proxy);
        },
        executeProcess: (spec) => {
          observedSpecs.push(spec);
          captured = spec;
          if (spec.args.includes("install")) {
            return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
          }
          return Promise.resolve({
            stdout: JSON.stringify({ operation: "fix", summary: "Fixed.", findings: [] }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(observedSpecs).toHaveLength(2);
    const installSpec = observedSpecs[0];
    expect(installSpec?.args).toContain("@deepseek-ai/dsh@0.1.0-rc.6");
    expect(installSpec?.args).not.toContain("--ignore-scripts");
    expect(installSpec?.args).toContain("--no-audit");
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
      `${join(fixture.assets, "trusted-write.patch.yml")}:/opt/dsh-action/policy.patch.yml:ro`,
    );
    const writePatch = await readFile(join(fixture.assets, "trusted-write.patch.yml"), "utf8");
    // The real packaged patch is covered by the config smoke test; fixtures
    // establish that the runner selects this exact trust-level asset.
    expect(writePatch).toBe("[]\n");
    expect(captured?.args).toContain(
      "/opt/dsh-action/package/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    expect(captured?.args).toContain("--expose-internals");
    expect(captured?.args).toContain("HOME=/dsh-home");
    expect(captured?.args).toContain("DSH_HOME=/dsh-home");
    expect(captured?.args).toContain("npm_config_cache=/dsh-home/npm-cache");
    expect(captured?.args).toContain("DSH_PERMISSION_MODE=workspace-write");
    expect(captured?.args).toContain("DEEPSEEK_API_KEY=ephemeral-worker-token");
    expect(captured?.args).not.toContain("npx");
    expect(captured?.termination).toMatchObject({ command: "docker" });
  });

  it("enables only read/search tools for trusted Docker reviews", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const result = await runDsh(
      request({ isolation: "docker", workspacePath: fixture.workspace }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          if (!spec.args.includes("install")) captured = spec;
          return Promise.resolve({
            stdout: spec.args.includes("install")
              ? ""
              : JSON.stringify({ operation: "review", summary: "Done.", findings: [] }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );
    expect(result.isolationReport.repoToolsEnabled).toBe(true);
    expect(result.isolationReport.workspaceAccess).toBe("read-only");
    expect(captured?.args).toContain(`${fixture.workspace}:/workspace:ro`);
    expect(captured?.args).toContain(
      `${join(fixture.assets, "trusted-read.patch.yml")}:/opt/dsh-action/policy.patch.yml:ro`,
    );
  });
});
