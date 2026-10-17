// A bounded upstream API probe. This is not an Action resume feature or a live
// model E2E: independent official CLI workers use a deterministic local provider.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { sendMessagesSse } from "../test/fixtures/messages-sse.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const dsh = require.resolve("@deepseek-ai/dsh/package.json");
const manifest = JSON.parse(await readFile(dsh, "utf8"));
assert.equal(manifest.version, "0.2.1-rc.2");
const cli = join(dirname(dsh), "lib", "bin.js");
const temporaryBase = process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir();
const root = await mkdtemp(join(temporaryBase, "dsh-fixed-resume-probe-"));
const workspace = join(root, "workspace");
const requests = [];
const results = [];
let heldStarted;
let releaseHeld;
const heldReady = new Promise((done) => {
  heldStarted = done;
});
const heldRelease = new Promise((done) => {
  releaseHeld = done;
});
const server = createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.ok(request.url?.endsWith("/v1/messages"));
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const latestUser = body.messages?.filter((message) => message.role === "user").at(-1);
    if (JSON.stringify(latestUser).includes("HOLD_RESUME_MARKER")) {
      heldStarted();
      await heldRelease;
    }
    const title = JSON.stringify(body.messages).includes("Generate the session title");
    sendMessagesSse(
      response,
      { content: title ? "Resume API Probe" : "FIRST_ASSISTANT_MARKER" },
      "stop",
    );
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

async function createHome(name) {
  const home = join(root, name);
  const profile = join(home, "profiles", "headless");
  await mkdir(profile, { recursive: true });
  await writeFile(join(home, ".anonymous-user-id"), "11111111-1111-4111-8111-111111111111\n");
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      name: "fixed-runtime-resume-probe",
      private: true,
      dependencies: {
        "@deepseek-ai/dsh-base": "0.2.1-rc.2",
        "@deepseek-ai/dsh-headless": "0.2.1-rc.2",
      },
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
    }),
  );
  await writeFile(
    join(profile, "cordis.patch.yml"),
    JSON.stringify([
      {
        id: "session-persistence-jsonl",
        config: { root: join(home, "sessions"), compression: "none" },
      },
      { id: "session-log-deepseek", disabled: true },
      { id: "session-telemetry-otel", disabled: true },
      { id: "plugin-package-inventory-deepseek", disabled: true },
      { id: "session-title-llm", disabled: true },
    ]),
  );
  return home;
}

async function worker(home, task, sessionId, cwd = workspace, permissionMode = "read-only") {
  const args = [cli, "--profile", "headless", "--json"];
  if (sessionId !== undefined) args.push("--session-id", sessionId);
  args.push("--", task);
  try {
    const running = execFileAsync(process.execPath, args, {
      cwd,
      timeout: 45_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: home,
        DSH_HOME: home,
        DSH_PERMISSION_MODE: permissionMode,
        DSH_TELEMETRY_DISABLED: "1",
        DEEPSEEK_API_KEY: "local-probe-only",
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
      },
    });
    const value = await running;
    return { code: 0, pid: running.child.pid, ...value };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

async function findLogs(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await findLogs(child)));
    else if (entry.name.endsWith(".jsonl")) files.push(child);
  }
  return files;
}

