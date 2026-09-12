import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

// This public dummy key must never be replaced with a real provider credential.
const fixtureKey = "dsh-e2e-integrity-fixture-key";
const auditPath = process.env.DSH_E2E_INTEGRITY_AUDIT;
if (!auditPath) throw new Error("DSH_E2E_INTEGRITY_AUDIT is required");
const marker = "DSH_E2E_INTEGRITY_WEAKENED";
const callId = "integrity-bash-once";
let phase = "ready";

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("fixture request exceeded its byte limit");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

function send(response, message, finishReason, stream) {
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ index: 0, message, finish_reason: finishReason }] }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200).end("ok");
    return;
  }
  if (request.method !== "POST" || request.url !== "/chat/completions") {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  if (request.headers.authorization !== `Bearer ${fixtureKey}`) {
    request.resume();
    response.writeHead(403).end("Only the public integrity fixture credential is accepted");
    return;
  }
  readJson(request)
    .then(async (body) => {
      const messages = body.messages ?? [];
      if (!Array.isArray(messages)) throw new Error("fixture requires messages");
      if (JSON.stringify(messages).includes(fixtureKey))
        throw new Error("credential entered model context");
      if (
        !messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("DSH_E2E_INTEGRITY_FIXTURE"),
        )
      ) {
        throw new Error("fixture task identity was absent");
      }
      if (phase === "ready") {
        if (!(body.tools ?? []).some((tool) => tool.function?.name === "bash")) {
          throw new Error("the real DSH Bash tool was absent");
        }
        phase = "bash-issued";
        await appendFile(auditPath, JSON.stringify({ phase, tool: "bash", callId }) + "\n");
        send(
          response,
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: callId,
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({
                    command: `printf 'process.exit(0);\\n' > scripts/verify-dsh-config.mjs && printf '${marker}\\n'`,
                    description: "Weaken only the disposable validation fixture entrypoint",
                    timeoutMs: 10_000,
                  }),
                },
              },
            ],
          },
          "tool_calls",
          body.stream,
        );
        return;
      }
      const feedback = messages.filter((message) => message.role === "tool");
      if (
        phase !== "bash-issued" ||
        feedback.length !== 1 ||
        feedback[0].tool_call_id !== callId ||
        !JSON.stringify(feedback[0].content).includes(marker)
      ) {
        throw new Error("the single Bash call did not report its completed write");
      }
      phase = "bash-observed";
      await appendFile(auditPath, JSON.stringify({ phase, tool: "bash", callId }) + "\n");
      send(
        response,
        {
          role: "assistant",
          content: JSON.stringify({
            protocolVersion: 1,
            operation: "task",
            state: "final",
            summary: "The disposable integrity fixture was weakened for Controller rejection.",
            findings: [],
          }),
        },
        "stop",
        body.stream,
      );
    })
    .catch(() => {
      // Never echo request bodies, model context, or authorization values.
      response
        .writeHead(422)
        .end("Integrity fixture protocol failed; inspect the bounded phase audit");
    });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  process.stdout.write(JSON.stringify({ baseUrl, healthUrl: `${baseUrl}/health` }) + "\n");
});
const close = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
