import { describe, expect, it } from "vitest";

import {
  AgentDeadlineError,
  AgentLoopLimitError,
  AgentNoProgressError,
} from "../src/agent/loop.js";
import {
  DshAbortedError,
  DshConfigurationError,
  DshCredentialLeakError,
  DshEnvironmentError,
  DshIsolationUnavailableError,
  DshMalformedOutputError,
  DshOutputLimitError,
  DshProcessError,
  DshProxyError,
  DshSpawnError,
  DshTimeoutError,
} from "../src/dsh/errors.js";
import { EventRoutingError, OperationContextError } from "../src/errors.js";
import { ValidationIntegrityError } from "../src/write/validation-integrity.js";
import { ValidationFailureError } from "../src/write/validate.js";

function validationFailure(timedOut: boolean): ValidationFailureError {
  return new ValidationFailureError({
    argv: ["npm", "test"],
    result: {
      exitCode: timedOut ? 124 : 1,
      stdout: "",
      stderr: timedOut ? "timed out" : "failed",
      timedOut,
      outputTruncated: false,
    },
  });
}

describe("stable DSH error identity", () => {
  it.each([
    [new DshAbortedError(), "DSH_ABORTED", "runtime", true],
    [new DshConfigurationError("invalid"), "DSH_CONFIGURATION", "configuration", false],
    [new DshCredentialLeakError("stdout"), "DSH_CREDENTIAL_LEAK", "runtime", false],
    [new DshEnvironmentError("invalid"), "DSH_ENVIRONMENT", "runtime", false],
    [
      new DshIsolationUnavailableError("unavailable"),
      "DSH_ISOLATION_UNAVAILABLE",
      "runtime",
      false,
    ],
    [new DshMalformedOutputError("invalid"), "DSH_MALFORMED_OUTPUT", "domain", true],
    [new DshOutputLimitError("stdout", 1), "DSH_OUTPUT_LIMIT", "runtime", false],
    [new DshProcessError(1, null, "failed"), "DSH_PROCESS_FAILED", "runtime", true],
    [new DshProxyError("failed"), "DSH_PROXY", "runtime", true],
    [new DshSpawnError("failed"), "DSH_SPAWN", "runtime", false],
    [new DshTimeoutError(1), "DSH_TIMEOUT", "runtime", true],
  ] as const)("classifies %s", (error, code, category, retryable) => {
    expect(error).toMatchObject({ code, category, retryable });
  });
});

describe("stable Controller error identity", () => {
  it.each([
    [new EventRoutingError("unsupported event"), "EVENT_ROUTING_FAILED", "domain", false],
    [
      new OperationContextError("invalid operation context"),
      "OPERATION_CONTEXT_INVALID",
      "domain",
      false,
    ],
    [new AgentLoopLimitError(3), "AGENT_TURN_LIMIT", "domain", false],
    [new AgentDeadlineError(), "AGENT_TIMEOUT", "runtime", true],
    [new AgentNoProgressError(), "AGENT_NO_PROGRESS", "domain", false],
    [validationFailure(false), "VALIDATION_FAILED", "domain", false],
    [validationFailure(true), "VALIDATION_TIMEOUT", "domain", true],
    [
      new ValidationIntegrityError({
        schemaVersion: 1,
        mode: "strict",
        status: "blocked",
        changeCount: 1,
        dangerousChangeCount: 1,
        controlPlaneChangeCount: 1,
        testChangeCount: 0,
        changes: [],
        truncated: false,
      }),
      "VALIDATION_INTEGRITY",
      "domain",
      false,
    ],
  ] as const)("classifies %s", (error, code, category, retryable) => {
    expect(error).toMatchObject({ code, category, retryable });
  });
});
