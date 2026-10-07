// Exercise the actual production Profile builders and original Action launchers.
// Only execution-world filesystem paths are mapped to a local fixture workspace.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createServer as createViteServer } from "vite";

import { messageToolResults, sendMessagesSse } from "../test/fixtures/messages-sse.mjs";

const run = promisify(execFile);
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assets = join(repository, "assets", "dsh");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function logs(path) {
  const found = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...(await logs(join(path, entry.name))));
    else if (entry.name === "session.v4.jsonl") found.push(join(path, entry.name));
  }
  return found;
}

export async function runProductionSessionProbe({
  retainRoot = false,
  expectControlledRejection = false,
  prunerPressure = false,
  prunerErrorResult = false,
} = {}) {
  prunerPressure ||= prunerErrorResult;
  const require = createRequire(import.meta.url);
  const runtimeVersion = JSON.parse(
    await readFile(require.resolve("@deepseek-ai/dsh/package.json"), "utf8"),
  ).version;
  const prunerVersion = JSON.parse(
    await readFile(
      require.resolve("@deepseek-ai/dsh-compaction-tool-result-pruner/package.json"),
      "utf8",
    ),
  ).version;
  assert.equal(runtimeVersion, "0.2.0-rc.2");
  assert.equal(prunerVersion, runtimeVersion);
  const root = await mkdtemp(
    join(
      process.platform === "win32" ? (process.env.PUBLIC ?? tmpdir()) : tmpdir(),
      "dsh-session-production-",
    ),
  );
  const deadline = Date.now() + 120_000;
  const requests = [];
  const checks = [];
  const paths = [];
  const workspaces = new Map();
  const keys = new Set();
  const vite = await createViteServer({
    root: repository,
    logLevel: "error",
    server: { middlewareMode: true },
    appType: "custom",
  });
  const { prepareControlledProfile } = await vite.ssrLoadModule("/src/extensions/profile.ts");
  const { writeNativeProfile } = await vite.ssrLoadModule("/src/dsh/native-composition.ts");
  const { resolveExtensionPlan, resolveNativeExtensionPlan } =
    await vite.ssrLoadModule("/src/extensions/plan.ts");
  const { validateSessionPayload } = await vite.ssrLoadModule("/src/session/checkpoint.ts");
  await vite.close();
  const server = createServer(async (request, response) => {
    try {
      const mode = request.url.split("/")[1];
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const isTitle = body.messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("Generate the session title"),
      );
      const text = JSON.stringify(body.messages);
      const second = text.includes("PRODUCTION_SECOND_MARKER");
      requests.push({
        mode,
        phase: second ? "resume" : "save",
        role: isTitle ? "title" : "main",
        body,
      });
      if (isTitle) {
        sendMessagesSse(response, { content: "Production Session Probe" }, "stop");
        return;
      }
      const callId = `production-${mode}-old-write`;
      const result = messageToolResults(body).find((block) => block.tool_use_id === callId);
      const readId = `production-${mode}-oversized-read`;
      const readResult = messageToolResults(body).find((block) => block.tool_use_id === readId);
      if (!second && result === undefined) {
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                id: callId,
                function: {
                  name: "write",
                  arguments: JSON.stringify({
                    file_path: join(workspaces.get(mode), "created-once.txt"),
                    content: "PRODUCTION_FIRST_EFFECT",
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else if (prunerPressure && !second && readResult === undefined) {
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                id: readId,
                function: {
                  name: "read",
                  arguments: JSON.stringify({
                    file_path: join(
                      workspaces.get(mode),
                      prunerErrorResult ? "missing-" + "x".repeat(45_000) : "oversized.txt",
                    ),
                  }),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        sendMessagesSse(
          response,
          {
            content: JSON.stringify({
              protocolVersion: 1,
              operation: "task",
              state: "final",
              summary: second ? "PRODUCTION_SECOND_RESULT" : "PRODUCTION_FIRST_RESULT",
              findings: [],
            }),
          },
          "stop",
        );
      }
    } catch {
      response.writeHead(500).end("production fixture failed");
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const policy = (write) => ({
    trust: write ? "trusted-write" : "trusted-read",
    allowed: true,
    reason: "production Session fixture",
    capabilities: {
      readRepository: true,
      readCi: false,
      publishComments: true,
      executeRepositoryCode: write,
      loadExtensions: true,
      accessNetwork: true,
      modifyWorkspace: write,
      commit: write,
      push: write,
      createPullRequest: write,
      manageIssueLabels: false,
      manageIssueAssignees: false,
      updateIssueState: false,
      updatePullRequestMetadata: false,
    },
  });
  async function home(mode, phase, sessionId, eventCount) {
    const write = phase === "save";
    const path = join(root, `${mode}-${phase}`);
    const profile = join(path, "profiles", "github-action");
    const state = join(path, "action-state");
    await Promise.all(
      [profile, state, join(path, "sessions")].map((directory) =>
        mkdir(directory, { recursive: true }),
      ),
    );
    await writeFile(join(path, ".anonymous-user-id"), "11111111-1111-4111-8111-111111111111\n");
    const mcp = { schemaVersion: 1, servers: [] };
    const plugins = { schemaVersion: 1, bundles: [], plugins: [] };
    const task = write ? "PRODUCTION_FIRST_MARKER" : "PRODUCTION_SECOND_MARKER";
    if (mode === "controlled") {
      const plan = resolveExtensionPlan({
        mcp,
        plugins,
        allowedTools: ["workspace.read", "workspace.search", "workspace.edit"],
        allowPluginInstall: false,
        policy: policy(write),
      });
      await prepareControlledProfile({
        dshHome: path,
        plan,
        nativeTools: write
          ? ["workspace.read", "workspace.search", "workspace.edit"]
          : ["workspace.read", "workspace.search"],
        workspaceWrite: write,
        expectedOperation: "task",
        task,
        workerWorkspacePath: workspaces.get(mode),
        policyPluginPath: join(assets, "action-policy.mjs"),
        workspacePluginPath: join(assets, "action-workspace.mjs"),
        workerStatePath: join(state, "tool-counts.json"),
        workerAuditPath: join(state, "tool-receipts.jsonl"),
        manifestBase: { name: "production-session-fixture", private: true, dependencies: {} },
      });
    } else {
      const plan = resolveNativeExtensionPlan({
        mcp,
        plugins,
        allowPluginInstall: false,
        policy: policy(write),
      });
      await writeNativeProfile({
        profileRoot: profile,
        plan,
        manifestBase: { name: "production-session-fixture", private: true, dependencies: {} },
      });
      await writeFile(join(state, "native-observed-tools.jsonl"), "");
    }
    if (prunerPressure && write) {
      const patchPath = join(profile, "cordis.patch.yml");
      const patches = JSON.parse(await readFile(patchPath, "utf8"));
      // Only this fixture lowers pressure. The original production compaction
      // hook, token meter and pruner run against a real read-tool result.
      patches.push({
        id: "compaction-basic",
        config: {
          thresholdRatio: mode === "native" ? 0.012 : 0.005,
          retainTokens: 0,
          headroomTokens: 0,
          maxTokens: 128,
        },
      });
      await writeFile(patchPath, JSON.stringify(patches));
    }
    await writeFile(
      join(state, "session-plan.json"),
      JSON.stringify({
        schemaVersion: 1,
        bindingDigest: digest(mode),
        permissionMode: write ? "workspace-write" : "read-only",
        workingDirectory: workspaces.get(mode),
        ...(sessionId === undefined ? {} : { sessionId, checkpointEventCount: eventCount }),
      }),
    );
    return path;
  }
  async function worker(mode, phase, homePath) {
    const key = `fake-production-${mode}-${phase}-key`;
    keys.add(key);
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "production Session probe budget exhausted");
    const running = run(
      process.execPath,
      [
        "--expose-internals",
        join(assets, mode === "controlled" ? "action-launcher.mjs" : "native-launcher.mjs"),
        phase === "save" ? "PRODUCTION_FIRST_MARKER" : "PRODUCTION_SECOND_MARKER",
        "--action-session",
      ],
      {
        cwd: workspaces.get(mode),
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: homePath,
          DSH_HOME: homePath,
          DSH_PERMISSION_MODE: phase === "save" ? "workspace-write" : "read-only",
          DSH_TELEMETRY_DISABLED: "1",
          DSH_TOOLS_MODE: "native",
          DEEPSEEK_API_KEY: key,
          DEEPSEEK_BASE_URL: `${origin}/${mode}`,
          DEEPSEEK_SEARCH_BASE_URL: `${origin}/${mode}`,
        },
        timeout: Math.min(45_000, remaining),
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      },
    );
    try {
      return { code: 0, pid: running.child.pid, ...(await running) };
    } catch (error) {
      return {
        code: error.code,
        pid: running.child.pid,
        stdout: String(error.stdout),
        stderr: String(error.stderr),
      };
    }
  }
  try {
    for (const mode of ["controlled", "native"]) {
      const workspace = join(root, `${mode}-workspace`);
      await mkdir(workspace);
      workspaces.set(mode, workspace);
      if (prunerPressure)
        await writeFile(
          join(workspace, "oversized.txt"),
          "PRUNER_HEAD " + ("abcdefghij".repeat(100) + "\n").repeat(45) + "PRUNER_TAIL\n",
        );
      const firstHome = await home(mode, "save");
      const first = await worker(mode, "save", firstHome);
      if (mode === "native" && expectControlledRejection) {
        assert.notEqual(first.code, 0);
        assert.ok(
          first.stderr.includes(
            "session plan cannot broaden or replace the current composition policy",
          ),
        );
        assert.equal(requests.filter((entry) => entry.mode === mode).length, 0);
        checks.push({
          mode,
          reproducedFailure: "current composition uses ask; Session requires never",
          failedBeforeModel: true,
          mainRequests: 0,
          titleRequests: 0,
        });
        continue;
      }
      assert.equal(first.code, 0, first.stderr);
      assert.equal(
        await readFile(join(workspace, "created-once.txt"), "utf8"),
        "PRODUCTION_FIRST_EFFECT",
      );
      const firstFiles = await logs(join(firstHome, "sessions"));
      assert.equal(firstFiles.length, 1);
      const firstRaw = await readFile(firstFiles[0]);
      const firstRows = firstRaw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      const sessionId = firstRows[0].id;
      const eventCount = firstRows.length - 1;
      const pruneEvidence = [];
      if (prunerPressure) {
        const prunes = firstRows.filter((row) => row.type === "compaction/prune");
        assert.ok(prunes.length > 0, "pruner path was not triggered; this is not a passing probe");
        for (const prune of prunes) {
          const originalSeq = prune.data.shadowedSeqs[0];
          const original = firstRows[originalSeq + 1];
          const replacement = firstRows[prune.seq + 2];
          assert.equal(original.type, "tool/result");
          assert.equal(original.data.message.source.callId, `production-${mode}-oversized-read`);
          assert.equal(replacement.type, "tool/result");
          assert.equal(replacement.data.message.source.callId, original.data.message.source.callId);
          assert.deepEqual(replacement.data.error, original.data.error);
          assert.equal(replacement.data.message.isError, original.data.message.isError);
          if (prunerErrorResult)
            assert.ok(
              original.data.message.isError === true,
              "an actual tool error must reach the pruner",
            );
          assert.deepEqual(replacement.sourceEventSeqs, [originalSeq]);
          assert.deepEqual(replacement.surfaceOp, {
            op: "replace",
            startSeq: originalSeq,
            endSeq: originalSeq,
          });
          const chars = (row) =>
            row.data.message.content
              .filter((block) => block.type === "text")
              .reduce((total, block) => total + Array.from(block.text).length, 0);
          const charsBefore = chars(original);
          const charsAfter = chars(replacement);
          assert.ok(charsBefore > 8192, "a real large tool output must reach the pruner");
          assert.ok(charsAfter <= 8192 && charsAfter < charsBefore);
          assert.ok(
            JSON.stringify(replacement.data.message.content).includes("tool result middle pruned"),
          );
          pruneEvidence.push({
            pruneSeq: prune.seq,
            originalSeq,
            replacementSeq: replacement.seq,
            callId: original.data.message.source.callId,
            charsBefore,
            charsAfter,
            shadowedTokenCount: prune.data.shadowedTokenCount,
            errorResult: original.data.message.isError === true,
          });
        }
        const inspection = validateSessionPayload({
          payload: firstRaw,
          sessionId,
          workspacePath: workspace,
          knownSecrets: [...keys],
        });
        assert.equal(inspection.eventCount, eventCount);
        // A malformed prune span must still fail the unchanged released codec.
        const damagedRows = structuredClone(firstRows);
        damagedRows.find((row) => row.type === "compaction/prune").data.shadowedSeqs = [];
        assert.throws(() =>
          validateSessionPayload({
            payload: Buffer.from(damagedRows.map(JSON.stringify).join("\n") + "\n"),
            sessionId,
            workspacePath: workspace,
            knownSecrets: [...keys],
          }),
        );
      }
      const firstRequests = requests.filter((entry) => entry.mode === mode);
      const secondHome = await home(mode, "resume", sessionId, eventCount);
      await cp(join(firstHome, "sessions"), join(secondHome, "sessions"), { recursive: true });
      const before = requests.length;
      const second = await worker(mode, "resume", secondHome);
      const newRequests = requests.slice(before).filter((entry) => entry.mode === mode);
      const rejected = mode === "controlled" && expectControlledRejection;
      if (rejected) {
        assert.notEqual(second.code, 0);
        assert.ok(second.stderr.includes("Session identity is not bound"));
        assert.equal(newRequests.length, 0);
        checks.push({
          mode,
          reproducedFailure: "Session identity is not bound",
          failedBeforeModel: true,
          mainRequests: 0,
          titleRequests: 0,
          expectedSessionId: sessionId,
          eventCount,
        });
        continue;
      }
      assert.equal(second.code, 0, second.stderr);
      assert.notEqual(second.pid, first.pid);
      const audit = JSON.parse(
        await readFile(join(secondHome, "action-state", "session-admission.json"), "utf8"),
      );
      assert.equal(audit.sessionId, sessionId);
      assert.equal(audit.source, "resume");
      assert.equal(audit.permissionMode, "read-only");
      assert.equal(audit.approvalPolicy, "never");
      const main = newRequests.filter((entry) => entry.role === "main");
      assert.equal(main.length, 1);
      assert.ok(JSON.stringify(main[0].body.messages).includes("PRODUCTION_FIRST_MARKER"));
      assert.ok(JSON.stringify(main[0].body.messages).includes(`production-${mode}-old-write`));
      if (prunerPressure)
        assert.ok(
          JSON.stringify(main[0].body.messages).includes("tool result middle pruned"),
          "resumed provider must see the real pruned surface",
        );
      const secondFiles = await logs(join(secondHome, "sessions"));
      assert.equal(
        secondFiles.length,
        1,
        "no extra bootstrap or metadata Agent Session may be saved",
      );
      const secondRaw = await readFile(secondFiles[0]);
      assert.ok(secondRaw.subarray(0, firstRaw.length).equals(firstRaw));
      const secondRows = secondRaw.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      assert.equal(
        secondRows.filter(
          (row) => row.type === "tool/call" && row.data.callId === `production-${mode}-old-write`,
        ).length,
        1,
      );
      assert.equal(second.stdout.includes(`production-${mode}-old-write`), false);
      for (const key of keys) assert.equal(secondRaw.includes(Buffer.from(key)), false);
      checks.push({
        mode,
        productionProfile: true,
        originalLauncher: true,
        newWorker: first.pid !== second.pid,
        sameSession: true,
        currentPermission: "read-only/never",
        historyRestored: true,
        oldToolsReplayed: false,
        extraSession: false,
        mainRequests: main.length,
        titleRequests: newRequests.filter((entry) => entry.role === "title").length,
        saveMainRequests: firstRequests.filter((entry) => entry.role === "main").length,
        saveTitleRequests: firstRequests.filter((entry) => entry.role === "title").length,
        firstEventCount: eventCount,
        admissionBeforeSeq: audit.beforeSeq,
        admissionAfterSeq: audit.afterSeq,
        restoredEventCount: secondRows.length - 1,
        payloadSha256: digest(secondRaw),
        ...(prunerPressure
          ? {
              pressureFixture: true,
              prunerEvents: pruneEvidence.length,
              pruneEvidence,
              savedPayloadSha256: digest(firstRaw),
              strictSaveDecode: true,
              malformedPruneRejected: true,
              strictRestoredDecode: Boolean(
                validateSessionPayload({
                  payload: secondRaw,
                  sessionId,
                  workspacePath: workspace,
                  knownSecrets: [...keys],
                }),
              ),
            }
          : {}),
      });
      paths.push({
        mode,
        firstHome,
        secondHome,
        firstLog: firstFiles[0],
        secondLog: secondFiles[0],
      });
    }
    return {
      schemaVersion: 1,
      runtimeVersion,
      ...(prunerPressure
        ? {
            prunerVersion,
            prunerScope: `${prunerErrorResult ? "error" : "successful"} text read-tool result, automatic pressure compaction; no claim for provider-overflow, image or subagent paths`,
          }
        : {}),
      scope:
        "actual production Profile builders + original Action launchers, real new Node workers and local fake provider; execution-world paths mapped to fixture cwd, no Docker/Live Actions claim",
      remoteModelCalls: 0,
      githubWrites: 0,
      titleDisabledByProbe: false,
      checks,
      ...(retainRoot ? { retainedFakeState: root, paths } : {}),
    };
  } finally {
    await new Promise((done) => server.close(done));
    if (!retainRoot) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runProductionSessionProbe({
    retainRoot: process.argv.includes("--retain-fake-state"),
    expectControlledRejection: process.argv.includes("--expect-controlled-rejection"),
    prunerPressure: process.argv.includes("--pruner-pressure"),
    prunerErrorResult: process.argv.includes("--pruner-error-result"),
  });
  const output = process.argv[2];
  if (output && !output.startsWith("--"))
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result.checks) + "\n");
}
