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
});
