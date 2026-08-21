import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { startDeepSeekProxy } from "../src/dsh/proxy.js";
import type { DeepSeekProxyHandle } from "../src/dsh/proxy.js";

const handles: DeepSeekProxyHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map(async (handle) => handle.close()));
});

describe("DeepSeek credential proxy", () => {
  it("rejects non-HTTPS upstream base URLs", async () => {
    await expect(
      startDeepSeekProxy({ apiKey: "real-key", baseUrl: "http://api.example.test" }),
    ).rejects.toThrow("must use HTTPS");
  });

  it("validates the Controller-bound web search upstream", async () => {
    await expect(
      startDeepSeekProxy({
        apiKey: "real-key",
        baseUrl: "https://api.deepseek.example/v1",
        allowWebSearch: true,
      }),
    ).rejects.toThrow("required when Controller web search permission is enabled");
    await expect(
      startDeepSeekProxy({
        apiKey: "real-key",
        baseUrl: "https://api.deepseek.example/v1",
        allowWebSearch: true,
        webSearchBaseUrl: "http://api.anthropic.example/v1",
      }),
    ).rejects.toThrow("Web search base URL must use HTTPS");
    await expect(
      startDeepSeekProxy({
        apiKey: "real-key",
        baseUrl: "https://api.deepseek.example/v1",
        allowWebSearch: true,
        webSearchBaseUrl: "https://credential@example.test/v1",
      }),
    ).rejects.toThrow("must not contain credentials");
  });
  it("authenticates the worker and substitutes the real upstream credential", async () => {
    let upstreamAuthorization = "";
    let upstreamBody = "";
    const upstream = createServer((request, response) => {
      upstreamAuthorization = request.headers.authorization ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        upstreamBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"choices":[]}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;

    try {
      const handle = await startDeepSeekProxy({
        apiKey: "controller-real-key",
        baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
      });
      handles.push(handle);

      const denied = await fetch(`${handle.workerBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: "{}",
      });
      expect(denied.status).toBe(401);

      const accepted = await fetch(`${handle.workerBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${handle.workerToken}`,
          "content-type": "application/json",
        },
        body: '{"model":"deepseek-chat"}',
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ choices: [] });
      expect(upstreamAuthorization).toBe("Bearer controller-real-key");
      expect(upstreamAuthorization).not.toContain(handle.workerToken);
      expect(upstreamBody).toContain("deepseek-chat");
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("allows only completion POSTs and bounds worker request bodies", async () => {
    const handle = await startDeepSeekProxy({
      apiKey: "controller-real-key",
      baseUrl: "http://127.0.0.1:1",
      maxRequestBytes: 4,
    });
    handles.push(handle);
    const headers = { authorization: `Bearer ${handle.workerToken}` };
    expect((await fetch(`${handle.workerBaseUrl}/models`, { headers })).status).toBe(405);
    expect(
      (await fetch(`${handle.workerBaseUrl}/models`, { method: "POST", headers })).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${handle.workerBaseUrl}/chat/completions`, {
          method: "POST",
          headers,
          body: "12345",
        })
      ).status,
    ).toBe(413);
  });

  it("keeps the exact web search route disabled without Controller permission", async () => {
    const handle = await startDeepSeekProxy({
      apiKey: "controller-real-key",
      baseUrl: "http://127.0.0.1:1/v1",
      webSearchBaseUrl: "http://127.0.0.1:2/v1",
      allowWebSearch: false,
    });
    handles.push(handle);

    expect(handle.workerWebSearchBaseUrl).toBeUndefined();
    const response = await fetch(`${handle.workerBaseUrl}/anthropic/v1/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.workerToken}` },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });

  it("mediates only the exact Anthropic messages route and replaces both credentials", async () => {
    let upstreamPath = "";
    let upstreamAuthorization = "";
    let upstreamApiKey = "";
    let upstreamVersion = "";
    let upstreamBeta = "";
    let upstreamAccept = "";
    let upstreamContentType = "";
    let upstreamBody = "";
    let upstreamRequests = 0;
    const upstream = createServer((request, response) => {
      upstreamRequests += 1;
      upstreamPath = request.url ?? "";
      upstreamAuthorization = request.headers.authorization ?? "";
      upstreamApiKey =
        typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : "";
      upstreamVersion =
        typeof request.headers["anthropic-version"] === "string"
          ? request.headers["anthropic-version"]
          : "";
      upstreamBeta =
        typeof request.headers["anthropic-beta"] === "string"
          ? request.headers["anthropic-beta"]
          : "";
      upstreamAccept = request.headers.accept ?? "";
      upstreamContentType = request.headers["content-type"] ?? "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        upstreamBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"content":[]}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address() as AddressInfo;

    try {
      const handle = await startDeepSeekProxy({
        apiKey: "controller-real-key",
        baseUrl: "http://127.0.0.1:1/v1",
        webSearchBaseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        allowWebSearch: true,
      });
      handles.push(handle);
      const workerSearchBase = handle.workerWebSearchBaseUrl;
      if (workerSearchBase === undefined)
        throw new Error("Worker web search route was not exposed");
      expect(workerSearchBase).toBe(`${handle.workerBaseUrl}/anthropic/v1`);

      const wrongCredential = await fetch(`${workerSearchBase}/messages`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "{}",
      });
      expect(wrongCredential.status).toBe(401);

      for (const path of [
        `${workerSearchBase}/messages/extra`,
        `${workerSearchBase}/messages?url=https://attacker.invalid`,
        `${handle.workerBaseUrl}/anthropic/v1/web_fetch`,
      ]) {
        const denied = await fetch(path, {
          method: "POST",
          headers: { authorization: `Bearer ${handle.workerToken}` },
          body: "{}",
        });
        expect(denied.status).toBe(404);
      }
      expect(upstreamRequests).toBe(0);

      const accepted = await fetch(`${workerSearchBase}/messages`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${handle.workerToken}`,
          "x-api-key": "worker-forged-key",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "not-allowed",
          "content-type": "application/json",
        },
        body: '{"model":"deepseek-chat","tools":[{"type":"web_search_20250305"}]}',
      });
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ content: [] });
      expect(upstreamRequests).toBe(1);
      expect(upstreamPath).toBe("/v1/messages");
      expect(upstreamAuthorization).toBe("Bearer controller-real-key");
      expect(upstreamApiKey).toBe("controller-real-key");
      expect(upstreamAuthorization).not.toContain(handle.workerToken);
      expect(upstreamApiKey).not.toBe("worker-forged-key");
      expect(upstreamVersion).toBe("2023-06-01");
      expect(upstreamBeta).toBe("");
      expect(upstreamAccept).toBe("application/json");
      expect(upstreamContentType).toBe("application/json");
      expect(upstreamBody).toContain("web_search_20250305");
    } finally {
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it("applies the shared request bound to web search", async () => {
    const handle = await startDeepSeekProxy({
      apiKey: "controller-real-key",
      baseUrl: "http://127.0.0.1:1/v1",
      webSearchBaseUrl: "http://127.0.0.1:2/v1",
      allowWebSearch: true,
      maxRequestBytes: 4,
    });
    handles.push(handle);
    const workerSearchBase = handle.workerWebSearchBaseUrl;
    if (workerSearchBase === undefined) throw new Error("Worker web search route was not exposed");
    const response = await fetch(`${workerSearchBase}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${handle.workerToken}` },
      body: "12345",
    });
    expect(response.status).toBe(413);
  });
});
