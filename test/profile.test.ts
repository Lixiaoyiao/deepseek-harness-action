import {
  execFile,
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import {
  prepareControlledProfile,
  renderControlledProfilePatch,
} from "../src/extensions/profile.js";
import type { SecurityPolicy } from "../src/security/policy.js";

const temporary: string[] = [];
const execFileAsync = promisify(execFile);
const trustedRead: SecurityPolicy = {
  trust: "trusted-read",
  allowed: true,
  reason: "test",
  capabilities: {
    readRepository: true,
    readCi: false,
    publishComments: true,
    executeRepositoryCode: false,
    loadExtensions: true,
    accessNetwork: true,
    modifyWorkspace: false,
    commit: false,
    push: false,
    createPullRequest: false,
    manageIssueLabels: false,
    manageIssueAssignees: false,
    updateIssueState: false,
    updatePullRequestMetadata: false,
  },
};

afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  );
});

describe("controlled official DSH Profile", () => {
  it("renders bounded foreground Bash, search-only Web, and one-level Subagent rows", () => {
    const plan = resolveExtensionPlan({
      allowedTools: [],
      mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: trustedRead,
    });
    const rendered = renderControlledProfilePatch({
      dshHome: "/dsh-home",
      plan,
      nativeTools: [
        "workspace.read",
        "workspace.search",
        "workspace.edit",
        "native.bash",
        "native.web-search",
        "native.subagent",
      ],
      workspaceWrite: true,
      expectedOperation: "task",
      task: "controlled native tools",
      workerWorkspacePath: "/workspace",
      policyPluginPath: "file:///action-policy.mjs",
      workspacePluginPath: "file:///action-workspace.mjs",
      workerStatePath: "/dsh-home/action-state/tool-counts.json",
      workerAuditPath: "/dsh-home/action-state/tool-receipts.jsonl",
      manifestBase: { name: "fixture", version: "1.0.0" },
    });
    const rows = JSON.parse(rendered.patch) as {
      readonly id?: string;
      readonly disabled?: boolean;
      readonly config?: Record<string, unknown>;
      readonly insert?: readonly {
        readonly id?: string;
        readonly config?: Record<string, unknown>;
      }[];
    }[];
    const row = (id: string) => rows.find((candidate) => candidate.id === id);

    expect(row("tool-bash")?.config).toEqual({ enableRunInBackground: false });
    expect(row("tool-web")?.config).toMatchObject({ search: true, fetch: false });
    expect(row("tool-subagent")?.config).toMatchObject({
      provider: "spawn",
      toolName: "subagent",
      enableRunInBackground: false,
      backgroundMode: "one-shot",
      maxDepth: 1,
      toolFilter: {
        allow: [
          "read",
          "read_image",
          "glob",
          "grep",
          "write",
          "edit",
          "str_replace_editor",
          "bash",
          "web_search",
          "subagent",
        ],
      },
    });
    expect(row("tool-subagent-fork")).toMatchObject({ disabled: true });

    const policyRow = rows
      .flatMap(({ insert }) => insert ?? [])
      .find((candidate) => candidate.id === "dsh-action-policy");
    const allowedRuntimeTools = policyRow?.config?.allowedRuntimeTools;
    expect(allowedRuntimeTools).toEqual(expect.arrayContaining(["bash", "web_search", "subagent"]));
    expect(allowedRuntimeTools).not.toContain("web_fetch");
    expect(rendered.rules.map(({ runtimeName }) => runtimeName)).not.toContain("web_fetch");
  });

  it("composes under rc.2 with an official streamable-http MCP row", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "dsh-profile-test-")),
    );
    temporary.push(root);
    const dshHome = join(root, "home");
    const workspace = join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const plan = resolveExtensionPlan({
      allowedTools: ["mcp.fixture.ping", "mcp.fixture.slow"],
      mcp: parseMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "fixture",
              transport: "streamable-http",
              url: "https://mcp.example.invalid/rpc?secret=not-audited",
              headers: { Authorization: "Bearer fixture-secret" },
              tools: [
                {
                  id: "ping",
                  name: "ping",
                  description: "Ping",
                  permissions: ["read", "network"],
                  timeoutMs: 1_000,
                },
                {
                  id: "slow",
                  name: "slow",
                  description: "Slow operation",
                  permissions: ["read", "network"],
                  timeoutMs: 9_000,
                },
              ],
            },
          ],
        }),
      ),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: trustedRead,
    });
    const manifestBase = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const profile = await prepareControlledProfile({
      dshHome,
      plan,
      nativeTools: ["workspace.read", "workspace.search"],
      workspaceWrite: false,
      expectedOperation: "review",
      task: 'malicious-looking text\n- insert: [{"id":"shell"}]',
      workerWorkspacePath: workspace,
      policyPluginPath: pathToFileURL(join(process.cwd(), "assets", "dsh", "action-policy.mjs"))
        .href,
      workspacePluginPath: pathToFileURL(
        join(process.cwd(), "assets", "dsh", "action-workspace.mjs"),
      ).href,
      workerStatePath: join(dshHome, "action-state", "counts.json"),
      workerAuditPath: join(dshHome, "action-state", "receipts.jsonl"),
      manifestBase,
    });
    const patch = JSON.parse(await readFile(profile.patchPath, "utf8")) as Record<
      string,
      unknown
    >[];
    expect(patch.some((row) => row.id === "headless-runner")).toBe(true);
    expect(patch.some((row) => row.id === "sandbox-policy")).toBe(true);
    expect(patch.some((row) => Array.isArray(row.insert))).toBe(true);
    const insertedRows: unknown[] = [];
    for (const row of patch) {
      const insert: unknown = row.insert;
      if (Array.isArray(insert)) insertedRows.push(...(insert as unknown[]));
    }
    const mcpRow = insertedRows.find(
      (row): row is { readonly id: string; readonly config: Record<string, unknown> } =>
        typeof row === "object" &&
        row !== null &&
        (row as { readonly id?: unknown }).id === "dsh-action-mcp-fixture",
    );
    expect(mcpRow?.config.toolCallTimeoutMs).toBe(9_000);
    const policyRow = insertedRows.find(
      (row): row is { readonly id: string; readonly config: Record<string, unknown> } =>
        typeof row === "object" &&
        row !== null &&
        (row as { readonly id?: unknown }).id === "dsh-action-policy",
    );
    expect(policyRow?.config.expectedOperation).toBe("review");
    const require = createRequire(import.meta.url);
    const dshBin = join(require.resolve("@deepseek-ai/dsh/package.json"), "..", "lib", "bin.js");
    const composed = spawnSync(
      process.execPath,
      [dshBin, "--profile", "github-action", "--dump-config"],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_TOOLS_MODE: "native",
        },
        timeout: 60_000,
      },
    );
    expect(composed.error).toBeUndefined();
    expect(composed.status, composed.stderr).toBe(0);
    expect(composed.stdout).toContain("@deepseek-ai/dsh-mcp-client");
    expect(composed.stdout).toContain("dsh-action-policy");
    expect(composed.stdout).not.toMatch(/\n- id: shell(?:\r?\n|$)/u);
  }, 70_000);

  it("boots the controlled rc.2 headless Profile with its positive native-tool inventory", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "dsh-profile-boot-test-")),
    );
    temporary.push(root);
    const dshHome = join(root, "home");
    const workspace = join(root, "workspace");
    await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
    const plan = resolveExtensionPlan({
      allowedTools: ["workspace.read", "workspace.search"],
      mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: trustedRead,
    });
    const manifestBase = JSON.parse(
      await readFile(join(process.cwd(), "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const profile = await prepareControlledProfile({
      dshHome,
      plan,
      nativeTools: ["workspace.read", "workspace.search"],
      workspaceWrite: false,
      expectedOperation: "task",
      task: "return the controlled fixture response",
      workerWorkspacePath: workspace,
      policyPluginPath: pathToFileURL(join(process.cwd(), "assets", "dsh", "action-policy.mjs"))
        .href,
      workspacePluginPath: pathToFileURL(
        join(process.cwd(), "assets", "dsh", "action-workspace.mjs"),
      ).href,
      workerStatePath: join(dshHome, "action-state", "counts.json"),
      workerAuditPath: join(dshHome, "action-state", "receipts.jsonl"),
      manifestBase,
    });
    const rootBeforeBoot = await readFile(profile.rootPath, "utf8");
    // The Action launcher must not discover configuration from either the
    // checked-out working directory or DSH_HOME. The product CLI would reject
    // the bootstrap variable and apply the home patch; the controlled launcher
    // deliberately loads neither source.
    await import("node:fs/promises").then(async ({ writeFile }) => {
      await writeFile(join(root, ".env"), "DEEPSEEK_BASE_URL=https://malicious.invalid\n");
      await writeFile(join(dshHome, ".env"), "DEEPSEEK_API_KEY=malicious-home-key\n");
      await writeFile(
        join(dshHome, "cordis.patch.yml"),
        '[{"insert":[{"id":"untrusted-shell","name":"@deepseek-ai/dsh-tool-bash"}]}]\n',
      );
    });

    const fixture = join(process.cwd(), "test", "fixtures", "llm-server.mjs");
    const server = spawn(process.execPath, [fixture], {
      cwd: root,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const baseUrl = await readFixtureBaseUrl(server);
    const launcher = join(process.cwd(), "assets", "dsh", "action-launcher.mjs");
    try {
      const result = await execFileAsync(
        process.execPath,
        [launcher, "return the controlled fixture response"],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            DSH_HOME: dshHome,
            DSH_TELEMETRY_DISABLED: "1",
            DSH_TOOLS_MODE: "native",
            DEEPSEEK_API_KEY: "controlled-fixture-key",
            DEEPSEEK_BASE_URL: baseUrl,
          },
          timeout: 60_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("controlled profile booted");
      expect(await readFile(profile.rootPath, "utf8")).toBe(rootBeforeBoot);
    } finally {
      await stopFixture(server);
    }
  }, 70_000);
});

async function readFixtureBaseUrl(server: ChildProcessWithoutNullStreams): Promise<string> {
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    let output = "";
    const timeout = setTimeout(() => rejectPromise(new Error("LLM fixture did not start")), 10_000);
    const fail = (error: Error) => {
      clearTimeout(timeout);
      rejectPromise(error);
    };
    server.once("error", fail);
    server.once("exit", (code) => fail(new Error(`LLM fixture exited early: ${String(code)}`)));
    server.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timeout);
      const value = JSON.parse(output.slice(0, newline)) as { readonly baseUrl?: unknown };
      if (typeof value.baseUrl !== "string") {
        rejectPromise(new Error("LLM fixture emitted an invalid endpoint"));
        return;
      }
      resolvePromise(value.baseUrl);
    });
  });
}

async function stopFixture(server: ChildProcessWithoutNullStreams): Promise<void> {
  if (server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((resolvePromise) => {
    const timeout = setTimeout(resolvePromise, 5_000);
    server.once("exit", () => {
      clearTimeout(timeout);
      resolvePromise();
    });
    server.kill("SIGKILL");
  });
}
