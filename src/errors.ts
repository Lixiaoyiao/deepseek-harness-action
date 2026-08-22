export type ActionErrorCategory = "configuration" | "policy" | "domain" | "runtime";

/** Stable semantic identity carried by known Action errors. */
export interface ActionErrorIdentity<Code extends string = string> {
  readonly code: Code;
  readonly category: ActionErrorCategory;
  readonly retryable: boolean;
}

export abstract class ClassifiedActionError<Code extends string = string>
  extends Error
  implements ActionErrorIdentity<Code>
{
  public readonly code: Code;
  public readonly category: ActionErrorCategory;
  public readonly retryable: boolean;

  protected constructor(
    message: string,
    identity: ActionErrorIdentity<Code>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = identity.code;
    this.category = identity.category;
    this.retryable = identity.retryable;
  }
}

export function isClassifiedActionError(error: unknown): error is ClassifiedActionError {
  return error instanceof ClassifiedActionError;
}

export class ActionConfigurationError extends ClassifiedActionError<"ACTION_CONFIGURATION"> {
  public constructor(message: string, options?: ErrorOptions) {
    super(
      message,
      { code: "ACTION_CONFIGURATION", category: "configuration", retryable: false },
      options,
    );
  }
}

export class PolicyDeniedError extends ClassifiedActionError<"POLICY_DENIED"> {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, { code: "POLICY_DENIED", category: "policy", retryable: false }, options);
  }
}

export class EventRoutingError extends ClassifiedActionError<"EVENT_ROUTING_FAILED"> {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, { code: "EVENT_ROUTING_FAILED", category: "domain", retryable: false }, options);
  }
}

export class OperationContextError extends ClassifiedActionError<"OPERATION_CONTEXT_INVALID"> {
  public constructor(message: string, options?: ErrorOptions) {
    super(
      message,
      { code: "OPERATION_CONTEXT_INVALID", category: "domain", retryable: false },
      options,
    );
  }
}
