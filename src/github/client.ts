import { getOctokit } from "@actions/github";

import { createRequestPolicy, type GitHubRequestAudit } from "./request-policy.js";

export type GitHubClient = ReturnType<typeof getOctokit>;
const audits = new WeakMap<GitHubClient, () => GitHubRequestAudit>();

export function githubRequestAudit(client: GitHubClient): GitHubRequestAudit | undefined {
  return audits.get(client)?.();
}

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
export function createGitHubClient(
  token: string,
  signal?: AbortSignal,
  options: { readonly deadlineMs?: number } = {},
): GitHubClient {
  if (token.trim() === "") throw new Error("GitHub token is required");
  const client = getOctokit(token, { userAgent: "dsh-action/0.2" });
  const policy = createRequestPolicy(options);
  audits.set(client, policy.snapshot);
  client.hook.wrap("request", async (request, options) => {
    const suppliedSignal =
      options.request.signal instanceof AbortSignal ? options.request.signal : undefined;
    const effectiveSignal =
      signal === undefined
        ? suppliedSignal
        : suppliedSignal === undefined
          ? signal
          : AbortSignal.any([signal, suppliedSignal]);
    return await policy.run(
      async () => {
        if (effectiveSignal === undefined) return await request(options);
        const requestController = new AbortController();
        const abort = (): void => requestController.abort(abortReason(effectiveSignal));
        effectiveSignal.addEventListener("abort", abort, { once: true });
        if (effectiveSignal.aborted) abort();
        try {
          return await waitForRequest(
            async () =>
              await request({
                ...options,
                request: { ...options.request, signal: requestController.signal },
              }),
            effectiveSignal,
          );
        } finally {
          effectiveSignal.removeEventListener("abort", abort);
        }
      },
      {
        ...options,
        request: {
          ...options.request,
          ...(effectiveSignal === undefined ? {} : { signal: effectiveSignal }),
        },
      },
    );
  });
  return client;
}
