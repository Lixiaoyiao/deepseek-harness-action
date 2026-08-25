import { appendFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";

const host = process.env.DSH_FIXTURE_HOST ?? "127.0.0.1";
const requestLog = process.env.DSH_NATIVE_REQUEST_LOG;
if (requestLog === undefined || requestLog.trim() === "") {
  throw new Error("DSH_NATIVE_REQUEST_LOG is required");
}
await writeFile(requestLog, "");

function hasUserText(request, marker) {
  return (request.messages ?? []).some(
    ({ role, content }) => role === "user" && JSON.stringify(content).includes(marker),
  );
}

async function readJsonRequest(request) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    total += bytes.length;
    if (total > 4 * 1024 * 1024) throw new Error("native fixture request is too large");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendSse(response, delta, finishReason) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 3, completion_tokens: 3 },
    })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function sendToolCall(response, index, name, args) {
  sendSse(
    response,
    {
      tool_calls: [
        {
          index: 0,
          id: `native-ci-call-${String(index)}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
}

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  readJsonRequest(request)
    .then(async (body) => {
      await appendFile(requestLog, `${JSON.stringify(body)}\n`);
      if (hasUserText(body, "Generate the session title")) {
        sendSse(response, { content: "Native Ecosystem CI" }, "stop");
        return;
      }
      if (hasUserText(body, "CHILD_NATIVE_MARKER")) {
        sendSse(response, { content: "CHILD_NATIVE_MARKER_OK" }, "stop");
        return;
      }
      const results = body.messages?.filter(({ role }) => role === "tool").length ?? 0;
      switch (results) {
        case 0:
          sendToolCall(response, results, "skill", { name: "native-dsh" });
          return;
        case 1:
          sendToolCall(response, results, "skill", { name: "native-agents" });
          return;
        case 2:
          sendToolCall(response, results, "mcp__fixture__add", { left: 19, right: 23 });
          return;
        case 3:
          sendToolCall(response, results, "native_bundle_echo", {});
          return;
        case 4:
          sendToolCall(response, results, "native_plugin_echo", {});
          return;
        case 5:
          sendToolCall(response, results, "subagent", {
            description: "Native child marker",
            prompt: "Return CHILD_NATIVE_MARKER exactly.",
            run_in_background: false,
          });
          return;
        case 6:
          sendToolCall(response, results, "workflow", {
            script: "return { marker: 'NATIVE_WORKFLOW_MARKER', value: args.value };",
            meta: {
              name: "native-workflow-ci-smoke",
              description: "Verify the locked rc.2 workflow engine in Docker",
            },
            args: { value: 7 },
          });
          return;
        default:
          sendSse(
            response,
            {
              content: JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "native ecosystem booted",
                findings: [],
              }),
            },
            "stop",
          );
      }
    })
    .catch((error) => response.writeHead(500).end(String(error)));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, host, resolve);
});
const address = server.address();
if (address === null || typeof address === "string") throw new Error("Expected TCP address");
process.stdout.write(`${JSON.stringify({ baseUrl: `http://${host}:${String(address.port)}` })}\n`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
