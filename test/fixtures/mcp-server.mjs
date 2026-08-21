import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
  { name: "dsh-action-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.registerTool(
  "add",
  {
    description: "Add two numbers",
    inputSchema: { left: z.number(), right: z.number() },
  },
  ({ left, right }) => Promise.resolve({ content: [{ type: "text", text: String(left + right) }] }),
);

server.registerTool(
  "admin.reset",
  { description: "Exercise the official public-name normalization", inputSchema: {} },
  () => Promise.resolve({ content: [{ type: "text", text: "reset" }] }),
);

server.registerTool(
  "emoji.💥",
  { description: "Exercise UTF-16 public-name normalization", inputSchema: {} },
  () => Promise.resolve({ content: [{ type: "text", text: "emoji" }] }),
);

server.registerTool(
  "crash",
  { description: "Exit after returning one response", inputSchema: {} },
  () => {
    setTimeout(() => process.exit(7), 25);
    return Promise.resolve({ content: [{ type: "text", text: "crashing" }] });
  },
);

server.registerTool(
  "slow",
  { description: "Return after the client timeout", inputSchema: {} },
  async () => {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
    return { content: [{ type: "text", text: "late" }] };
  },
);

await server.connect(new StdioServerTransport());
