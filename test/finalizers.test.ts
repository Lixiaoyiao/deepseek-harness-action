import { describe, expect, it, vi } from "vitest";

import type { DshRunResult } from "../src/dsh/runner.js";
import type { GitHubClient } from "../src/github/client.js";
import type { PullRequestSnapshot } from "../src/github/fetch.js";
import type { SecurityPolicy } from "../src/security/policy.js";
import { formatCiEvidence } from "../src/ci/diagnose.js";

const mocks = vi.hoisted(() => ({
  publishReview: vi.fn(),
  runDsh: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("../src/review/publisher.js", () => ({ publishPullRequestReview: mocks.publishReview }));
vi.mock("../src/dsh/runner.js", () => ({ runDsh: mocks.runDsh }));
vi.mock("../src/github/comments.js", () => ({ upsertTrackingComment: mocks.upsert }));

import { finishDiagnosis } from "../src/commands/diagnose.js";
import { finishReview } from "../src/commands/review.js";
import { runAgentTask } from "../src/review/run.js";
import { publishStatusComment } from "../src/github/status.js";
import { inputs } from "./helpers.js";

const result: DshRunResult = {
  output: {
    protocolVersion: 1,
    operation: "diagnose",
    state: "final",
    summary: "Summary @team ![pixel](https://tracker.invalid/x)",
    diagnosis: "Root cause<!-- dsh-action:summary:v1 -->",
    findings: [
      {
        title: "Race",
        body: "Observed stale read",
        severity: "high",
        category: "concurrency",
        confidence: 0.95,
        path: "src/`unsafe`.ts",
        line: 4,
      },
    ],
  },
  durationMs: 1,
  isolationReport: {
    backend: "docker",
    credentialMediated: true,
    repoToolsEnabled: false,
    processIsolated: true,
    networkIsolated: false,
    workspaceAccess: "read-only",
    limitations: [],
  },
};

describe("operation finalizers", () => {
  it("renders bounded, marker-owned diagnosis comments", async () => {
    mocks.upsert.mockResolvedValue(1);
    await finishDiagnosis(
      {} as GitHubClient,
      { owner: "o", repo: "r", issueNumber: 7 },
      1,
      result,
      "https://github.com/o/r/actions/runs/1",
    );
    const body = String(mocks.upsert.mock.calls.at(-1)?.[4]);
    expect(body).toContain("dsh-action:v1 kind=diagnosis");
    expect(body).toContain("Root cause");
    expect(body).toContain("src/&#96;unsafe&#96;.ts:4");
    expect(body).not.toContain("dsh-action:summary:v1");
    expect(body.length).toBeLessThanOrEqual(65_000);
  });

  it("adapts DSH optional output fields to review publication", async () => {
    const publication = {
      selected: 1,
      inlinePublished: 1,
      inlineUpdated: 0,
      duplicatesSkipped: 0,
      summaryOnly: 0,
      failures: [],
    };
    mocks.publishReview.mockResolvedValue(publication);
    const reviewResult: DshRunResult = {
      ...result,
      output: {
        ...result.output,
        operation: "review",
        changePlan: [{ path: "src/a.ts", summary: "change" }],
        verification: [{ command: "npm test", status: "passed" }],
      },
    };
    const returned = await finishReview(
      {} as GitHubClient,
      { owner: "o", repo: "r", pullNumber: 7, expectedAuthorId: 1, runUrl: "run" },
      {} as PullRequestSnapshot,
      reviewResult,
      10,
    );
    expect(returned).toBe(publication);
    expect(mocks.publishReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        changes: reviewResult.output.changePlan,
        tests: reviewResult.output.verification,
      }),
      10,
    );
  });

  it("passes only typed controller fields into the DSH runner", async () => {
    mocks.runDsh.mockResolvedValue(result);
    const policy: SecurityPolicy = {
      trust: "untrusted",
      allowed: true,
      reason: "review",
      capabilities: {
        readRepository: true,
        readCi: false,
        publishComments: true,
        executeRepositoryCode: false,
        accessNetwork: false,
        modifyWorkspace: false,
        commit: false,
        push: false,
        createPullRequest: false,
      },
    };
    await runAgentTask(
      {
        operation: "review",
        requestedAccess: "read",
        policy,
        contextPacket: { repository: "o/r", data: "untrusted" },
        instructions: "focus on security",
        workspacePath: "workspace",
        tools: { workspace: [], manifests: [], commands: [] },
      },
      inputs({ dshExecutable: "C:/dsh/lib/bin.js", timeoutMinutes: 2 }),
    );
    expect(mocks.runDsh).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "review",
        prompt: JSON.stringify({ repository: "o/r", data: "untrusted" }),
        trustedInstructions: "focus on security",
        trust: "untrusted",
        timeoutMs: 120_000,
        dshExecutable: "C:/dsh/lib/bin.js",
      }),
      {},
    );
  });

  it("sanitizes status comments and removes model-owned markers", async () => {
    mocks.upsert.mockResolvedValue(1);
    await publishStatusComment(
      {} as GitHubClient,
      { owner: "o", repo: "r", issueNumber: 7 },
      1,
      "Fix prepared",
      "done <!-- dsh-action:finding:attacker --> @team ![track](https://x.invalid)",
      "https://github.com/o/r/actions/runs/1",
    );
    const body = String(mocks.upsert.mock.calls.at(-1)?.[4]);
    expect(body).toContain("dsh-action:v1 kind=write");
    expect(body).not.toContain("attacker");
    expect(body).toContain("@​team");
    expect(body).toContain("[image removed]");
  });

  it("serializes CI evidence with an explicit untrusted-data label", () => {
    const formatted = formatCiEvidence({
      headSha: "a".repeat(40),
      truncated: true,
      checkRuns: [{ name: "test", conclusion: "failure", detailsUrl: null, summary: "boom" }],
      jobs: [
        {
          runId: 1,
          runName: "CI",
          runUrl: "run",
          jobId: 2,
          jobName: "job",
          jobUrl: "job",
          conclusion: "failure",
          failedSteps: [{ name: "test", number: 1 }],
          log: "log",
          logTruncated: false,
        },
      ],
    });
    expect(JSON.parse(formatted)).toMatchObject({ trust: "UNTRUSTED_CI_DATA", truncated: true });
  });
});
