import type { GitHubBackendRequestControl } from "./github-backend.js";
import { callGitHubApi, type GitHubInvocationDeadline } from "./github-gateway-deadline.js";
import { GitHubEntityRevalidationError } from "./github-gateway-revalidation.js";

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isAmbiguousGitHubMutationError(error: unknown): boolean {
  if (error instanceof GitHubEntityRevalidationError) return false;
  const status = errorStatus(error);
  return status === undefined || status === 408 || status === 429 || status >= 500;
}

export interface GitHubMutationResult<T> {
  readonly value: T;
  readonly attempts: number;
  readonly effect: "updated" | "unchanged";
  readonly reconciled: boolean;
}

export class GitHubMutationExecutionError extends Error {
  public constructor(
    public readonly attempts: number,
    public readonly reconciled: boolean,
    public readonly externalEffect: "none" | "possible" | "confirmed",
    options?: ErrorOptions,
  ) {
    super("GitHub mutation failed its bounded retry and reconciliation policy", options);
    this.name = "GitHubMutationExecutionError";
  }
}

/** Run one idempotent mutation with a bounded retry and observable postcondition. */
export async function mutateGitHubWithPostcondition<T>(options: {
  readonly invocation: GitHubInvocationDeadline;
  readonly read: (control: GitHubBackendRequestControl) => Promise<T>;
  readonly mutate: (control: GitHubBackendRequestControl, markStarted: () => void) => Promise<void>;
  readonly matches: (value: T) => boolean;
}): Promise<GitHubMutationResult<T>> {
  const read = async (): Promise<T> => await callGitHubApi(options.invocation, options.read);
  const before = await read();
  if (options.matches(before)) {
    return { value: before, attempts: 0, effect: "unchanged", reconciled: true };
  }
  let attempts = 0;
  let lastError: unknown;
  let reconciled = false;
  let possibleExternalEffect = false;
  while (attempts < 2) {
    attempts += 1;
    const mutation = { started: false };
    let mutationAcknowledged = false;
    try {
      await callGitHubApi(options.invocation, async (control) =>
        options.mutate(control, () => {
          mutation.started = true;
        }),
      );
      mutationAcknowledged = true;
      const after = await read();
      if (!options.matches(after)) {
        throw new Error("GitHub mutation postcondition did not match the requested state");
      }
      return { value: after, attempts, effect: "updated", reconciled: true };
    } catch (error: unknown) {
      if (mutationAcknowledged) {
        throw new GitHubMutationExecutionError(attempts, reconciled, "confirmed", {
          cause: error,
        });
      }
      if (!mutation.started || error instanceof GitHubEntityRevalidationError) {
        throw new GitHubMutationExecutionError(
          attempts,
          reconciled,
          possibleExternalEffect ? "possible" : "none",
          { cause: error },
        );
      }
      if (options.invocation.signal?.aborted === true || !isAmbiguousGitHubMutationError(error)) {
        const externalEffect =
          possibleExternalEffect || isAmbiguousGitHubMutationError(error) ? "possible" : "none";
        throw new GitHubMutationExecutionError(attempts, reconciled, externalEffect, {
          cause: error,
        });
      }
      possibleExternalEffect = true;
      lastError = error;
      try {
        const value = await read();
        reconciled = true;
        if (options.matches(value)) {
          return { value, attempts, effect: "updated", reconciled: true };
        }
      } catch (readError: unknown) {
        throw new GitHubMutationExecutionError(attempts, reconciled, "possible", {
          cause: readError,
        });
      }
    }
  }
  throw new GitHubMutationExecutionError(
    attempts,
    reconciled,
    possibleExternalEffect ? "possible" : "none",
    { cause: lastError },
  );
}
