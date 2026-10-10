import { beforeEach, describe, expect, it, vi } from "vitest";
import { record } from "../src/security/record.js";

const mocks = vi.hoisted(() => {
  const hookWrap = vi.fn<(event: string, hook: RequestHook) => void>();
  return {
    hookWrap,
    getOctokit: vi.fn(() => ({ request: vi.fn(), hook: { wrap: hookWrap } })),
  };
});

vi.mock("@actions/github", () => ({ getOctokit: mocks.getOctokit }));

import { createGitHubClient } from "../src/github/client.js";

type RequestHook = (
  request: (options: Record<string, unknown>) => Promise<unknown>,
  options: Record<string, unknown>,
) => Promise<unknown>;

function requestHook(): RequestHook {
  const hook = mocks.hookWrap.mock.calls[0]?.[1];
  if (hook === undefined) throw new Error("Expected the installed Octokit request hook");
  return hook;
}

beforeEach(() => {
  mocks.getOctokit.mockClear();
  mocks.hookWrap.mockClear();
});

describe("Controller GitHub client", () => {
  it("injects the Controller run signal at the actual Octokit request boundary", async () => {
    const controller = new AbortController();
    createGitHubClient("github-token", controller.signal);
    const hook = requestHook();
    const request = vi.fn((options: Record<string, unknown>) => Promise.resolve(options));

    await hook(request, {
      method: "GET",
      url: "/repos/o/r",
      request: { marker: "preserved" },
    });

    expect(mocks.getOctokit).toHaveBeenCalledWith("github-token", {
      userAgent: "dsh-action/0.2",
    });
    const requestOptions = request.mock.calls[0]?.[0];
    const requestConfig = record(requestOptions?.request);
    expect(requestConfig).toMatchObject({ marker: "preserved" });
    expect(requestConfig.signal).toBeInstanceOf(AbortSignal);
    expect(requestConfig.signal).not.toBe(controller.signal);
  });

  it("settles on abort even when a custom request ignores the signal", async () => {
    const controller = new AbortController();
    createGitHubClient("github-token", controller.signal);
    const hook = requestHook();
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((options: Record<string, unknown>) => {
      const signal = record(options.request).signal;
      requestSignal = signal instanceof AbortSignal ? signal : undefined;
      return new Promise<unknown>(() => undefined);
    });
    const running = hook(request, { method: "GET", url: "/repos/o/r", request: {} });
    const reason = new Error("Controller deadline exhausted");

    controller.abort(reason);

    await expect(running).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
    expect(requestSignal?.reason).toBe(reason);
  });

  it("preserves the existing client contract when no signal is supplied", () => {
    createGitHubClient("github-token");

    expect(mocks.getOctokit).toHaveBeenCalledWith("github-token", {
      userAgent: "dsh-action/0.2",
    });
    expect(mocks.hookWrap).toHaveBeenCalledOnce();
  });

  it("preserves the shorter invocation signal alongside the run signal", async () => {
    const run = new AbortController();
    const invocation = new AbortController();
    createGitHubClient("github-token", run.signal);
    const hook = requestHook();
    let received: AbortSignal | undefined;
    const request = vi.fn((options: Record<string, unknown>) => {
      const signal = record(options.request).signal;
      received = signal instanceof AbortSignal ? signal : undefined;
      return new Promise<unknown>(() => undefined);
    });
    const running = hook(request, {
      method: "GET",
      url: "/repos/o/r",
      request: { signal: invocation.signal },
    });
    const reason = new Error("invocation deadline");
    invocation.abort(reason);
    await expect(running).rejects.toBe(reason);
    expect(received?.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });
});
