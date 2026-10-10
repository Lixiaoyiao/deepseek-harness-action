import { isRecord } from "../security/record.js";
import { ClassifiedActionError } from "../errors.js";

export interface GitHubRequestAudit {
  readonly credentialScope: "production-action";
  readonly clientRole: "main-controller";
  readonly requests: number;
  readonly cacheHits: number;
  readonly coalesced: number;
  readonly retries: number;
  readonly waitMs: number;
  readonly quotaFailures: number;
  readonly resetAt?: string;
  readonly resource?: string;
}

export class GitHubQuotaError extends ClassifiedActionError<"GITHUB_QUOTA_EXHAUSTED"> {
  public constructor(
    public readonly audit: GitHubRequestAudit,
    public readonly status = 429,
  ) {
    super(
      `GitHub quota stopped the production Action credential scope; recovery: ${audit.resetAt ?? "unknown"}. No write request was retried.`,
      { code: "GITHUB_QUOTA_EXHAUSTED", category: "runtime", retryable: true },
    );
  }
}

type Options = Record<string, unknown>;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 128;
const MAX_WAIT_MS = 15_000;

function record(value: unknown): Options {
  return isRecord(value) ? value : {};
}

function requestSignal(options: Options): AbortSignal | undefined {
  const signal = record(options.request).signal;
  if (signal === undefined) return undefined;
  if (!(signal instanceof AbortSignal))
    throw new Error("GitHub request signal must be an AbortSignal");
  return signal;
}

function integer(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/u.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function immutableKey(options: Options): string | undefined {
  if (record(options.request).dshImmutable !== true || options.method !== "GET") return undefined;
  const raw = typeof options.url === "string" ? options.url : "";
  const url = raw.replace(/\{([^}]+)\}/gu, (_, name: string) =>
    typeof options[name] === "string" ? encodeURIComponent(options[name]) : "?",
  );
  if (!/\/git\/(?:blobs|trees)\/[a-f0-9]{40}(?:\?|$)/u.test(url)) return undefined;
  // Only callers collecting immutable text explicitly opt in. Authorization,
  // identity revalidation and side-effect reconciliation never set this flag.
  return JSON.stringify([url, options.recursive ?? "", record(options.headers).accept ?? ""]);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("GitHub wait cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted === true) abort();
  });
}

/** One client / one run / one credential scope. Never persists response data. */
export function createRequestPolicy(
  options: {
    readonly deadlineMs?: number;
    readonly now?: () => number;
    readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? delay;
  const cache = new Map<string, { value: unknown; bytes: number }>();
  const pending = new Map<string, Promise<unknown>>();
  let cacheBytes = 0;
  const audit = {
    credentialScope: "production-action" as const,
    requests: 0,
    cacheHits: 0,
    coalesced: 0,
    retries: 0,
    waitMs: 0,
    quotaFailures: 0,
    resetAt: undefined as string | undefined,
    resource: undefined as string | undefined,
  };
  const snapshot = (): GitHubRequestAudit => ({
    credentialScope: audit.credentialScope,
    clientRole: "main-controller",
    requests: audit.requests,
    cacheHits: audit.cacheHits,
    coalesced: audit.coalesced,
    retries: audit.retries,
    waitMs: audit.waitMs,
    quotaFailures: audit.quotaFailures,
    ...(audit.resetAt === undefined ? {} : { resetAt: audit.resetAt }),
    ...(audit.resource === undefined ? {} : { resource: audit.resource }),
  });

  const perform = async <T>(
    request: (options: Options) => Promise<T>,
    requestOptions: Options,
  ): Promise<T> => {
    const signal = requestSignal(requestOptions);
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted === true) throw signal.reason;
      audit.requests += 1;
      try {
        return await request(requestOptions);
      } catch (error: unknown) {
        const status = record(error).status;
        const headers = record(record(error).response).headers;
        const remaining = integer(record(headers)["x-ratelimit-remaining"]);
        const retryAfter = integer(record(headers)["retry-after"]);
        const serverMessage = record(record(record(error).response).data).message;
        const secondaryLimit =
          typeof serverMessage === "string" && /\bsecondary rate limit\b/iu.test(serverMessage);
        if (
          status !== 429 &&
          !(status === 403 && (remaining === 0 || retryAfter !== undefined || secondaryLimit))
        ) {
          throw error;
        }
        audit.quotaFailures += 1;
        const reset = integer(record(headers)["x-ratelimit-reset"]);
        const resetMs = reset === undefined ? undefined : reset * 1000;
        const recoveryTimes = [
          ...(remaining === 0 && resetMs !== undefined ? [resetMs] : []),
          ...(retryAfter === undefined ? [] : [now() + retryAfter * 1000]),
        ];
        const recoveryMs = recoveryTimes.length === 0 ? undefined : Math.max(...recoveryTimes);
        audit.resetAt = undefined;
        if (recoveryMs !== undefined && Number.isFinite(new Date(recoveryMs).getTime())) {
          audit.resetAt = new Date(recoveryMs).toISOString();
        }
        const resource = record(headers)["x-ratelimit-resource"];
        if (typeof resource === "string" && /^[a-z_]{1,40}$/u.test(resource))
          audit.resource = resource;
        const waitMs = Math.max(1000 * 2 ** attempt, (recoveryMs ?? now() + 60_000) - now() + 250);
        // Retry reads only, at most twice, and never past this task's budget.
        // A write rejection is surfaced for the existing mutation reconciler.
        if (
          requestOptions.method !== "GET" ||
          attempt >= 2 ||
          audit.waitMs + waitMs > MAX_WAIT_MS ||
          now() + waitMs + 1000 >= (options.deadlineMs ?? now() + MAX_WAIT_MS)
        )
          throw new GitHubQuotaError(snapshot(), typeof status === "number" ? status : 429);
        audit.waitMs += waitMs;
        audit.retries += 1;
        await sleep(waitMs, signal);
      }
    }
  };

  const run = async <T>(
    request: (options: Options) => Promise<T>,
    requestOptions: Options,
  ): Promise<T> => {
    const signal = requestSignal(requestOptions);
    if (signal?.aborted === true) throw signal.reason;
    const key = immutableKey(requestOptions);
    if (key === undefined) return await perform(request, requestOptions);
    const cached = cache.get(key);
    if (cached !== undefined) {
      audit.cacheHits += 1;
      // The immutable Octokit route key preserves its response type across this heterogeneous cache.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return structuredClone(cached.value) as T;
    }
    const existing = pending.get(key);
    if (existing !== undefined) {
      audit.coalesced += 1;
      // Coalesced requests use the same immutable route and response contract as this caller.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      return structuredClone(await existing) as T;
    }
    const promise = perform(request, requestOptions);
    pending.set(key, promise);
    try {
      const value = await promise;
      const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
      if (
        bytes <= MAX_CACHE_BYTES &&
        cache.size < MAX_CACHE_ENTRIES &&
        cacheBytes + bytes <= MAX_CACHE_BYTES
      ) {
        cache.set(key, { value: structuredClone(value), bytes });
        cacheBytes += bytes;
      }
      return value;
    } finally {
      pending.delete(key);
    }
  };
  return { run, snapshot };
}
