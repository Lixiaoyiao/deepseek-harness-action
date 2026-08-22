import { createServer } from "node:http";

const sockets = new Set();
const responses = new Set();
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }

  request.resume();
  responses.add(response);
  response.on("close", () => responses.delete(response));
});
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  process.stdout.write(
    `${JSON.stringify({
      baseUrl: `http://127.0.0.1:${String(address.port)}`,
      healthUrl: `http://127.0.0.1:${String(address.port)}/health`,
    })}\n`,
  );
});

function shutdown() {
  for (const response of responses) response.destroy();
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
