import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "dsh-action-native-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "add",
  {
    description: "Add two numbers through the native DSH MCP graph",
    inputSchema: { left: z.number(), right: z.number() },
  },
  ({ left, right }) => Promise.resolve({ content: [{ type: "text", text: String(left + right) }] }),
);

await server.connect(new StdioServerTransport());
