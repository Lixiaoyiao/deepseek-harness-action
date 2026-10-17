// Real published Headless workers and Session persistence, with a local provider.
// No Controller credential, remote model, GitHub mutation or repository script.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { parse } from "yaml";

import { messageToolResults, sendMessagesSse } from "../test/fixtures/messages-sse.mjs";

const execFileAsync = promisify(execFile);
const directory = dirname(fileURLToPath(import.meta.url));
const assets = resolve(directory, "../assets/dsh");
const require = createRequire(import.meta.url);

async function logFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...(await logFiles(child)));
    else if (entry.name === "session.v4.jsonl") files.push(child);
  }
  return files;
}

export async function runSessionAdmissionProbe({ retainRoot = false } = {}) {
  const manifestPath = require.resolve("@deepseek-ai/dsh/package.json");
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).version, "0.2.1-rc.2");
  const cli = join(dirname(manifestPath), "lib", "bin.js");
  const base = process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir();
  const root = await mkdtemp(join(base, "dsh-session-admission-"));
  const deadline = Date.now() + 100_000;
  const workspaces = new Map();
  const secondHomes = new Map();
  const requests = [];
  const evidence = [];
  const identities = [];
  const keys = new Map();
  const systemPlugin = join(root, "current-system.mjs");
  await writeFile(
    systemPlugin,
    'export function apply(ctx, config) { ctx.systemPrompt.section({ name: "session-probe-current-system", order: 9999, text: config.marker }); }\nexport const inject = ["systemPrompt"];\n',
  );
  const server = createServer(async (request, response) => {
    try {
      const mode = request.url.split("/")[1];
      assert.ok(["controlled", "native"].includes(mode));
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      requests.push({ mode, body });
      const serialized = JSON.stringify(body.messages);
      const second = serialized.includes("SECOND_USER_MARKER");
      const fresh = serialized.includes("FRESH_USER_MARKER");
      if (second) {
        const audit = JSON.parse(
          await readFile(
            join(secondHomes.get(mode), "action-state", "session-admission.json"),
            "utf8",
          ),
        );
        assert.equal(audit.source, "resume");
        assert.equal(audit.permissionMode, "read-only");
        assert.equal(audit.approvalPolicy, "never");
      }
      const callId = `${mode}-${second ? "second" : "first"}-tool`;
      const result = messageToolResults(body).find((block) => block.tool_use_id === callId);
      if (!fresh && result === undefined) {
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                id: callId,
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    file_path: join(
                      workspaces.get(mode),
                      second ? "forbidden.txt" : "created-once.txt",
                    ),
                    content: second ? "MUST_NOT_WRITE" : "FIRST_TOOL_EFFECT",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        if (!fresh) assert.equal(result.is_error === true, second);
        sendMessagesSse(
          response,
          {
            content: JSON.stringify({
              protocolVersion: 1,
              operation: "task",
              state: "final",
              summary: fresh
                ? "FRESH_ASSISTANT_MARKER"
                : second
                  ? "SECOND_ASSISTANT_MARKER"
                  : "FIRST_ASSISTANT_MARKER",
              findings: [],
            }),
          },
          "stop",
        );
      }
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function home(mode, label, permissionMode, sessionId, eventCount) {
    const path = join(root, `${mode}-${label}`);
    const profile = join(path, "profiles", "headless");
    await mkdir(profile, { recursive: true });
    await mkdir(join(path, "action-state"));
    await writeFile(join(path, ".anonymous-user-id"), "11111111-1111-4111-8111-111111111111\n");
    await writeFile(
      join(profile, "package.json"),
      JSON.stringify({
        name: "session-admission-probe",
        private: true,
        dependencies: {
          "@deepseek-ai/dsh-base": "0.2.1-rc.2",
          "@deepseek-ai/dsh-headless": "0.2.1-rc.2",
        },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } },
      }),
    );
    const legacy = label === "first";
    const patches =
      mode === "controlled"
        ? parse(
            await readFile(
              join(
                assets,
                permissionMode === "read-only"
                  ? "trusted-read.patch.yml"
                  : "trusted-write.patch.yml",
              ),
              "utf8",
            ),
            { customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (value) => value }] },
          )
        : [];
    patches.push(
      {
        id: "sandbox-policy",
        config: { mode: permissionMode, workspaceRoot: workspaces.get(mode) },
      },
      { id: "approval", config: { policy: legacy ? "ask" : "never" } },
      {
        id: "permission",
        config: {
          presets: {
            "read-only": { sandbox: "read-only", approval: "never" },
            "workspace-write": { sandbox: "workspace-write", approval: legacy ? "ask" : "never" },
          },
          defaultPreset: permissionMode,
        },
      },
      {
        id: "session-persistence-jsonl",
        config: { root: join(path, "sessions"), compression: "none" },
      },
      ...[
        "session-title-llm",
        "session-log-deepseek",
        "session-telemetry-otel",
        "plugin-package-inventory-deepseek",
        "web-fetch-http",
        "mcp-resources",
      ].map((id) => ({ id, disabled: true })),
      {
        insert: [
          {
            id: "session-current-system",
            name: pathToFileURL(systemPlugin).href,
            config: { marker: legacy ? "OLD_SYSTEM_MARKER" : "CURRENT_SYSTEM_MARKER" },
          },
        ],
      },
    );
    if (mode === "controlled") {
      patches.push({ id: "plan-mode", disabled: true });
      const allowed =
        permissionMode === "read-only"
          ? ["read", "glob", "grep"]
          : ["read", "glob", "grep", "write"];
      patches.push({
        insert: [
          {
            id: "session-controlled-policy",
            name: pathToFileURL(join(assets, "action-policy.mjs")).href,
            config: {
              expectedOperation: "task",
              allowedRuntimeTools: allowed,
              knownRuntimeTools: [
                "read",
                "read_image",
                "glob",
                "grep",
                "write",
                "edit",
                "str_replace_editor",
              ],
              rules: allowed.map((runtimeName) => ({
                id:
                  runtimeName === "write"
                    ? "workspace.edit"
                    : runtimeName === "read"
                      ? "workspace.read"
                      : "workspace.search",
                runtimeName,
                provider: "builtin",
                groupId:
                  runtimeName === "write"
                    ? "workspace.edit"
                    : runtimeName === "read"
                      ? "workspace.read"
                      : "workspace.search",
                maxCalls: 10,
                groupMaxCalls: 20,
                timeoutMs: 30_000,
                maxOutputBytes: 32 * 1024,
              })),
              statePath: join(path, "action-state", "counts.json"),
              auditPath: join(path, "action-state", "tools.jsonl"),
            },
          },
        ],
      });
    }
    if (!legacy) {
      const planPath = join(path, "action-state", "session-plan.json");
      await writeFile(
        planPath,
        JSON.stringify({
          schemaVersion: 1,
          bindingDigest: createHash("sha256").update(`probe-${mode}`).digest("hex"),
          permissionMode,
          workingDirectory: workspaces.get(mode),
          ...(sessionId === undefined ? {} : { sessionId, checkpointEventCount: eventCount }),
        }),
      );
      patches.push({
        insert: [
          {
            id: "session-admission",
            name: pathToFileURL(join(assets, "action-session.mjs")).href,
            config: { planPath },
          },
        ],
      });
    }
    await writeFile(join(profile, "cordis.patch.yml"), JSON.stringify(patches));
    keys.set(path, `ephemeral-fake-worker-key-${mode}-${label}`);
    return path;
  }
  async function worker(mode, path, task, sessionId) {
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "Session probe task budget exhausted");
    const args = [cli, "--profile", "headless", "--json"];
    if (sessionId !== undefined) args.push("--session-id", sessionId);
    args.push("--", task);
    try {
      const running = execFileAsync(process.execPath, args, {
        cwd: workspaces.get(mode),
        timeout: Math.min(45_000, remaining),
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: path,
          DSH_HOME: path,
          DSH_PERMISSION_MODE: task.includes("FIRST_USER") ? "workspace-write" : "read-only",
          DSH_TELEMETRY_DISABLED: "1",
          DSH_TOOLS_MODE: "native",
          DEEPSEEK_API_KEY: keys.get(path),
          DEEPSEEK_BASE_URL: `${origin}/${mode}`,
          DEEPSEEK_SEARCH_BASE_URL: `${origin}/${mode}`,
        },
      });
      return { code: 0, pid: running.child.pid, ...(await running) };
    } catch (error) {
      return { code: error.code, stdout: String(error.stdout), stderr: String(error.stderr) };
    }
  }
  try {
    for (const mode of ["controlled", "native"]) {
      const workspace = join(root, `${mode}-workspace`);
      await mkdir(workspace);
      workspaces.set(mode, workspace);
      const firstHome = await home(mode, "first", "workspace-write");
      const first = await worker(mode, firstHome, "FIRST_USER_MARKER");
      assert.equal(first.code, 0, first.stderr);
      assert.equal(
        await readFile(join(workspace, "created-once.txt"), "utf8"),
        "FIRST_TOOL_EFFECT",
      );
      const firstId = first.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find((event) => event.type === "session").sessionId;
      const [firstLog] = await logFiles(join(firstHome, "sessions"));
      const firstRaw = await readFile(firstLog, "utf8");
      const firstLines = firstRaw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(firstLines[0].cwd, workspace);
      const eventCount = firstLines.length - 1;
      const secondHome = await home(mode, "second", "read-only", firstId, eventCount);
      secondHomes.set(mode, secondHome);
      await cp(join(firstHome, "sessions"), join(secondHome, "sessions"), { recursive: true });
      const start = requests.length;
      const second = await worker(mode, secondHome, "SECOND_USER_MARKER", firstId);
      assert.equal(second.code, 0, second.stderr);
      assert.notEqual(second.pid, first.pid);
      assert.equal(existsSync(join(workspace, "forbidden.txt")), false);
      const resumed = requests
        .slice(start)
        .filter((entry) => entry.mode === mode)
        .map((entry) => entry.body);
      assert.equal(resumed.length, 2, "only the new request/tool interval may execute");
      assert.ok(JSON.stringify(resumed[0].messages).includes("FIRST_USER_MARKER"));
      assert.ok(JSON.stringify(resumed[0].messages).includes("FIRST_ASSISTANT_MARKER"));
      assert.ok(JSON.stringify(resumed[0].messages).includes(`${mode}-first-tool`));
      const systemMessages = resumed[0].messages.filter((message) => message.role === "system");
      assert.ok(
        JSON.stringify(systemMessages).includes("CURRENT_SYSTEM_MARKER"),
        JSON.stringify({
          bodyKeys: Object.keys(resumed[0]),
          systemContainsCurrent: JSON.stringify(resumed[0].system).includes(
            "CURRENT_SYSTEM_MARKER",
          ),
          messageRoles: resumed[0].messages.map((message) => message.role),
          messagesContainCurrent: JSON.stringify(resumed[0].messages).includes(
            "CURRENT_SYSTEM_MARKER",
          ),
        }),
      );
      assert.equal(JSON.stringify(systemMessages).includes("OLD_SYSTEM_MARKER"), false);
      const policyMentions = [
        ...JSON.stringify(resumed[0].messages).matchAll(/Current DSH file policy: ([a-z-]+)/gu),
      ];
      assert.equal(policyMentions.at(-1)?.[1], "read-only");
      const advertised = resumed[0].tools.map((tool) => tool.name);
      assert.equal(advertised.includes("write"), mode === "native");
      const secondEvents = second.stdout
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      assert.equal(secondEvents.find((event) => event.type === "session").sessionId, firstId);
      assert.equal(
        second.stdout.includes(`${mode}-first-tool`),
        false,
        "old tool must not be replayed into new run events",
      );
      const audit = JSON.parse(
        await readFile(join(secondHome, "action-state", "session-admission.json"), "utf8"),
      );
      assert.equal(audit.source, "resume");
      assert.equal(
        audit.afterSeq - audit.beforeSeq,
        3,
        "historical preset, sandbox and approval all replaced",
      );
      const [secondLog] = await logFiles(join(secondHome, "sessions"));
      const raw = await readFile(secondLog, "utf8");
      for (const fakeKey of keys.values()) assert.equal(raw.includes(fakeKey), false);
      assert.equal(
        raw.includes(origin),
        false,
        "provider transport configuration must not enter history",
      );
      const records = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const last = (type) => records.filter((event) => event.type === type).at(-1);
      assert.equal(last("sandbox/mode").data.mode, "read-only");
      assert.equal(last("approval/policy").data.policy, "never");
      assert.equal(last("permission/preset").data.preset, "read-only");
      const freshHome = await home(mode, "fresh", "read-only");
      const fresh = await worker(mode, freshHome, "FRESH_USER_MARKER");
      assert.equal(fresh.code, 0, fresh.stderr);
      const freshAudit = JSON.parse(
        await readFile(join(freshHome, "action-state", "session-admission.json"), "utf8"),
      );
      assert.equal(freshAudit.source, "startup");
      assert.notEqual(freshAudit.sessionId, firstId);
      for (const problem of ["event-count", "pending-input"]) {
        const extra = problem === "pending-input" ? 1 : 0;
        const negativeHome = await home(mode, problem, "read-only", firstId, eventCount + 1);
        await cp(join(firstHome, "sessions"), join(negativeHome, "sessions"), { recursive: true });
        if (extra !== 0) {
          const original = firstLines.find(
            (event) => event.type === "agent/inbox/spliced" && event.data.inserted.length > 0,
          ).data.inserted[0];
          const pending = structuredClone(original);
          pending.id = "session-probe-pending-old-input";
          pending.content = [{ type: "text", text: "MUST_NOT_REPLAY_OLD_INPUT" }];
          const [negativeLog] = await logFiles(join(negativeHome, "sessions"));
          await writeFile(
            negativeLog,
            firstRaw +
              JSON.stringify({
                type: "agent/inbox/spliced",
                seq: eventCount,
                time: Date.now(),
                data: { target: "next-turn", start: 0, inserted: [pending] },
              }) +
              "\n",
          );
        }
        const before = requests.length;
        const rejected = await worker(mode, negativeHome, "SHOULD_NOT_EXECUTE", firstId);
        assert.equal(rejected.code, 1, rejected.stderr);
        assert.match(
          rejected.stderr,
          problem === "event-count"
            ? /event count changed/u
            : /pending input must not be replayed/u,
        );
        assert.equal(requests.length, before, "rejected restore must make no model request");
      }
      evidence.push({
        mode,
        passed: true,
        newWorker: first.pid !== second.pid,
        sameWorkingDirectory: true,
        historyRestored: true,
        oldToolReplayed: false,
        secondRequestCount: resumed.length,
        currentSystemPromptOnly: true,
        currentToolGraph: true,
        historicalPermission: "workspace-write/ask",
        resumedPermission: "read-only/never",
        currentKnobEventsAppended: audit.afterSeq - audit.beforeSeq,
        forbiddenWriteOccurred: false,
        rawEventCount: records.length - 1,
        rawGeneration: "session.v4.jsonl",
        proxyKeyInRaw: false,
        providerEndpointInRaw: false,
        requestHeaderDataKeys: Object.keys(last("request/header")?.data ?? {}),
        requestContextDataKeys: Object.keys(last("request/context")?.data ?? {}),
        freshSessionSource: freshAudit.source,
        changedEventCountRejectedBeforeModel: true,
        pendingInputRejectedBeforeModel: true,
      });
      identities.push({ mode, firstHome, secondHome, firstLog, secondLog });
    }
    return {
      schemaVersion: 1,
      runtimeVersion: "0.2.1-rc.2",
      scope:
        "published official Headless + public Cordis lifecycle plugin, actual worker processes and local fake provider; not live Action artifact E2E",
      remoteModelCalls: 0,
      githubWrites: 0,
      checks: evidence,
      ...(retainRoot ? { retainedFakeState: root, identities } : {}),
    };
  } finally {
    await new Promise((done) => server.close(done));
    if (!retainRoot) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSessionAdmissionProbe({
    retainRoot: process.argv.includes("--retain-fake-state"),
  });
  const output = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
  if (output !== undefined)
    await writeFile(resolve(output), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
