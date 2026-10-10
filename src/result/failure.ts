import {
  AgentDeadlineError,
  AgentLoopLimitError,
  AgentNoProgressError,
} from "../agent/loop-errors.js";
import { GitHubEntityRevalidationError } from "../tools/github-gateway-revalidation.js";
import { EntityBindingChangedError } from "../write/errors.js";
import { DshError } from "../dsh/errors.js";
import {
  isClassifiedActionError,
  type ActionErrorCategory,
  type ClassifiedActionError,
} from "../errors.js";
import { redactSecrets } from "../security/redaction.js";
import { ValidationIntegrityError } from "../write/validation-integrity.js";
import { ValidationFailureError } from "../write/validate.js";
import { GitHubQuotaError } from "../github/request-policy.js";
import { SessionCheckpointError } from "../session/errors.js";
import type { ActionFailure, ActionPhase } from "./types.js";

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 4_000);
}

const dshFailureMetadata: Readonly<Record<string, { title: string; guidance: string }>> = {
  DSH_ABORTED: {
    title: "DeepSeek Harness was cancelled",
    guidance: "Check whether a newer workflow run cancelled this one, then rerun if needed.",
  },
  DSH_CONFIGURATION: {
    title: "DeepSeek Harness configuration is invalid",
    guidance: "Check the action inputs, pinned DSH version, and container image reference.",
  },
  DSH_CREDENTIAL_LEAK: {
    title: "Credential safety check stopped the run",
    guidance: "Rotate any potentially exposed credential and inspect the linked workflow run.",
  },
  DSH_ENVIRONMENT: {
    title: "The runner environment is not usable",
    guidance: "Check the runner prerequisites and the isolation configuration.",
  },
  DSH_ISOLATION_UNAVAILABLE: {
    title: "Required isolation is unavailable",
    guidance: "Ensure Docker is installed and available to the runner, then rerun the job.",
  },
  DSH_MALFORMED_OUTPUT: {
    title: "DSH output did not pass validation",
    guidance:
      "Retry once. If it persists, verify the pinned dsh-version and inspect the schema error in the workflow run.",
  },
  DSH_OUTPUT_LIMIT: {
    title: "DSH produced too much output",
    guidance: "Reduce the task scope or repository context before rerunning.",
  },
  DSH_PROCESS_FAILED: {
    title: "DeepSeek Harness exited unsuccessfully",
    guidance: "Inspect the workflow run for the worker error, then rerun after correcting it.",
  },
  DSH_PROXY: {
    title: "The DeepSeek API proxy failed",
    guidance:
      "Check API availability, the base URL, and the configured credential before rerunning.",
  },
  DSH_SPAWN: {
    title: "DeepSeek Harness could not start",
    guidance: "Check the runner runtime and configured DSH executable or container.",
  },
  DSH_TIMEOUT: {
    title: "DeepSeek Harness timed out",
    guidance: "Increase timeout-minutes or reduce the task scope, then rerun the workflow.",
  },
};

const categoryMetadata: Readonly<Record<ActionErrorCategory, { title: string; guidance: string }>> =
  {
    configuration: {
      title: "Action configuration is invalid",
      guidance: "Check the workflow inputs and required secrets.",
    },
    policy: {
      title: "The requested operation was denied",
      guidance: "Review the effective trust policy, permissions, and requested capabilities.",
    },
    domain: {
      title: "The requested operation could not be completed",
      guidance: "Inspect the workflow run and correct the reported operation state.",
    },
    runtime: {
      title: "The Action runtime failed",
      guidance: "Inspect the workflow run, correct the reported runtime condition, and retry.",
    },
  };

const unexpectedRuntimeMetadata = {
  code: "ACTION_RUNTIME_FAILED",
  category: "runtime",
  title: "The Action runtime failed",
  guidance: "Inspect the workflow run, correct the reported runtime condition, and retry.",
  retryable: true,
} as const;

function classifiedFailure(
  error: ClassifiedActionError,
  phase: ActionPhase,
  presentation: { readonly title: string; readonly guidance: string },
): ActionFailure {
  return {
    code: error.code,
    category: error.category,
    phase,
    title: presentation.title,
    message: safeMessage(error),
    guidance: presentation.guidance,
    retryable: error.retryable,
  };
}

