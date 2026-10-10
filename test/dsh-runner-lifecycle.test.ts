import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import { DshAbortedError, DshTimeoutError } from "../src/dsh/errors.js";
import type { DeepSeekProxyHandle } from "../src/dsh/proxy.js";
import { createDshRuntime, disposeDshRuntime, runDsh } from "../src/dsh/runner.js";
import type { DshProcessLimits, DshProcessResult, DshProcessSpec } from "../src/dsh/runner.js";
import { PHASE_TIMEOUTS } from "../src/dsh/timeouts.js";
import {
  CONTAINER_LAUNCHER,
  fakeProxy,
  networkInspectResult,
  request,
  createDshFixtureManager,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

describe("runDsh lifecycle", () => {
  it("warns on a failed Docker network removal while preserving the validated worker result", async () => {
    const fixture = await fixtures();
    const warning = vi.fn();
    const result = await runDsh(
      request({ isolation: "docker", workspacePath: fixture.workspace }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(fakeProxy()),
        warning,
        executeProcess: (spec) => {
          if (spec.args[0] === "network" && spec.args[1] === "rm") {
            return Promise.resolve({
              stdout: "",
              stderr: "network still busy: controller-real-key",
              exitCode: 1,
              signal: null,
            });
          }
          return Promise.resolve(
            networkInspectResult(spec) ?? {
              stdout: spec.args.includes(CONTAINER_LAUNCHER)
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
            },
          );
        },
      },
    );
    expect(result.output.summary).toBe("Done.");
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Docker network cleanup did not complete"),
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("primary result was preserved"));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("controller-real-key");
  });
  it.each(["success", "rejection"])(
    "removes an internal network whose create returns a late %s after cancellation and first cleanup",
    async (acknowledgement) => {
      const fixture = await fixtures();
      const controller = new AbortController();
      let networkExists = false;
      let completeCreate: (() => void) | undefined;
      const execution = runDsh(
        request({
          isolation: "docker",
          workspacePath: fixture.workspace,
          signal: controller.signal,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          executeProcess: (spec) => {
            if (spec.args[0] === "network" && spec.args[1] === "create") {
              return new Promise((resolve, reject) => {
                completeCreate = () => {
                  networkExists = true;
                  if (acknowledgement === "rejection")
                    reject(new Error("Lost Docker create acknowledgement"));
                  else resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
                };
                controller.abort(new DshAbortedError());
              });
            }
            if (spec.args[0] === "network" && spec.args[1] === "rm") networkExists = false;
            return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
          },
        },
      );
      await expect(execution).rejects.toBeInstanceOf(DshAbortedError);
      if (completeCreate === undefined) throw new Error("Docker create did not start");
      completeCreate();
      await expect.poll(() => networkExists).toBe(false);
    },
  );

  it("bounds a stalled Docker daemon preflight by ten seconds and the run deadline", async () => {
    const fixture = await fixtures();
    const proxy = vi.fn(() => Promise.resolve(fakeProxy()));
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    vi.useFakeTimers();
    try {
      const running = runDsh(
        request({ isolation: "docker", workspacePath: fixture.workspace, timeoutMs: 30_000 }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy: proxy,
          executeProcess: (spec, limits) => {
            expect(spec.args[0]).toBe("info");
            expect(limits.timeoutMs).toBe(10_000);
            markStarted?.();
            return new Promise<DshProcessResult>(() => undefined);
          },
        },
      );
      await started;
      const failure = expect(running).rejects.toBeInstanceOf(DshTimeoutError);
      await vi.advanceTimersByTimeAsync(10_000);
      await failure;
      expect(proxy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
});
