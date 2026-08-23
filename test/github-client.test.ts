import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const hookWrap = vi.fn();
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

beforeEach(() => {
  mocks.getOctokit.mockClear();
  mocks.hookWrap.mockClear();
});

describe("Controller GitHub client", () => {
  it("injects the Controller run signal at the actual Octokit request boundary", async () => {
    const controller = new AbortController();
    createGitHubClient("github-token", controller.signal);
    const hook = mocks.hookWrap.mock.calls[0]?.[1] as RequestHook;
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
    const requestConfig = requestOptions?.request as Record<string, unknown> | undefined;
    expect(requestConfig).toMatchObject({ marker: "preserved" });
    expect(requestConfig?.signal).toBeInstanceOf(AbortSignal);
    expect(requestConfig?.signal).not.toBe(controller.signal);
  });

  it("settles on abort even when a custom request ignores the signal", async () => {
    const controller = new AbortController();
    createGitHubClient("github-token", controller.signal);
    const hook = mocks.hookWrap.mock.calls[0]?.[1] as RequestHook;
    let requestSignal: AbortSignal | undefined;
    const request = vi.fn((options: Record<string, unknown>) => {
      requestSignal = (options.request as { signal?: AbortSignal } | undefined)?.signal;
      return new Promise<unknown>(() => undefined);
    });
    const running = hook(request, { method: "GET", url: "/repos/o/r" });
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
    expect(mocks.hookWrap).not.toHaveBeenCalled();
  });
});
