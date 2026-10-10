import { ClassifiedActionError } from "../errors.js";

/** A stale Controller binding cannot authorize replay of the current write. */
export class EntityBindingChangedError extends ClassifiedActionError<"ENTITY_BINDING_CHANGED"> {
  public constructor(message: string, options?: ErrorOptions) {
    super(
      message,
      { code: "ENTITY_BINDING_CHANGED", category: "domain", retryable: false },
      options,
    );
  }
}
