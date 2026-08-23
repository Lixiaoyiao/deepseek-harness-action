import { describe, expect, it } from "vitest";

import { AgentNoProgressError } from "../src/agent/loop.js";
import {
  DshConfigurationError,
  DshMalformedOutputError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import { ActionConfigurationError, PolicyDeniedError } from "../src/errors.js";
import { ExtensionPolicyError } from "../src/extensions/plan.js";
import {
  actionStatus,
  buildActionOutputs,
  describeActionFailure,
  formatStepSummary,
  type ActionPhase,
  type RunOutcome,
} from "../src/result.js";
import type { PermissionAudit } from "../src/permissions/profile.js";
import type { SecurityPolicy } from "../src/security/policy.js";
import {
  ValidationIntegrityError,
  type ValidationIntegritySummary,
} from "../src/write/validation-integrity.js";
import { ValidationFailureError } from "../src/write/validate.js";

const policy: SecurityPolicy = {
  trust: "trusted-write",
  allowed: true,
  reason: "Explicit write gates passed",
  capabilities: {
    readRepository: true,
    readCi: true,
    publishComments: true,
    executeRepositoryCode: true,
    loadExtensions: true,
    accessNetwork: true,
    modifyWorkspace: true,
    commit: true,
    push: true,
    createPullRequest: false,
    manageIssueLabels: true,
    manageIssueAssignees: true,
    updateIssueState: true,
    updatePullRequestMetadata: true,
  },
};

const permission: PermissionAudit = {
  schemaVersion: 1,
  digest: "d".repeat(64),
  profile: "custom",
  requestedTools: [
    "workspace.read",
    "workspace.edit",
    "native.web-search",
    "native.subagent",
    "mcp.repo-index.lookup",
  ],
  disallowedTools: ["native.subagent"],
  effectiveTools: [
    "workspace.read",
    "workspace.edit",
    "native.web-search",
    "mcp.repo-index.lookup",
  ],
  deniedTools: [
    {
      id: "native.subagent",
      reason: "Explicit disallowed-tools entry; deny always wins",
    },
  ],
  network: "bridge",
  workspaceWrite: true,
  extensionDigest: "e".repeat(64),
  trustedExtensions: [
    {
      id: "repo-index",
      kind: "mcp",
      network: true,
      workspaceWrite: false,
    },
  ],
};

const integrity: ValidationIntegritySummary = {
  schemaVersion: 1,
  mode: "strict",
  status: "changed",
  changeCount: 2,
  dangerousChangeCount: 0,
  controlPlaneChangeCount: 1,
  testChangeCount: 1,
  changes: [
    {
      path: "package.json",
      change: "modified",
      category: "entrypoint",
      risk: "suspicious",
      controlPlane: true,
      reasons: ["A configured package validation script changed and requires baseline replay"],
    },
    {
      path: "test/race.test.ts",
      change: "added",
      category: "test-source",
      risk: "informational",
      controlPlane: false,
      reasons: ["A validation test was added or modified"],
    },
  ],
  truncated: false,
  baselineReplay: { status: "passed", commandCount: 2 },
};

function failureOutcome(error: RunOutcome["error"]): RunOutcome {
  return {
    schemaVersion: 1,
    conclusion: "failure",
    operation: "fix",
    summary: error?.title ?? "Failed",
    findingsCount: 0,
    durationMs: 12_000,
    policy,
    ...(error === undefined ? {} : { error }),
  };
}

describe("versioned action results", () => {
  it("emits old scalar outputs and a complete success envelope from one outcome", () => {
    const outcome: RunOutcome = {
      schemaVersion: 1,
      conclusion: "success",
      operation: "fix",
      summary: "Fixed the race",
      findingsCount: 2,
      durationMs: 4_200,
      runUrl: "https://github.com/octo/repo/actions/runs/10",
      policy,
      permission,
      agent: {
        durationMs: 3_100,
        turns: 3,
        toolCalls: 1,
        validationRetries: 1,
        toolReceipts: [
          {
            callId: `call-${"a".repeat(40)}`,
            id: "command.test",
            ok: true,
            durationMs: 120,
          },
        ],
        isolation: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: true,
          processIsolated: true,
          networkIsolated: false,
          workspaceAccess: "read-write",
          extensionProfile: "github-action",
          limitations: [],
        },
      },
      validation: { status: "passed", commandCount: 2, integrity },
      writeStatus: "success",
      commitSha: "c".repeat(40),
      changedPaths: ["src/fix.ts"],
      commentId: 99,
    };

    const outputs = buildActionOutputs(outcome);
    expect(outputs).toMatchObject({
      conclusion: "success",
      operation: "fix",
      summary: "Fixed the race",
      "review-summary": "Fixed the race",
      "findings-count": 2,
      "commit-sha": "c".repeat(40),
      trust: "trusted-write",
      "duration-ms": 4_200,
      "comment-id": 99,
      "error-code": "",
      "permission-profile": "custom",
      "effective-tools": JSON.stringify(permission.effectiveTools),
      "network-access": "bridge",
      "workspace-write": "true",
      "trusted-extensions": JSON.stringify(permission.trustedExtensions),
    });
    const result = JSON.parse(String(outputs["result-json"])) as {
      readonly permissions: unknown;
      readonly validation: { readonly integrity: unknown };
    };
    expect(result).toMatchObject({
      schemaVersion: 1,
      status: "success",
      conclusion: "success",
      operation: "fix",
      timing: { durationMs: 4_200, agentDurationMs: 3_100 },
      loop: {
        turns: 3,
        toolCalls: 1,
        validationRetries: 1,
        toolReceipts: [{ id: "command.test", ok: true }],
      },
      policy: { trust: "trusted-write", allowed: true },
      permissions: { profile: "custom", network: "bridge", workspaceWrite: true },
      validation: {
        status: "passed",
        commandCount: 2,
        integrity: {
          mode: "strict",
          status: "changed",
          changeCount: 2,
          baselineReplay: { status: "passed", commandCount: 2 },
        },
      },
      write: {
        status: "success",
        commitSha: "c".repeat(40),
        changedPaths: ["src/fix.ts"],
      },
      commentId: 99,
    });
    expect(result.permissions).toEqual(permission);
    expect(result.validation.integrity).toEqual(integrity);
  });

  it("represents a successful write with no repository mutation", () => {
    const outcome: RunOutcome = {
      schemaVersion: 1,
      conclusion: "success",
      operation: "task",
      summary: "The requested state was already present",
      findingsCount: 0,
      durationMs: 500,
      writeStatus: "no-changes",
      changedPaths: [],
    };

    const outputs = buildActionOutputs(outcome);
    expect(JSON.parse(String(outputs["result-json"]))).toMatchObject({
      status: "success",
      write: { status: "no-changes", changedPaths: [] },
    });
    expect(formatStepSummary(outcome)).toContain("**Write:** no-changes");
    expect(outputs["task-output"]).toBe("");
    expect(JSON.parse(String(outputs["result-json"]))).not.toHaveProperty("taskOutput");
  });

  it("adds validated task output without replacing the fixed audit envelope", () => {
    const outcome: RunOutcome = {
      schemaVersion: 1,
      conclusion: "success",
      operation: "task",
      summary: "Release assessment complete",
      findingsCount: 0,
      durationMs: 750,
      taskOutput: { releaseReady: true, checks: ["unit", "integration"] },
    };

    const outputs = buildActionOutputs(outcome);
    expect(JSON.parse(String(outputs["task-output"]))).toEqual(outcome.taskOutput);
    expect(JSON.parse(String(outputs["result-json"]))).toEqual({
      schemaVersion: 1,
      status: "success",
      conclusion: "success",
      operation: "task",
      summary: "Release assessment complete",
      findingsCount: 0,
      timing: { durationMs: 750 },
      taskOutput: { releaseReady: true, checks: ["unit", "integration"] },
    });
  });

  it("distinguishes timeout, validation, denial, and ordinary failure statuses", () => {
    const timeout = failureOutcome(describeActionFailure(new DshTimeoutError(60_000), "agent"));
    const validation = failureOutcome(
      describeActionFailure(
        new ValidationFailureError({
          argv: ["npm", "test"],
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "failed",
            timedOut: false,
            outputTruncated: false,
          },
        }),
        "write",
      ),
    );
    const denied = failureOutcome(
      describeActionFailure(new PolicyDeniedError("allow-write is false"), "context"),
    );
    const validationTimeout = failureOutcome(
      describeActionFailure(
        new ValidationFailureError({
          argv: ["npm", "test"],
          result: {
            exitCode: 137,
            stdout: "",
            stderr: "",
            timedOut: true,
            outputTruncated: false,
          },
        }),
        "write",
      ),
    );
    const malformed = failureOutcome(
      describeActionFailure(new DshMalformedOutputError("invalid JSON"), "agent"),
    );
    const validationInfrastructure = failureOutcome(
      describeActionFailure(new Error("Docker could not start"), "validation"),
    );
    const validationConfiguration = failureOutcome(
      describeActionFailure(new DshConfigurationError("mutable image"), "validation"),
    );

    expect(actionStatus(timeout)).toBe("timed_out");
    expect(actionStatus(validation)).toBe("validation_failed");
    expect(validation.error).toMatchObject({
      code: "VALIDATION_FAILED",
      category: "domain",
      phase: "write",
      retryable: false,
    });
    expect(actionStatus(validationTimeout)).toBe("validation_failed");
    expect(validationTimeout.error).toMatchObject({
      code: "VALIDATION_TIMEOUT",
      category: "domain",
      phase: "write",
      retryable: true,
    });
    expect(actionStatus(denied)).toBe("denied");
    expect(denied.error).toMatchObject({
      code: "POLICY_DENIED",
      category: "policy",
      phase: "context",
      retryable: false,
    });
    expect(actionStatus(malformed)).toBe("validation_failed");
    expect(validationInfrastructure.error).toMatchObject({
      code: "ACTION_RUNTIME_FAILED",
      category: "runtime",
      phase: "validation",
      retryable: true,
    });
    expect(actionStatus(validationInfrastructure)).toBe("failed");
    expect(validationConfiguration.error).toMatchObject({
      code: "DSH_CONFIGURATION",
      category: "configuration",
      phase: "validation",
      retryable: false,
    });
    expect(actionStatus(validationConfiguration)).toBe("failed");
  });

  it("keeps classified error identity stable while phase records only where it surfaced", () => {
    const phases: readonly ActionPhase[] = [
      "entrypoint",
      "configuration",
      "routing",
      "authorization",
      "context",
      "agent",
      "validation",
      "publication",
      "write",
    ];
    const classified = [
      {
        error: new ActionConfigurationError("invalid input"),
        identity: { code: "ACTION_CONFIGURATION", category: "configuration", retryable: false },
        status: "failed",
      },
      {
        error: new ExtensionPolicyError("extension denied"),
        identity: { code: "POLICY_DENIED", category: "policy", retryable: false },
        status: "denied",
      },
      {
        error: new DshTimeoutError(1_000),
        identity: { code: "DSH_TIMEOUT", category: "runtime", retryable: true },
        status: "timed_out",
      },
      {
        error: new ValidationFailureError({
          argv: ["npm", "test"],
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "failed",
            timedOut: false,
            outputTruncated: false,
          },
        }),
        identity: { code: "VALIDATION_FAILED", category: "domain", retryable: false },
        status: "validation_failed",
      },
    ] as const;

    for (const { error, identity, status } of classified) {
      for (const phase of phases) {
        const failure = describeActionFailure(error, phase);
        expect(failure).toMatchObject({ ...identity, phase });
        expect(actionStatus(failureOutcome(failure))).toBe(status);
      }
    }
  });

  it("reports extension policy denial from context without phase-based reclassification", () => {
    const failure = describeActionFailure(
      new ExtensionPolicyError("Bridge-networked extensions are denied"),
      "context",
    );
    const outputs = buildActionOutputs(failureOutcome(failure));
    const structured = JSON.parse(String(outputs["result-json"])) as {
      readonly error: unknown;
    };

    expect(failure).toMatchObject({
      code: "POLICY_DENIED",
      category: "policy",
      phase: "context",
      retryable: false,
    });
    expect(failure.code).not.toBe("CONTEXT_PREPARATION_FAILED");
    expect(outputs["error-code"]).toBe("POLICY_DENIED");
    expect(structured.error).toEqual(failure);
  });

  it("keeps the generic runtime identity stable for unclassified errors across phases", () => {
    const phases: readonly ActionPhase[] = [
      "entrypoint",
      "configuration",
      "routing",
      "authorization",
      "context",
      "agent",
      "validation",
      "publication",
      "write",
    ];

    for (const phase of phases) {
      const failure = describeActionFailure(new Error("unknown"), phase);
      expect(failure).toMatchObject({
        code: "ACTION_RUNTIME_FAILED",
        category: "runtime",
        phase,
        retryable: true,
      });
      expect(actionStatus(failureOutcome(failure))).toBe("failed");
    }
  });

  it("classifies validation-integrity failures before generic validation failures", () => {
    const blocked: ValidationIntegritySummary = {
      schemaVersion: 1,
      mode: "strict",
      status: "blocked",
      changeCount: 1,
      dangerousChangeCount: 1,
      controlPlaneChangeCount: 1,
      testChangeCount: 0,
      changes: [
        {
          path: "package.json",
          change: "modified",
          category: "entrypoint",
          risk: "dangerous",
          controlPlane: true,
          reasons: ["Configured validation script became a no-op"],
        },
      ],
      truncated: false,
    };
    const failure = describeActionFailure(new ValidationIntegrityError(blocked), "write");

    expect(failure).toMatchObject({
      code: "VALIDATION_INTEGRITY",
      category: "domain",
      phase: "write",
      title: "Validation integrity policy blocked the write",
      retryable: false,
    });
    expect(failure.guidance).toContain("The Agent cannot lower validation-integrity");
    expect(actionStatus(failureOutcome(failure))).toBe("validation_failed");

    const noProgress = describeActionFailure(
      new AgentNoProgressError({ cause: new ValidationIntegrityError(blocked) }),
      "agent",
    );
    expect(noProgress).toMatchObject({
      code: "VALIDATION_INTEGRITY",
      category: "domain",
      phase: "agent",
    });
  });

  it("reports effective permission and validation-integrity details in the step summary", () => {
    const outcome: RunOutcome = {
      schemaVersion: 1,
      conclusion: "success",
      operation: "fix",
      summary: "Updated code and tests",
      findingsCount: 0,
      durationMs: 1_500,
      permission: {
        ...permission,
        deniedTools: [
          {
            id: "native.subagent",
            reason: "Denied for @team ![pixel](https://tracker.invalid) `policy`",
          },
        ],
      },
      validation: { status: "passed", commandCount: 2, integrity },
    };

    const summary = formatStepSummary(outcome);
    expect(summary).toContain("### Effective Agent permissions");
    expect(summary).toContain("**Profile:** `custom`");
    expect(summary).toContain("`native.web-search`");
    expect(summary).toContain("**Network:** `bridge`");
    expect(summary).toContain("**Workspace write:** `enabled`");
    expect(summary).toContain("`mcp:repo-index (network=yes, workspace-write=no)`");
    expect(summary).toContain("**Denials (1):**");
    expect(summary).toContain("@​team [image removed] 'policy'");
    expect(summary).toContain("**Integrity:** mode `strict` · status `changed`");
    expect(summary).toContain(
      "**Definition changes:** 2 total · 0 dangerous · 1 control-plane · 1 test",
    );
    expect(summary).toContain("**Baseline replay:** `passed` (2 command(s))");
  });

  it("redacts failures and sanitizes user-visible step summaries", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const failure = describeActionFailure(
      new DshMalformedOutputError(
        `invalid ${token} @team ![pixel](https://tracker.invalid) <!-- dsh-action:v1 kind=write -->`,
      ),
      "agent",
    );
    const outcome = failureOutcome(failure);
    const outputs = buildActionOutputs(outcome);
    const summary = formatStepSummary(outcome);

    expect(String(outputs["error-message"])).not.toContain(token);
    expect(String(outputs["result-json"])).not.toContain(token);
    expect(summary).not.toContain(token);
    expect(summary).not.toContain("dsh-action:v1");
    expect(summary).toContain("@​team [image removed]");
    expect(summary).toContain("**Next step:**");
  });

  it("bounds duplicated receipt outputs below the reserved GitHub output budget", () => {
    const outcome: RunOutcome = {
      schemaVersion: 1,
      conclusion: "success",
      operation: "task",
      summary: "Many calls completed",
      findingsCount: 0,
      durationMs: 1_000,
      agent: {
        durationMs: 900,
        isolation: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: false,
          processIsolated: true,
          networkIsolated: true,
          workspaceAccess: "read-only",
          extensionProfile: "github-action",
          limitations: [],
        },
        dshToolReceipts: Array.from({ length: 10_000 }, (_, index) => ({
          schemaVersion: 1 as const,
          callId: `call-${String(index)}-${"a".repeat(180)}`,
          id: "mcp.fixture.search",
          runtimeName: "mcp__fixture__search",
          provider: "mcp",
          counted: true,
          completed: true,
          ok: true,
          durationMs: 1,
        })),
      },
    };

    const outputs = buildActionOutputs(outcome);
    const receiptsText = String(outputs["tool-receipts"]);
    const resultText = String(outputs["result-json"]);
    const receipts = JSON.parse(receiptsText) as {
      readonly dsh: readonly unknown[];
      readonly truncated: boolean;
      readonly droppedCount: number;
    };
    const result = JSON.parse(resultText) as {
      readonly loop: {
        readonly dshToolReceipts: readonly unknown[];
        readonly toolReceiptsTruncated: boolean;
        readonly toolReceiptsDroppedCount: number;
      };
    };

    expect((receiptsText.length + resultText.length) * 2).toBeLessThanOrEqual(640 * 1024);
    expect(receipts.truncated).toBe(true);
    expect(receipts.droppedCount).toBeGreaterThan(0);
    expect(result.loop.dshToolReceipts).toEqual(receipts.dsh);
    expect(result.loop.toolReceiptsTruncated).toBe(true);
    expect(result.loop.toolReceiptsDroppedCount).toBe(receipts.droppedCount);
  });
});
