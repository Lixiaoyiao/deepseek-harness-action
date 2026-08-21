import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as ActionsCoreModule from "@actions/core";
import type * as AgentLoopModule from "../src/agent/loop.js";
import { DshProcessError } from "../src/dsh/errors.js";
import type { DshFailureTelemetry } from "../src/dsh/errors.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as GitHubPayloadModule from "../src/github/payload.js";
import type * as GitHubPermissionsModule from "../src/github/permissions.js";
import type * as InputsModule from "../src/inputs.js";
import { runAction } from "../src/orchestrator.js";
import { buildActionOutputs } from "../src/result.js";
import { inputs } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  loadInputs: vi.fn(),
  readEventPayload: vi.fn(),
  createGitHubClient: vi.fn(),
  checkActorPermissions: vi.fn(),
  runAgentLoop: vi.fn(),
  setSecret: vi.fn(),
}));

vi.mock("@actions/core", async (importOriginal) => ({
  ...(await importOriginal<typeof ActionsCoreModule>()),
  setSecret: mocks.setSecret,
}));

vi.mock("../src/inputs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof InputsModule>()),
  loadInputs: mocks.loadInputs,
}));

vi.mock("../src/github/payload.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubPayloadModule>()),
  readEventPayload: mocks.readEventPayload,
}));

vi.mock("../src/github/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubClientModule>()),
  createGitHubClient: mocks.createGitHubClient,
}));

vi.mock("../src/github/permissions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubPermissionsModule>()),
  checkActorPermissions: mocks.checkActorPermissions,
}));

vi.mock("../src/agent/loop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentLoopModule>()),
  runAgentLoop: mocks.runAgentLoop,
}));

const isolation: DshFailureTelemetry["isolationReport"] = {
  backend: "docker",
  credentialMediated: true,
  repoToolsEnabled: true,
  processIsolated: true,
  networkIsolated: true,
  workspaceAccess: "read-only",
  extensionProfile: "github-action",
  limitations: [],
};

const extensionAudit = {
  schemaVersion: 1 as const,
  profile: "github-action" as const,
  digest: "d".repeat(64),
  network: false,
  entries: [],
};

const failureReceipt = {
  schemaVersion: 1 as const,
  callId: "mcp-crash",
  id: "mcp.fixture.lookup",
  runtimeName: "mcp__fixture__lookup",
  provider: "mcp",
  counted: true,
  completed: false,
  ok: false,
  durationMs: 0,
  code: "ACTION_TOOL_INCOMPLETE",
};

beforeEach(() => {
  vi.stubEnv("GITHUB_EVENT_NAME", "workflow_dispatch");
  vi.stubEnv("GITHUB_ACTOR", "alice");
  vi.stubEnv("GITHUB_RUN_ID", "99");
  vi.stubEnv("GITHUB_REPOSITORY", "octo/repo");
  vi.stubEnv("GITHUB_EVENT_PATH", "event.json");
  vi.stubEnv("GITHUB_WORKSPACE", process.cwd());

  mocks.loadInputs.mockReturnValue(
    inputs({
      command: "task",
      prompt: "Inspect the repository",
      taskAccess: "read",
      isolation: "none",
      progressComment: false,
      allowedTools: ["workspace.read", "workspace.search"],
    }),
  );
  mocks.readEventPayload.mockResolvedValue({
    repository: {
      id: 1,
      name: "repo",
      full_name: "octo/repo",
      default_branch: "main",
      owner: { login: "octo" },
    },
    sender: { login: "alice" },
  });
  mocks.createGitHubClient.mockReturnValue({});
  mocks.checkActorPermissions.mockResolvedValue({
    actors: [
      {
        actor: "alice",
        accountType: "User",
        permission: "write",
        hasWrite: true,
        allowedBot: false,
      },
    ],
    allActorsHaveWrite: true,
    allActorsAllowedForWrite: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("orchestrator DSH failure reporting", () => {
  it("preserves extension audit and failure receipts in public outputs", async () => {
    const telemetry: DshFailureTelemetry = {
      durationMs: 25,
      isolationReport: isolation,
      extensionAudit,
      toolReceipts: [failureReceipt],
    };
    const failure = new DshProcessError(9, null, "worker crashed").attachTelemetry(telemetry);
    mocks.runAgentLoop.mockImplementation(async (...args: unknown[]) => {
      const hooks = args[2] as AgentLoopModule.AgentLoopHooks<unknown>;
      const stats: AgentLoopModule.AgentLoopStats = {
        turns: 1,
        toolCalls: 0,
        validationRetries: 0,
        toolReceipts: [],
      };
      await hooks.onTurn?.(1, 3);
      await hooks.onEngineFailure?.(telemetry, stats);
      throw failure;
    });

    const outcome = await runAction();
    const outputs = buildActionOutputs(outcome);

    expect(outcome).toMatchObject({
      conclusion: "failure",
      operation: "task",
      agent: {
        durationMs: 25,
        extensionAudit,
        dshToolReceipts: [failureReceipt],
      },
      error: { code: "DSH_PROCESS_FAILED", phase: "agent" },
    });
    expect(outputs["extension-profile-digest"]).toBe(extensionAudit.digest);
    expect(JSON.parse(String(outputs["tool-receipts"]))).toMatchObject({
      dsh: [failureReceipt],
      truncated: false,
      droppedCount: 0,
    });
    expect(JSON.parse(String(outputs["result-json"]))).toMatchObject({
      status: "failed",
      extensions: extensionAudit,
      loop: { dshToolReceipts: [failureReceipt] },
      error: { code: "DSH_PROCESS_FAILED", phase: "agent" },
    });
  });
});
