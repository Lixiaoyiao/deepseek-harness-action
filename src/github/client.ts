import { getOctokit } from "@actions/github";

export type GitHubClient = ReturnType<typeof getOctokit>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Controller GitHub request was cancelled");
}

async function waitForRequest<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  const pending = request();
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish =
      (callback: (value: T) => void) =>
      (value: T): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        callback(value);
      };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      reject(
        error instanceof Error
          ? error
          : new Error("Controller GitHub request failed", { cause: error }),
      );
    };
    const abort = (): void => fail(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    pending.then(finish(resolve), fail);
  });
}

/** The controller owns this client; its token must never enter a DSH child environment. */
export function createGitHubClient(token: string, signal?: AbortSignal): GitHubClient {
  if (token.trim() === "") throw new Error("GitHub token is required");
  const client = getOctokit(token, { userAgent: "dsh-action/0.2" });
  if (signal !== undefined) {
    client.hook.wrap("request", async (request, options) => {
      return await waitForRequest(
        async () =>
          await request({
            ...options,
            request: { ...options.request, signal },
          }),
        signal,
      );
    });
  }
  return client;
}
