import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { DshConfigurationError, DshProxyError } from "./errors.js";

const DEFAULT_REQUEST_LIMIT = 8 * 1024 * 1024;
const DEFAULT_RESPONSE_LIMIT = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface DeepSeekProxyOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  /** Controller-selected Anthropic-compatible upstream used only by the web_search tool. */
  readonly webSearchBaseUrl?: string;
  readonly allowWebSearch?: boolean;
  readonly bindHost?: string;
  /** Hostname advertised to the worker, e.g. host.docker.internal. */
  readonly workerHost?: string;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
  readonly fetchImplementation?: typeof fetch;
}

export interface DeepSeekProxyHandle {
  readonly workerBaseUrl: string;
  /** Fixed worker base; the only accepted search endpoint below it is /messages. */
  readonly workerWebSearchBaseUrl?: string;
  readonly workerToken: string;
  readonly boundHost: string;
  readonly port: number;
  close(): Promise<void>;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DshConfigurationError(`${name} must be a positive integer`);
  }
  return value;
}

function authorized(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header ?? "");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function replyJson(response: ServerResponse, status: number, code: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = JSON.stringify({ error: { code, message: "DeepSeek proxy request failed" } });
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": String(Buffer.byteLength(body)),
    "content-type": "application/json",
  });
  response.end(body);
}

async function readBoundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > limit) throw new DshProxyError("Worker request exceeded the proxy request limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function makeUpstreamUrl(base: URL, rawPath: string): URL | null {
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;
  const incoming = new URL(rawPath, "http://worker.invalid");
  if (incoming.pathname !== "/chat/completions" && incoming.pathname !== "/v1/chat/completions") {
    return null;
  }
  const target = new URL(base);
  const basePath = target.pathname.replace(/\/+$/u, "");
  const incomingPath =
    basePath.endsWith("/v1") && incoming.pathname.startsWith("/v1/")
      ? incoming.pathname.slice(3)
      : incoming.pathname;
  target.pathname = `${basePath}${incomingPath}`;
  target.search = incoming.search;
  return target;
}

const WORKER_WEB_SEARCH_PATH = "/anthropic/v1/messages";

function makeWebSearchUpstreamUrl(base: URL, rawPath: string): URL | null {
  if (!rawPath.startsWith("/") || rawPath.startsWith("//")) return null;
  const incoming = new URL(rawPath, "http://worker.invalid");
  if (incoming.pathname !== WORKER_WEB_SEARCH_PATH || incoming.search !== "") return null;
  const target = new URL(base);
  target.pathname = `${target.pathname.replace(/\/+$/u, "")}/messages`;
  target.search = "";
  target.hash = "";
  return target;
}

async function streamResponse(
  upstream: Response,
  response: ServerResponse,
  limit: number,
): Promise<void> {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": upstream.headers.get("content-type") ?? "application/json",
  };
  const requestId = upstream.headers.get("x-request-id");
  if (requestId !== null) headers["x-request-id"] = requestId;
  const retryAfter = upstream.headers.get("retry-after");
  if (retryAfter !== null) headers["retry-after"] = retryAfter;
  const rateLimitReset = upstream.headers.get("x-ratelimit-reset");
  if (rateLimitReset !== null) headers["x-ratelimit-reset"] = rateLimitReset;
  response.writeHead(upstream.status, headers);

  if (upstream.body === null) {
    response.end();
    return;
  }
  const reader: ReadableStreamDefaultReader<Uint8Array> = upstream.body.getReader();
  let bytes = 0;
  try {
    let item = await reader.read();
    while (!item.done) {
      const chunk = item.value;
      bytes += chunk.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        response.destroy();
        return;
      }
      response.write(Buffer.from(chunk));
      item = await reader.read();
    }
    response.end();
  } finally {
    reader.releaseLock();
  }
}

interface ProxyRuntime {
  readonly apiKey: string;
  readonly token: string;
  readonly base: URL;
  readonly webSearchBase?: URL;
  readonly requestLimit: number;
  readonly responseLimit: number;
  readonly timeoutMs: number;
  readonly fetchImplementation: typeof fetch;
  readonly activeRequests: Set<AbortController>;
}

interface RoutedUpstream {
  readonly kind: "chat" | "web-search";
  readonly target: URL;
}

function routeUpstream(runtime: ProxyRuntime, rawPath: string): RoutedUpstream | null {
  const chat = makeUpstreamUrl(runtime.base, rawPath);
  if (chat !== null) return { kind: "chat", target: chat };
  if (runtime.webSearchBase === undefined) return null;
  const webSearch = makeWebSearchUpstreamUrl(runtime.webSearchBase, rawPath);
  return webSearch === null ? null : { kind: "web-search", target: webSearch };
}

