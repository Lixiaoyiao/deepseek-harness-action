import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RunOutcome } from "../src/result.js";

const mocks = vi.hoisted(() => ({
  runAction: vi.fn(),
  setOutput: vi.fn(),
  setFailed: vi.fn(),
  warning: vi.fn(),
  addHeading: vi.fn(),
  addRaw: vi.fn(),
  summaryWrite: vi.fn(),
}));

vi.mock("../src/orchestrator.js", () => ({ runAction: mocks.runAction }));
vi.mock("@actions/core", () => {
  const summary = {
    addHeading(...args: unknown[]) {
      mocks.addHeading(...args);
      return summary;
    },
    addRaw(...args: unknown[]) {
      mocks.addRaw(...args);
      return summary;
    },
    write(...args: unknown[]) {
      return mocks.summaryWrite(...args) as Promise<unknown>;
    },
  };
  return {
    setOutput: mocks.setOutput,
    setFailed: mocks.setFailed,
    warning: mocks.warning,
    summary,
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.summaryWrite.mockResolvedValue(undefined);
});

describe("action entrypoint finalization", () => {
  it("sets the complete result envelope before failing the step", async () => {
    const failure: RunOutcome = {
      schemaVersion: 1,
      conclusion: "failure",
      operation: "review",
      summary: "DeepSeek Harness timed out",
      findingsCount: 0,
      durationMs: 60_000,
      error: {
        code: "DSH_TIMEOUT",
        phase: "agent",
        title: "DeepSeek Harness timed out",
        message: "DSH exceeded its timeout",
        guidance: "Reduce the task scope and rerun.",
        retryable: true,
      },
    };
    mocks.runAction.mockResolvedValue(failure);

    await import("../src/index.js");
    expect(mocks.setFailed).toHaveBeenCalledOnce();

    const outputCalls = mocks.setOutput.mock.calls as [string, string | number][];
    const outputs = Object.fromEntries(outputCalls) as Record<string, unknown>;
    expect(outputs).toMatchObject({
      conclusion: "failure",
      operation: "review",
      "error-code": "DSH_TIMEOUT",
      "error-message": "DSH exceeded its timeout",
    });
    const structured: unknown = JSON.parse(String(outputs["result-json"]));
    expect(structured).toMatchObject({
      schemaVersion: 1,
      status: "timed_out",
      error: { code: "DSH_TIMEOUT", phase: "agent", retryable: true },
    });
    expect(mocks.setOutput.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mocks.setFailed.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("does not turn a successful mutation into failure when the step summary is unavailable", async () => {
    mocks.runAction.mockResolvedValue({
      schemaVersion: 1,
      conclusion: "success",
      operation: "implement",
      summary: "Pull request created",
      findingsCount: 0,
      durationMs: 1_000,
      branchName: "dsh/issue-7",
      pullRequestUrl: "https://github.com/octo/repo/pull/8",
    } satisfies RunOutcome);
    mocks.summaryWrite.mockRejectedValue(new Error("summary unavailable"));

    await import("../src/index.js");
    expect(mocks.warning).toHaveBeenCalledOnce();

    expect(mocks.setOutput).toHaveBeenCalledWith("conclusion", "success");
    expect(mocks.setFailed).not.toHaveBeenCalled();
  });

  it("still emits a safe configuration envelope for an unexpected entrypoint rejection", async () => {
    const token = `ghp_${"a".repeat(36)}`;
    mocks.runAction.mockRejectedValue(new Error(`unexpected ${token}`));

    await import("../src/index.js");
    expect(mocks.setFailed).toHaveBeenCalledOnce();

    const outputCalls = mocks.setOutput.mock.calls as [string, string | number][];
    const outputs = Object.fromEntries(outputCalls) as Record<string, unknown>;
    expect(outputs).toMatchObject({
      conclusion: "failure",
      operation: "none",
      "error-code": "ACTION_CONFIGURATION",
    });
    expect(String(outputs["error-message"])).not.toContain(token);
    expect(String(outputs["error-message"])).toContain("[REDACTED_GITHUB_TOKEN]");
  });
});
