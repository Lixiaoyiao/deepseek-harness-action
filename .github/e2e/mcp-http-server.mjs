import { randomBytes } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const auditPath = process.env.DSH_E2E_MCP_AUDIT;
if (!auditPath) throw new Error("DSH_E2E_MCP_AUDIT is required");
const proof = randomBytes(24).toString("hex");
let auditCalls = 0;

async function record(tool, input) {
  auditCalls += 1;
  if (auditCalls > 100) throw new Error("MCP fixture audit exceeded its call bound");
  // Artifacts retain the fixed expected marker or a mismatch category, never
  // arbitrary model arguments or a proof echoed back as a subsequent input.
  const safeInput =
    tool === "echo"
      ? { marker: input.marker === "rc2-mcp-allow" ? "rc2-mcp-allow" : "[unexpected marker]" }
      : {};
  await appendFile(
    auditPath,
    `${JSON.stringify({ tool, input: safeInput, observedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

async function handleMcp(request, response) {
  const mcp = new McpServer(
    { name: "dsh-action-e2e", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "echo",
    {
      description:
        "Return the supplied E2E marker and the opaque proof available only by calling this tool.",
      inputSchema: { marker: z.string().min(1).max(128) },
    },
    async ({ marker }) => {
      await record("echo", { marker });
      return { content: [{ type: "text", text: JSON.stringify({ marker, proof }) }] };
    },
  );
  mcp.registerTool(
    "hidden",
    { description: "A denied E2E control tool.", inputSchema: {} },
    async () => {
      await record("hidden", {});
      return { content: [{ type: "text", text: "DSH_E2E_MCP_HIDDEN_EXECUTED" }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({});
  response.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  if (request.url !== "/mcp") {
    response.writeHead(404).end();
    return;
  }
  handleMcp(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
    response.end("MCP fixture request failed");
  });
});

server.listen(0, "0.0.0.0", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  process.stdout.write(
    `${JSON.stringify({
      healthUrl: `http://127.0.0.1:${String(address.port)}/health`,
      workerUrl: `http://host.docker.internal:${String(address.port)}/mcp`,
      // stdout is redirected to a Controller-only runner temporary file.
      expectedProof: proof,
    })}\n`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