function upstreamHeaders(
  request: IncomingMessage,
  runtime: ProxyRuntime,
  kind: RoutedUpstream["kind"],
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: request.headers.accept ?? "application/json",
    authorization: `Bearer ${runtime.apiKey}`,
    "content-type": request.headers["content-type"] ?? "application/json",
    "user-agent": "dsh-action-credential-proxy/1",
  };
  if (kind === "web-search") {
    // Replace both credential forms. Never forward worker-provided provider
    // credentials or any header outside this explicit Anthropic allowlist.
    headers["x-api-key"] = runtime.apiKey;
    const anthropicVersion = request.headers["anthropic-version"];
    if (typeof anthropicVersion === "string") headers["anthropic-version"] = anthropicVersion;
  }
  return headers;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: ProxyRuntime,
): Promise<void> {
  if (request.method !== "POST") {
    replyJson(response, 405, "method_not_allowed");
    return;
  }
  const authorization: string | undefined = request.headers.authorization;
  if (!authorized(authorization, runtime.token)) {
    replyJson(response, 401, "unauthorized");
    return;
  }

  const routed = routeUpstream(runtime, request.url ?? "");
  if (routed === null) {
    replyJson(response, 404, "endpoint_not_allowed");
    return;
  }

  const lengthHeader = request.headers["content-length"];
  if (
    typeof lengthHeader === "string" &&
    /^\d+$/u.test(lengthHeader) &&
    Number(lengthHeader) > runtime.requestLimit
  ) {
    replyJson(response, 413, "request_too_large");
    return;
  }

  let body: Buffer;
  try {
    body = await readBoundedBody(request, runtime.requestLimit);
  } catch {
    replyJson(response, 413, "request_too_large");
    return;
  }

  const controller = new AbortController();
  runtime.activeRequests.add(controller);
  const timer = setTimeout(() => controller.abort(), runtime.timeoutMs);
  timer.unref();
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });

  try {
    const upstream = await runtime.fetchImplementation(routed.target, {
      method: "POST",
      headers: upstreamHeaders(request, runtime, routed.kind),
      body,
      redirect: "error",
      signal: controller.signal,
    });
    await streamResponse(upstream, response, runtime.responseLimit);
  } catch (error: unknown) {
    if (!response.headersSent) {
      replyJson(response, controller.signal.aborted ? 504 : 502, "upstream_failed");
    } else {
      response.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    clearTimeout(timer);
    runtime.activeRequests.delete(controller);
  }
}

function validatedBaseUrl(raw: string, label: string): URL {
  let base: URL;
  try {
    base = new URL(raw);
  } catch (error: unknown) {
    throw new DshConfigurationError(`${label} is invalid`, { cause: error });
  }
  const loopbackHttp =
    base.protocol === "http:" &&
    (base.hostname === "127.0.0.1" || base.hostname === "::1" || base.hostname === "localhost");
  if (base.protocol !== "https:" && !loopbackHttp) {
    throw new DshConfigurationError(`${label} must use HTTPS (except loopback tests)`);
  }
  if (base.username !== "" || base.password !== "") {
    throw new DshConfigurationError(`${label} must not contain credentials`);
  }
  return base;
}

async function listen(server: Server, host: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(0, host, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new DshProxyError("Proxy did not receive a TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

export async function startDeepSeekProxy(
  options: DeepSeekProxyOptions,
): Promise<DeepSeekProxyHandle> {
  if (options.apiKey.trim() === "") throw new DshConfigurationError("DeepSeek API key is empty");

  const base = validatedBaseUrl(options.baseUrl, "DeepSeek base URL");
  if (options.allowWebSearch === true && options.webSearchBaseUrl === undefined) {
    throw new DshConfigurationError(
      "Web search base URL is required when Controller web search permission is enabled",
    );
  }
  const configuredWebSearchBase =
    options.webSearchBaseUrl === undefined
      ? undefined
      : validatedBaseUrl(options.webSearchBaseUrl, "Web search base URL");
  const webSearchBase = options.allowWebSearch === true ? configuredWebSearchBase : undefined;

  const bindHost = options.bindHost ?? "127.0.0.1";
  const workerHost = options.workerHost ?? bindHost;
  const token = randomBytes(32).toString("base64url");
  const activeRequests = new Set<AbortController>();
  const runtime: ProxyRuntime = {
    apiKey: options.apiKey,
    token,
    base,
    ...(webSearchBase === undefined ? {} : { webSearchBase }),
    requestLimit: positiveInteger(
      options.maxRequestBytes ?? DEFAULT_REQUEST_LIMIT,
      "maxRequestBytes",
    ),
    responseLimit: positiveInteger(
      options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT,
      "maxResponseBytes",
    ),
    timeoutMs: positiveInteger(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, "requestTimeoutMs"),
    fetchImplementation: options.fetchImplementation ?? fetch,
    activeRequests,
  };

  const server = createServer((request, response) => {
    void handleRequest(request, response, runtime);
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  let port: number;
  try {
    port = await listen(server, bindHost);
  } catch (error: unknown) {
    throw new DshProxyError("Failed to start the DeepSeek credential proxy", { cause: error });
  }

  let closed = false;
  return {
    workerBaseUrl: `http://${workerHost}:${String(port)}`,
    ...(webSearchBase === undefined
      ? {}
      : { workerWebSearchBaseUrl: `http://${workerHost}:${String(port)}/anthropic/v1` }),
    workerToken: token,
    boundHost: bindHost,
    port,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const controller of activeRequests) controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else
            reject(
              new DshProxyError("Failed to close the DeepSeek credential proxy", { cause: error }),
            );
        });
      });
    },
  };
}
