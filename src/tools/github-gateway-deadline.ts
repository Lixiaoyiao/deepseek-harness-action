import type { GitHubBackendRequestControl } from "./github-backend.js";

const MAX_API_CALL_MS = 15_000;

export interface GitHubInvocationDeadline {
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

function abortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error ? signal.reason : new Error("GitHub tool request aborted");
}

/** Apply the invocation deadline and cancellation signal to one bounded backend request. */
export async function callGitHubApi<T>(
  invocation: GitHubInvocationDeadline,
  start: (control: GitHubBackendRequestControl) => Promise<T>,
): Promise<T> {
  if (invocation.signal?.aborted === true) throw abortError(invocation.signal);
  const remainingMs = invocation.deadlineMs - Date.now();
  if (remainingMs <= 0) throw new Error("GitHub tool invocation deadline exhausted");
  const timeoutMs = Math.min(MAX_API_CALL_MS, remainingMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("GitHub API request timed out")),
    timeoutMs,
  );
  const forwardAbort = (): void => controller.abort(abortError(invocation.signal));
  invocation.signal?.addEventListener("abort", forwardAbort, { once: true });
  try {
    const promise = start({ timeoutMs, signal: controller.signal });
    return await new Promise<T>((resolve, reject) => {
      const abort = (): void => reject(abortError(controller.signal));
      controller.signal.addEventListener("abort", abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener("abort", abort));
    });
  } finally {
    clearTimeout(timer);
    invocation.signal?.removeEventListener("abort", forwardAbort);
  }
}