export function describeActionFailure(error: unknown, phase: ActionPhase): ActionFailure {
  let quotaCause: unknown = error;
  for (
    let depth = 0;
    !isClassifiedActionError(error) && depth < 8 && quotaCause instanceof Error;
    depth += 1
  ) {
    if (quotaCause instanceof GitHubQuotaError) {
      error = quotaCause;
      break;
    }
    if (
      quotaCause instanceof GitHubEntityRevalidationError &&
      isClassifiedActionError(quotaCause.cause)
    ) {
      error = quotaCause.cause;
      break;
    }
    quotaCause = quotaCause.cause;
  }
  if (error instanceof GitHubQuotaError) {
    return classifiedFailure(error, phase, {
      title: "GitHub request quota is exhausted",
      guidance: `Inspect this credential scope's quota headers; recovery ${error.audit.resetAt ?? "time unknown"}. Check recorded external writes before rerunning. A different installation or release-monitor credential has a separate budget.`,
    });
  }
  if (error instanceof EntityBindingChangedError) {
    return classifiedFailure(error, phase, {
      title: "The bound GitHub entity changed during the run",
      guidance:
        "Inspect recorded effects and start a new run against the current entity or head. The stale operation is not retried automatically.",
    });
  }
  if (error instanceof AgentDeadlineError) {
    return classifiedFailure(error, phase, {
      title: "Action execution timed out",
      guidance: "Increase timeout-minutes or reduce the context, task, and validation scope.",
    });
  }
  if (error instanceof SessionCheckpointError) {
    return classifiedFailure(error, phase, {
      title: "Session checkpoint could not be accepted or saved",
      guidance:
        "Inspect the recorded Session source, claim and external effects. Correct the provenance, concurrency, compatibility or retention condition. Use the latest successful producer; do not replay writes or start a duplicate task after an uncertain upload.",
    });
  }
  if (error instanceof AgentNoProgressError && error.cause instanceof ValidationIntegrityError) {
    return classifiedFailure(error.cause, phase, {
      title: "Validation integrity policy blocked the write",
      guidance:
        "Review the validation-definition audit, restore or strengthen weakened scripts, tests, entrypoints, or configuration, and rerun. The Agent cannot lower validation-integrity; only trusted workflow configuration can change the policy.",
    });
  }
  if (error instanceof AgentNoProgressError || error instanceof AgentLoopLimitError) {
    return classifiedFailure(error, phase, {
      title:
        error instanceof AgentNoProgressError
          ? "Agent repair loop made no progress"
          : "Agent turn limit reached",
      guidance:
        error instanceof AgentNoProgressError
          ? "Inspect the repeated validation failure and adjust the task, tools, or repository setup."
          : "Increase max-turns or reduce the task scope, then rerun.",
    });
  }
  if (error instanceof ValidationIntegrityError) {
    return classifiedFailure(error, phase, {
      title: "Validation integrity policy blocked the write",
      guidance:
        "Review the validation-definition audit, restore or strengthen weakened scripts, tests, entrypoints, or configuration, and rerun. The Agent cannot lower validation-integrity; only trusted workflow configuration can change the policy.",
    });
  }
  if (error instanceof ValidationFailureError) {
    return classifiedFailure(error, phase, {
      title: error.timedOut ? "Validation timed out" : "Validation did not pass",
      guidance: error.timedOut
        ? "Reduce the validation workload or split the configured commands before rerunning."
        : "Inspect the failing command in the workflow run and correct the generated change or test setup.",
    });
  }
  if (error instanceof DshError) {
    const metadata = dshFailureMetadata[error.code] ?? categoryMetadata[error.category];
    return classifiedFailure(error, phase, metadata);
  }
  if (isClassifiedActionError(error)) {
    return classifiedFailure(error, phase, categoryMetadata[error.category]);
  }
  return {
    code: unexpectedRuntimeMetadata.code,
    category: unexpectedRuntimeMetadata.category,
    phase,
    title: unexpectedRuntimeMetadata.title,
    message: safeMessage(error),
    guidance: unexpectedRuntimeMetadata.guidance,
    retryable: unexpectedRuntimeMetadata.retryable,
  };
}

/** Build the provisional SIGINT/SIGTERM identity without cross-bundle instanceof checks. */
export function describeCancellationFailure(phase: ActionPhase): ActionFailure {
  return {
    code: "DSH_ABORTED",
    category: "runtime",
    phase,
    title: "DeepSeek Harness was cancelled",
    message: "DSH execution was aborted",
    guidance: "Check whether a newer workflow run cancelled this one, then rerun if needed.",
    retryable: true,
  };
}