try {
  await mkdir(workspace);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const firstHome = await createHome("first-worker");
  const first = await worker(
    firstHome,
    "FIRST_USER_MARKER",
    undefined,
    workspace,
    "workspace-write",
  );
  assert.equal(first.code, 0, first.stderr);
  const events = first.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const sessionId = events.find((event) => event.type === "session")?.sessionId;
  assert.equal(typeof sessionId, "string", first.stdout);
  const secondHome = await createHome("second-worker");
  await cp(join(firstHome, "sessions"), join(secondHome, "sessions"), { recursive: true });
  const secondStart = requests.length;
  const second = await worker(secondHome, "SECOND_USER_MARKER", sessionId);
  assert.equal(second.code, 0, second.stderr);
  const restoredRequest = requests
    .slice(secondStart)
    .find((body) => JSON.stringify(body.messages).includes("SECOND_USER_MARKER"));
  assert.ok(restoredRequest);
  assert.ok(JSON.stringify(restoredRequest.messages).includes("FIRST_USER_MARKER"));
  assert.ok(JSON.stringify(restoredRequest.messages).includes("FIRST_ASSISTANT_MARKER"));
  assert.notEqual(first.pid, second.pid);
  results.push({
    check: "fresh-process-and-home-real-session-history",
    passed: true,
    firstPid: first.pid,
    secondPid: second.pid,
  });
  const policyMentions = [
    ...JSON.stringify(restoredRequest.messages).matchAll(/Current DSH file policy: ([a-z-]+)/gu),
  ];
  assert.equal(policyMentions.at(-1)?.[1], "workspace-write");
  results.push({
    check: "persisted-permission-is-not-recomputed-by-new-default",
    passed: true,
    priorMode: "workspace-write",
    newWorkerDefault: "read-only",
    restoredMode: "workspace-write",
    implication:
      "Action must reset or reject historical authorization before any resumed tool call",
  });

  const missing = await worker(secondHome, "SHOULD_NOT_EXECUTE", "missing-session");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /does not exist/u);
  results.push({ check: "unknown-session-fails", passed: true });

  const otherWorkspace = join(root, "other-workspace");
  await mkdir(otherWorkspace);
  const wrongCwd = await worker(secondHome, "SHOULD_NOT_EXECUTE", sessionId, otherWorkspace);
  assert.equal(wrongCwd.code, 1);
  assert.match(wrongCwd.stderr, /was recorded in/u);
  results.push({ check: "workspace-mismatch-fails", passed: true });

  const beforeRejected = requests.length;
  for (const [name, mutation, expected] of [
    [
      "corrupt-worker",
      (lines) => {
        lines[1].type = "unknown/event";
      },
      /corrupt|unknown|unsupported/iu,
    ],
    [
      "future-format-worker",
      (lines) => {
        lines[0].version = 999;
      },
      /newer|version|format/iu,
    ],
    [
      "preset-worker",
      (lines) => {
        lines[0].agentPreset = "unsupported-fixture-preset";
      },
      /agent preset/u,
    ],
    [
      "subagent-worker",
      (lines) => {
        lines[0].origin = "subagent";
      },
      /subagent or forked/u,
    ],
  ]) {
    const home = await createHome(name);
    await cp(join(firstHome, "sessions"), join(home, "sessions"), { recursive: true });
    const [log] = await findLogs(join(home, "sessions"));
    assert.ok(log);
    const lines = (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    mutation(lines);
    await writeFile(log, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    if (name === "future-format-worker")
      await rename(log, log.replace(/\.v4\.jsonl$/u, ".v999.jsonl"));
    const refused = await worker(home, "SHOULD_NOT_EXECUTE", sessionId);
    assert.equal(refused.code, 1, refused.stderr);
    assert.match(refused.stderr, expected);
    results.push({ check: `${name}-refused`, passed: true });
  }
  assert.equal(requests.length, beforeRejected, "refused Sessions must not start a model request");

  const holding = worker(secondHome, "HOLD_RESUME_MARKER", sessionId);
  const readinessTimeout = setTimeout(
    () => heldStarted(new Error("held worker did not reach its model request")),
    15_000,
  );
  try {
    const readyError = await heldReady;
    if (readyError instanceof Error) throw readyError;
    const conflicting = await worker(secondHome, "SHOULD_NOT_EXECUTE", sessionId);
    assert.equal(conflicting.code, 1, conflicting.stderr);
    assert.match(conflicting.stderr, /owned|ownership|lease/u);
    results.push({ check: "same-storage-cross-process-write-ownership-conflict", passed: true });
  } finally {
    clearTimeout(readinessTimeout);
    releaseHeld();
    assert.equal((await holding).code, 0);
  }

  const output = {
    dshVersion: manifest.version,
    provider: "deterministic-local-http",
    actionResumeImplemented: false,
    checks: results,
  };
  if (process.argv[2] !== undefined)
    await writeFile(resolve(process.argv[2]), JSON.stringify(output, null, 2) + "\n");
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
} finally {
  releaseHeld();
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
