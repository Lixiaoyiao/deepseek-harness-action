import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const auditPath = process.env.DSH_E2E_MCP_AUDIT;
if (!auditPath) throw new Error("DSH_E2E_MCP_AUDIT is required");

async function record(tool, input) {
  await appendFile(
    auditPath,
    `${JSON.stringify({ tool, input, observedAt: new Date().toISOString() })}\n`,
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
      description: "Return the supplied E2E marker unchanged.",
      inputSchema: { marker: z.string().min(1).max(128) },
    },
    async ({ marker }) => {
      await record("echo", { marker });
      return { content: [{ type: "text", text: `DSH_E2E_MCP_ECHO:${marker}` }] };
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
  handleMcp(request, response).catch((error) => {
    if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
    response.end(error instanceof Error ? error.message : String(error));
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
    })}\n`,
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
