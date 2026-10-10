import { z } from "zod";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { prepareControlledProfile } from "../src/extensions/profile.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import { messageToolResults, sendMessagesSse } from "./fixtures/messages-sse.mjs";

const execFileAsync = promisify(execFile);
interface FixtureRequest {
  readonly messages?: readonly { readonly content?: unknown }[] | undefined;
  readonly tools?: readonly { readonly name?: string | undefined }[] | undefined;
}

it("inserts and executes the official editor, plus native Bash on POSIX, under the exact controlled inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "dsh-controlled-editor-"));
  const dshHome = join(root, "home");
  const workspace = join(root, "workspace");
  const requests: FixtureRequest[] = [];
  const serverErrors: unknown[] = [];
  const marker = "CONTROLLED_EDITOR_WROTE_THIS";
  // The official base disables Bash on Windows. Linux CI exercises the exact
  // production editor+Bash composition; Windows still performs the real edit.
  const bashAvailable = process.platform !== "win32";
  const task = bashAvailable
    ? "Use the official editor then Bash to read the created file."
    : "Use the official editor to create the fixture file.";
  const output = {
    protocolVersion: 1,
    operation: "task",
    state: "final",
    summary: bashAvailable ? "editor and Bash completed" : "editor completed",
    findings: [],
  };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/messages") {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      const body = z
        .looseObject({
          messages: z.array(z.looseObject({ content: z.unknown().optional() })).optional(),
          tools: z.array(z.looseObject({ name: z.string().optional() })).optional(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      requests.push(body);
      const results = messageToolResults(body);
      if (results.length < (bashAvailable ? 2 : 1)) {
        const editor = results.length === 0;
        sendMessagesSse(
          response,
          {
            tool_calls: [
              {
                index: 0,
                id: editor ? "editor-create" : "bash-read",
                type: "function",
                function: {
                  name: editor ? "str_replace_editor" : "bash",
                  arguments: JSON.stringify(
                    editor
                      ? {
                          command: "create",
                          path: join(workspace, "editor-proof.txt"),
                          file_text: `${marker}\n`,
                        }
                      : {
                          command: "cat editor-proof.txt",
                          description: "Read the actual editor-created file",
                          timeoutMs: 10_000,
                        },
                  ),
                },
              },
            ],
          },
          "tool_calls",
        );
      } else {
        sendMessagesSse(response, { content: JSON.stringify(output) }, "stop");
      }
    })().catch((error: unknown) => {
      serverErrors.push(error);
      response.writeHead(500).end("controlled editor fixture failed");
    });
  });
  try {
    await mkdir(workspace);
    const plan = resolveExtensionPlan({
      allowedTools: [],
      mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-write",
        allowed: true,
        reason: "controlled editor integration",
        capabilities: {
          readRepository: true,
          readCi: false,
          publishComments: false,
          executeRepositoryCode: true,
          loadExtensions: false,
          accessNetwork: false,
          modifyWorkspace: true,
          commit: false,
          push: false,
          createPullRequest: false,
          manageIssueLabels: false,
          manageIssueAssignees: false,
          updateIssueState: false,
          updatePullRequestMetadata: false,
        },
      },
    });
    await prepareControlledProfile({
      dshHome,
      plan,
      nativeTools: bashAvailable ? ["workspace.edit", "native.bash"] : ["workspace.edit"],
      workspaceWrite: true,
      expectedOperation: "task",
      task,
      workerWorkspacePath: workspace,
      policyPluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-policy.mjs")).href,
      workspacePluginPath: pathToFileURL(join(process.cwd(), "assets/dsh/action-workspace.mjs"))
        .href,
      workerStatePath: join(dshHome, "action-state", "counts.json"),
      workerAuditPath: join(dshHome, "action-state", "receipts.jsonl"),
      manifestBase: z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(await readFile("package.json", "utf8"))),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    const result = await execFileAsync(
      process.execPath,
      ["--expose-internals", join(process.cwd(), "assets/dsh/action-launcher.mjs"), task],
      {
        cwd: workspace,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: dshHome,
          DSH_HOME: dshHome,
          DSH_PERMISSION_MODE: "workspace-write",
          DSH_TOOLS_MODE: "native",
          DSH_TELEMETRY_DISABLED: "1",
          NARB_DISABLE_NATIVE_CACHE: "1",
          DEEPSEEK_API_KEY: "editor-fixture-key",
          DEEPSEEK_BASE_URL: `http://127.0.0.1:${String(address.port)}`,
        },
      },
    );
    expect(serverErrors).toEqual([]);
    expect(result.stderr).toBe("");
    expect(requests).toHaveLength(bashAvailable ? 3 : 2);
    for (const request of requests) {
      expect(request.tools?.map(({ name }) => name).sort()).toEqual([
        ...(bashAvailable ? ["bash"] : []),
        "edit",
        "str_replace_editor",
        "write",
      ]);
      expect(request).not.toHaveProperty("dsh_session_log");
      expect(request).not.toHaveProperty("dsh_plugin_packages");
    }
    const actualResults = JSON.stringify(messageToolResults(requests.at(-1) ?? {}));
    expect(actualResults, actualResults).not.toContain('"is_error":true');
    expect(await readFile(join(workspace, "editor-proof.txt"), "utf8")).toBe(`${marker}\n`);
    if (bashAvailable) {
      expect(JSON.stringify(messageToolResults(requests.at(-1) ?? {}).at(-1))).toContain(marker);
    }
    const receipts = (await readFile(join(dshHome, "action-state", "receipts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) =>
        z
          .looseObject({
            phase: z.string(),
            id: z.string(),
            runtimeName: z.string(),
            counted: z.boolean(),
            ok: z.boolean(),
          })
          .parse(JSON.parse(line)),
      );
    const completed = receipts.filter(({ phase }) => phase === "completed");
    expect(completed).toHaveLength(bashAvailable ? 2 : 1);
    expect(completed[0]).toMatchObject({
      id: "workspace.edit",
      runtimeName: "str_replace_editor",
      counted: true,
      ok: true,
    });
    if (bashAvailable) {
      expect(completed[1]).toMatchObject({
        id: "native.bash",
        runtimeName: "bash",
        counted: true,
        ok: true,
      });
    }
    const final = result.stdout
      .trim()
      .split("\n")
      .map((line) =>
        z.looseObject({ type: z.string(), text: z.string().optional() }).parse(JSON.parse(line)),
      )
      .at(-1);
    expect(final).toEqual({ type: "final", text: JSON.stringify(output) });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 70_000);
