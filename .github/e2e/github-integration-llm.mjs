import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

const auditPath = process.env.DSH_E2E_GITHUB_AUDIT;
const expectedKey = process.env.DSH_E2E_FIXTURE_KEY;
const issueLabel = process.env.DSH_E2E_ISSUE_LABEL;
const issueAssignee = process.env.DSH_E2E_ISSUE_ASSIGNEE;
const pullTitle = process.env.DSH_E2E_PULL_TITLE;
if (!auditPath) throw new Error("DSH_E2E_GITHUB_AUDIT is required");
if (!expectedKey) throw new Error("DSH_E2E_FIXTURE_KEY is required");
if (!issueLabel) throw new Error("DSH_E2E_ISSUE_LABEL is required");
if (!issueAssignee) throw new Error("DSH_E2E_ISSUE_ASSIGNEE is required");
if (!pullTitle) throw new Error("DSH_E2E_PULL_TITLE is required");

const calls = new Map();

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.byteLength;
    if (bytes > 2 * 1024 * 1024) throw new Error("fixture request exceeded 2 MiB");
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8"));
}

function messageText(body) {
  return (body.messages ?? [])
    .flatMap((message) => {
      if (typeof message.content === "string") return [message.content];
      if (!Array.isArray(message.content)) return [];
      return message.content.flatMap((block) =>
        block && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
      );
    })
    .join("\n");
}

function finalTask(route) {
  return {
    protocolVersion: 1,
    operation: "task",
    state: "final",
    summary: `Deterministic ${route} route completed.`,
    findings: [],
    taskOutput: { route, accepted: true },
  };
}

function fixtureOutput(route, index) {
  if (route === "github" && index <= 4) {
    const requests = [
      {
        id: "github.issue.labels.set",
        input: { labels: [issueLabel] },
        reason: "Exercise the Controller-owned exact label replacement path.",
      },
      {
        id: "github.issue.assignees.set",
        input: { assignees: [issueAssignee] },
        reason: "Exercise the Controller-owned exact assignee replacement path.",
      },
      {
        id: "github.comment.create",
        input: { body: "DSH E2E typed GitHub tool completed for @maintainers." },
        reason: "Exercise the Controller-owned reconciled comment path.",
      },
      {
        id: "github.issue.state.update",
        input: { state: "closed", stateReason: "completed" },
        reason: "Exercise the Controller-owned bounded Issue state path last.",
      },
    ];
    return {
      protocolVersion: 1,
      operation: "task",
      state: "needs_tool",
      summary: `Schedule typed GitHub Issue operation ${String(index)}.`,
      findings: [],
      toolRequest: requests[index - 1],
    };
  }
  if (route === "label" || route === "assignee" || route === "github") {
    return finalTask(route);
  }
  if (route === "checks" && index === 1) {
    return {
      protocolVersion: 1,
      operation: "diagnose",
      state: "needs_tool",
      summary: "Read the Controller-bound checks and statuses.",
      findings: [],
      toolRequest: {
        id: "github.checks.read",
        input: {},
        reason: "Exercise the immutable-head typed read path.",
      },
    };
  }
  if (route === "checks") {
    return {
      protocolVersion: 1,
      operation: "diagnose",
      state: "final",
      summary: "Deterministic check/status read completed.",
      findings: [],
      diagnosis: "The typed Controller check/status response was available as bounded data.",
    };
  }
  if (route === "metadata" && index === 1) {
    return {
      protocolVersion: 1,
      operation: "task",
      state: "needs_tool",
      summary: "Schedule the exact typed pull request metadata operation.",
      findings: [],
      toolRequest: {
        id: "github.pull.metadata.update",
        input: { title: pullTitle },
        reason: "Exercise the Controller-owned bounded pull request metadata path.",
      },
    };
  }
  if (route === "metadata") {
    return {
      protocolVersion: 1,
      operation: "task",
      state: "final",
      summary: "Deterministic pull request metadata update completed.",
      findings: [],
    };
  }
  throw new Error(`unexpected fixture route: ${route}`);
}

function sendSse(response, value) {
  const content = JSON.stringify(value);
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 3 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok\n");
    return;
  }
  const match = /^\/(label|assignee|github|metadata|checks)\/(?:v1\/)?chat\/completions$/u.exec(
    request.url ?? "",
  );
  if (request.method !== "POST" || match === null) {
    request.resume();
    response.writeHead(404).end();
    return;
  }
  const route = match[1];
  readJson(request)
    .then(async (body) => {
      const index = (calls.get(route) ?? 0) + 1;
      calls.set(route, index);
      await appendFile(
        auditPath,
        `${JSON.stringify({
          route,
          index,
          authorizationMatches: request.headers.authorization === `Bearer ${expectedKey}`,
          prompt: messageText(body),
        })}\n`,
        "utf8",
      );
      sendSse(response, fixtureOutput(route, index));
    })
    .catch((error) => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error instanceof Error ? error.message : String(error));
    });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  process.stdout.write(`${JSON.stringify({ origin, healthUrl: `${origin}/health` })}\n`);
});

function close() {
  server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
