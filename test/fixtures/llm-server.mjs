import { createServer } from "node:http";

const responseText = JSON.stringify({
  operation: "review",
  summary: "controlled profile booted",
  findings: [],
  state: "final",
});

const server = createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.once("end", () => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: responseText }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  process.stdout.write(
    `${JSON.stringify({ baseUrl: `http://127.0.0.1:${String(address.port)}` })}\n`,
  );
});

const close = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
