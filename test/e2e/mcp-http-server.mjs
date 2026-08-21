import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const auditPath = process.env.MCP_AUDIT_PATH;
const port = Number(process.env.MCP_PORT ?? "32123");

if (typeof auditPath !== "string" || auditPath.length === 0) {
  throw new Error("MCP_AUDIT_PATH is required");
}
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("MCP_PORT must be a valid TCP port");
}

async function audit(tool, request, extra = {}) {
  await appendFile(
    auditPath,
    `${JSON.stringify({
      tool,
      authorization: request.headers.authorization ?? null,
      marker: request.headers["x-dsh-e2e"] ?? null,
      ...extra,
    })}\n`,
    "utf8",
  );
}

const httpServer = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  if (request.url !== "/mcp") {
    request.resume();
    response.writeHead(404).end();
    return;
  }

  const mcp = new McpServer(
    { name: "dsh-action-v050-release-e2e", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  mcp.registerTool(
    "echo",
    {
      description: "Return the controlled v0.5 release marker",
      inputSchema: { marker: z.string() },
    },
    async ({ marker }) => {
      await audit("echo", request, { argument: marker });
      return { content: [{ type: "text", text: `MCP_ECHO_OK:${marker}` }] };
    },
  );
  mcp.registerTool(
    "always_fail",
    { description: "Return the expected controlled MCP error", inputSchema: {} },
    async () => {
      await audit("always_fail", request);
      return {
        isError: true,
        content: [{ type: "text", text: "MCP_EXPECTED_FAILURE" }],
      };
    },
  );
  mcp.registerTool(
    "hidden",
    { description: "This tool is configured but never authorized", inputSchema: {} },
    async () => {
      await audit("hidden", request);
      return {
        content: [{ type: "text", text: "MCP_HIDDEN_TOOL_MUST_NOT_EXECUTE" }],
      };
    },
  );

  const transport = new StreamableHTTPServerTransport({});
  response.once("close", () => {
    void transport.close();
    void mcp.close();
  });
  mcp
    .connect(transport)
    .then(() => transport.handleRequest(request, response))
    .catch((error) => {
      if (!response.headersSent) response.writeHead(500).end(String(error));
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
});

httpServer.listen(port, "0.0.0.0", () => {
  process.stdout.write(`MCP fixture listening on ${String(port)}\n`);
});

function close() {
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
}

process.once("SIGINT", close);
process.once("SIGTERM", close);
