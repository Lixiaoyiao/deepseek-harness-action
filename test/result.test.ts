import { describe, expect, it } from "vitest";

import {
  DshConfigurationError,
  DshMalformedOutputError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import {
  actionStatus,
  buildActionOutputs,
  describeActionFailure,
  formatStepSummary,
  type RunOutcome,
} from "../src/result.js";
import type { SecurityPolicy } from "../src/security/policy.js";
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
    modifyWorkspace: true,
    commit: true,
    push: true,
    createPullRequest: false,
  },
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
      agent: {
        durationMs: 3_100,
        isolation: {
          backend: "docker",
          credentialMediated: true,
          repoToolsEnabled: true,
          processIsolated: true,
          networkIsolated: false,
          workspaceAccess: "read-write",
          limitations: [],
        },
      },
      validation: { status: "passed", commandCount: 2 },
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
    });
    expect(JSON.parse(String(outputs["result-json"]))).toMatchObject({
      schemaVersion: 1,
      status: "success",
      conclusion: "success",
      operation: "fix",
      timing: { durationMs: 4_200, agentDurationMs: 3_100 },
      policy: { trust: "trusted-write", allowed: true },
      validation: { status: "passed", commandCount: 2 },
      write: {
        status: "success",
        commitSha: "c".repeat(40),
        changedPaths: ["src/fix.ts"],
      },
      commentId: 99,
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
      describeActionFailure(new Error("allow-write is false"), "authorization"),
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
      phase: "validation",
      retryable: false,
    });
    expect(actionStatus(validationTimeout)).toBe("validation_failed");
    expect(validationTimeout.error).toMatchObject({
      code: "VALIDATION_TIMEOUT",
      phase: "validation",
      retryable: true,
    });
    expect(actionStatus(denied)).toBe("denied");
    expect(actionStatus(malformed)).toBe("validation_failed");
    expect(validationInfrastructure.error).toMatchObject({
      code: "VALIDATION_FAILED",
      phase: "validation",
      retryable: false,
    });
    expect(actionStatus(validationInfrastructure)).toBe("validation_failed");
    expect(validationConfiguration.error).toMatchObject({
      code: "DSH_CONFIGURATION",
      phase: "validation",
    });
    expect(actionStatus(validationConfiguration)).toBe("validation_failed");
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
});
