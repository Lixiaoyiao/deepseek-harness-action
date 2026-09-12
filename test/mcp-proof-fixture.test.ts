import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

interface FixtureEndpoint {
  readonly healthUrl: string;
  readonly workerUrl: string;
  readonly expectedProof: string;
}

interface Fixture extends FixtureEndpoint {
  readonly client: Client;
  readonly auditPath: string;
  readonly close: () => Promise<void>;
}

const fixtures: Fixture[] = [];
const roots: string[] = [];

async function stopProcess(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 1_000);
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("MCP fixture process did not stop")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(force);
    clearTimeout(deadline);
  }
}

async function startFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "dsh-mcp-proof-test-"));
  roots.push(root);
  const auditPath = join(root, "audit.jsonl");
  await writeFile(auditPath, "");
  const child = spawn(process.execPath, [join(process.cwd(), ".github/e2e/mcp-http-server.mjs")], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      DSH_E2E_MCP_AUDIT: auditPath,
    },
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const client = new Client({ name: "mcp-proof-regression", version: "1.0.0" });
  try {
    const endpoint = await new Promise<FixtureEndpoint>((resolve, reject) => {
      let output = "";
      let stderr = "";
      const timeout = setTimeout(() => reject(new Error("MCP fixture startup timed out")), 10_000);
      const fail = (error: Error): void => {
        clearTimeout(timeout);
        reject(error);
      };
      child.once("error", fail);
      child.once("exit", () => fail(new Error(`MCP fixture exited early: ${stderr}`)));
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output) > 16_384) {
          fail(new Error("MCP fixture endpoint exceeded its byte limit"));
          return;
        }
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = JSON.parse(output.slice(0, newline)) as Partial<FixtureEndpoint>;
          if (
            typeof value.healthUrl !== "string" ||
            !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/health$/u.test(value.healthUrl) ||
            typeof value.workerUrl !== "string" ||
            !/^http:\/\/host\.docker\.internal:[1-9][0-9]*\/mcp$/u.test(value.workerUrl) ||
            typeof value.expectedProof !== "string" ||
            !/^[a-f0-9]{48}$/u.test(value.expectedProof)
          ) {
            throw new Error("MCP fixture emitted an invalid startup contract");
          }
          clearTimeout(timeout);
          resolve({
            healthUrl: value.healthUrl,
            workerUrl: value.workerUrl,
            expectedProof: value.expectedProof,
          });
        } catch (error: unknown) {
          fail(error instanceof Error ? error : new Error("MCP fixture startup was not JSON"));
        }
      });
    });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", endpoint.healthUrl), {
      reconnectionOptions: {
        initialReconnectionDelay: 100,
        maxReconnectionDelay: 100,
        reconnectionDelayGrowFactor: 1,
        maxRetries: 0,
      },
    });
    // The SDK transport's optional sessionId declaration conflicts with its
    // shared interface under exactOptionalPropertyTypes, as in the native
    // ecosystem fixture. This is only a type adaptation of the real transport.
    await client.connect(transport as Transport, { timeout: 5_000 });
    const fixture: Fixture = {
      ...endpoint,
      client,
      auditPath,
      close: async () => {
        try {
          await client.close();
        } finally {
          await stopProcess(child, closed);
        }
      },
    };
    fixtures.push(fixture);
    return fixture;
  } catch (error: unknown) {
    try {
      await client.close();
    } finally {
      await stopProcess(child, closed);
    }
    throw error;
  }
}

async function toolText(
  client: Client,
  name: string,
  args: Record<string, string>,
): Promise<string> {
  const result = CallToolResultSchema.parse(
    await client.callTool({ name, arguments: args }, undefined, { timeout: 5_000 }),
  );
  expect(result.isError).not.toBe(true);
  expect(result.content).toHaveLength(1);
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("MCP fixture returned non-text content");
  return content.text;
}

afterEach(async () => {
  const closed = await Promise.allSettled(
    fixtures.splice(0).map(async (fixture) => fixture.close()),
  );
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) =>
        rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
  );
  for (const result of closed) if (result.status === "rejected") throw result.reason;
});

describe("MCP invocation proof fixture", () => {
  it("returns a stable per-process proof only through actual echo calls", async () => {
    const first = await startFixture();
    const second = await startFixture();
    expect(first.expectedProof).not.toBe(second.expectedProof);
    for (const fixture of [first, second]) {
      const health = await fetch(fixture.healthUrl, { signal: AbortSignal.timeout(5_000) });
      expect(health.ok).toBe(true);
      expect(await health.text()).toBe("ok\n");
      const inventory = await fixture.client.listTools(undefined, { timeout: 5_000 });
      expect(inventory.tools.map(({ name }) => name).sort()).toEqual(["echo", "hidden"]);
      expect(JSON.stringify(inventory)).not.toContain(fixture.expectedProof);
      expect(await readFile(fixture.auditPath, "utf8")).toBe("");
      for (let call = 0; call < 2; call += 1) {
        const text = await toolText(fixture.client, "echo", { marker: "rc2-mcp-allow" });
        expect(JSON.parse(text) as unknown).toEqual({
          marker: "rc2-mcp-allow",
          proof: fixture.expectedProof,
        });
      }
      const audit = await readFile(fixture.auditPath, "utf8");
      expect(audit).not.toContain(fixture.expectedProof);
      expect(audit.trim().split("\n")).toHaveLength(2);
    }
  });

  it("records echo and hidden execution without exposing proof or arbitrary markers in the audit", async () => {
    const fixture = await startFixture();
    await toolText(fixture.client, "echo", { marker: "rc2-mcp-allow" });
    expect(await toolText(fixture.client, "hidden", {})).toBe("DSH_E2E_MCP_HIDDEN_EXECUTED");
    for (const marker of [fixture.expectedProof, "unexpected-private-model-text"]) {
      const text = await toolText(fixture.client, "echo", { marker });
      expect(JSON.parse(text) as unknown).toEqual({ marker, proof: fixture.expectedProof });
    }
    const text = await readFile(fixture.auditPath, "utf8");
    expect(text).not.toContain(fixture.expectedProof);
    expect(text).not.toContain("unexpected-private-model-text");
    const rows = text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    const observedAt: unknown = expect.stringMatching(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
    );
    expect(rows).toEqual([
      { tool: "echo", input: { marker: "rc2-mcp-allow" }, observedAt },
      { tool: "hidden", input: {}, observedAt },
      { tool: "echo", input: { marker: "[unexpected marker]" }, observedAt },
      { tool: "echo", input: { marker: "[unexpected marker]" }, observedAt },
    ]);
    await fixture.client.close();
    const health = await fetch(fixture.healthUrl, { signal: AbortSignal.timeout(5_000) });
    expect(health.ok).toBe(true);
    await health.body?.cancel();
  });
});
