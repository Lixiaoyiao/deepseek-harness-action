import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getOctokit: vi.fn(() => ({ request: vi.fn() })),
}));

vi.mock("@actions/github", () => ({ getOctokit: mocks.getOctokit }));

import { createGitHubClient } from "../src/github/client.js";

beforeEach(() => {
  mocks.getOctokit.mockClear();
});

describe("Controller GitHub client", () => {
  it("binds every Octokit request to the Controller run signal", () => {
    const controller = new AbortController();

    createGitHubClient("github-token", controller.signal);

    expect(mocks.getOctokit).toHaveBeenCalledWith("github-token", {
      userAgent: "dsh-action/0.2",
      request: { signal: controller.signal },
    });
  });

  it("preserves the existing client contract when no signal is supplied", () => {
    createGitHubClient("github-token");

    expect(mocks.getOctokit).toHaveBeenCalledWith("github-token", {
      userAgent: "dsh-action/0.2",
    });
  });
});
