import { ClassifiedActionError } from "../errors.js";

export class AgentLoopLimitError extends ClassifiedActionError<"AGENT_TURN_LIMIT"> {
  public constructor(maxTurns: number, options?: ErrorOptions) {
    super(
      `Agent did not reach a final result within ${String(maxTurns)} turns`,
      { code: "AGENT_TURN_LIMIT", category: "domain", retryable: false },
      options,
    );
  }
}

export class AgentDeadlineError extends ClassifiedActionError<"AGENT_TIMEOUT"> {
  public constructor(message = "The controller-owned agent loop exceeded its overall timeout") {
    super(message, { code: "AGENT_TIMEOUT", category: "runtime", retryable: true });
  }
}

export class AgentNoProgressError extends ClassifiedActionError<"AGENT_NO_PROGRESS"> {
  public constructor(options?: ErrorOptions) {
    super(
      "Validation failed twice with the same workspace revision and error",
      { code: "AGENT_NO_PROGRESS", category: "domain", retryable: false },
      options,
    );
  }
}
