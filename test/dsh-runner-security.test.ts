import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import {
  DshConfigurationError,
  DshCredentialLeakError,
  DshIsolationUnavailableError,
} from "../src/dsh/errors.js";
import { runDsh } from "../src/dsh/runner.js";
import { parseTaskOutputSchema } from "../src/dsh/task-output.js";
import type { DshProcessSpec } from "../src/dsh/runner.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import {
  PINNED_NODE_IMAGE,
  CONTAINER_LAUNCHER,
  fakeProxy,
  networkInspectResult,
  request,
  createDshFixtureManager,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

describe("runDsh security", () => {
  it.each(["0.0.0.0", "127.0.0.1", "224.0.0.1"])(
    "rejects an unusable Docker gateway %s before creating the credential proxy",
    async (gateway) => {
      const fixture = await fixtures();
      const startProxy = vi.fn(() => Promise.resolve(fakeProxy()));
      await expect(
        runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy,
          executeProcess: (spec) =>
            Promise.resolve({
              stdout: spec.args[1] === "inspect" ? gateway : "",
              stderr: "",
              exitCode: 0,
              signal: null,
            }),
        }),
      ).rejects.toBeInstanceOf(DshIsolationUnavailableError);
      expect(startProxy).not.toHaveBeenCalled();
    },
  );

  it("fails closed if a direct caller places a Controller credential in the task schema", async () => {
    const fixture = await fixtures();
    const taskOutputSchema = parseTaskOutputSchema(
      JSON.stringify({ type: "object", description: "controller-real-key" }),
    );
    if (taskOutputSchema === undefined) throw new Error("expected task output schema");
    await expect(
      runDsh(
        request({
          operation: "task",
          workspacePath: fixture.workspace,
          dshExecutable: fixture.executable,
          taskOutputSchema,
        }),
        { assetsDirectory: fixture.assets, temporaryDirectory: fixture.root },
      ),
    ).rejects.toBeInstanceOf(DshCredentialLeakError);
  });

  it("adapts the orchestrator seam, parses output, and keeps controller secrets out of worker env/argv", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const output = {
      protocolVersion: 1,
      operation: "review",
      state: "final",
      summary: "Looks sound.",
      findings: [],
    };
    const result = await runDsh(
      request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        environment: {
          PATH: process.env.PATH,
          GITHUB_TOKEN: "github-secret",
          DEEPSEEK_API_KEY: "environment-real-key",
        },
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          captured = spec;
          return Promise.resolve({
            stdout: JSON.stringify(output),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(result.output).toEqual(output);
    expect(result.isolationReport).toMatchObject({
      backend: "none",
      credentialMediated: true,
      repoToolsEnabled: false,
      networkIsolated: false,
    });
    expect(captured?.args.slice(0, 6)).toEqual([
      "--expose-internals",
      fixture.executable,
      "--profile",
      "headless",
      "--patch",
      join(fixture.assets, "strict-untrusted.patch.yml"),
    ]);
    expect(captured?.args.join(" ")).not.toContain("controller-real-key");
    expect(Object.values(captured?.env ?? {})).not.toContain("controller-real-key");
    expect(captured?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(captured?.env.DEEPSEEK_API_KEY).toBe("ephemeral-worker-token");
    expect(proxy.closeMock).toHaveBeenCalledOnce();
  });

  it.each(["none", "docker"] as const)(
    "rejects a Controller credential in the complete %s worker prompt before launch",
    async (isolation) => {
      const fixture = await fixtures();
      const controllerCredential = "ghs_controller-prompt-secret";
      const startProxy = vi.fn(() => Promise.resolve(fakeProxy()));
      const executeProcess = vi.fn();
      let failure: unknown;

      try {
        await runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation,
            ...(isolation === "none" ? { dshExecutable: fixture.executable } : {}),
            controllerCredentials: [controllerCredential],
            prompt: `review packet ${controllerCredential}`,
          }),
          {
            assetsDirectory: fixture.assets,
            temporaryDirectory: fixture.root,
            startProxy,
            executeProcess,
          },
        );
      } catch (error: unknown) {
        failure = error;
      }

      expect(failure).toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
      expect(String(failure)).not.toContain(controllerCredential);
      expect(startProxy).not.toHaveBeenCalled();
      expect(executeProcess).not.toHaveBeenCalled();
    },
  );

  it.each(["none", "docker"] as const)(
    "rejects a Controller credential in the final %s worker argv/environment",
    async (isolation) => {
      const fixture = await fixtures();
      const proxy = fakeProxy();
      const workerExecutions: DshProcessSpec[] = [];

      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation,
            ...(isolation === "none" ? { dshExecutable: fixture.executable } : {}),
            // Exercise the final launch scanner by making an invalid proxy
            // capability collide with a Controller-owned credential.
            controllerCredentials: [proxy.workerToken],
          }),
          {
            assetsDirectory: fixture.assets,
            temporaryDirectory: fixture.root,
            startProxy: () => Promise.resolve(proxy),
            executeProcess: (spec) => {
              if (spec.args.includes(CONTAINER_LAUNCHER)) workerExecutions.push(spec);
              return Promise.resolve(
                networkInspectResult(spec) ?? {
                  stdout: "",
                  stderr: "",
                  exitCode: 0,
                  signal: null,
                },
              );
            },
          },
        ),
      ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
      expect(workerExecutions).toHaveLength(0);
    },
  );

  it("rejects an explicit Controller credential in stdout without echoing it", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const controllerCredential = "ghs_controller-stdout-secret";
    let failure: unknown;

    try {
      await runDsh(
        request({
          workspacePath: fixture.workspace,
          dshExecutable: fixture.executable,
          controllerCredentials: [controllerCredential],
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy: () => Promise.resolve(proxy),
          executeProcess: () =>
            Promise.resolve({
              stdout: JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: controllerCredential,
                findings: [],
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
            }),
        },
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
    expect(String(failure)).not.toContain(controllerCredential);
  });

  it("requires Docker for untrusted work", async () => {
    await expect(runDsh(request({ trust: "untrusted" }))).rejects.toBeInstanceOf(
      DshIsolationUnavailableError,
    );
  });

  it("requires Docker for trusted writes", async () => {
    await expect(
      runDsh(request({ operation: "fix", trust: "trusted-write" })),
    ).rejects.toBeInstanceOf(DshIsolationUnavailableError);
  });

  it.each([
    "--privileged",
    "--network=host",
    " node:24-bookworm",
    "node:24 bookworm",
    "https://registry.example/image",
    "node:",
    "repo//image",
    "repo/foo..bar:tag",
    "repo/foo._bar:tag",
    "bad_name:5000/image",
  ])(
    "rejects a Docker option or malformed image reference %s for read-only workers",
    async (containerImage) => {
      const startProxy = vi.fn();
      const executeProcess = vi.fn();
      await expect(
        runDsh(request({ isolation: "docker", containerImage }), { startProxy, executeProcess }),
      ).rejects.toBeInstanceOf(DshConfigurationError);
      expect(startProxy).not.toHaveBeenCalled();
      expect(executeProcess).not.toHaveBeenCalled();
    },
  );

  it.each([
    "node:24-bookworm",
    `node@sha256:${"a".repeat(63)}`,
    `node@sha256:${"A".repeat(64)}`,
    `node@@sha256:${"a".repeat(64)}`,
    ` node@sha256:${"a".repeat(64)}`,
  ])("rejects mutable or malformed trusted-write image %s", async (containerImage) => {
    const startProxy = vi.fn();
    const executeProcess = vi.fn();
    await expect(
      runDsh(
        request({
          operation: "fix",
          trust: "trusted-write",
          isolation: "docker",
          containerImage,
        }),
        { startProxy, executeProcess },
      ),
    ).rejects.toBeInstanceOf(DshConfigurationError);
    expect(startProxy).not.toHaveBeenCalled();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("fails closed before execution when Bash would share bridge extension egress", async () => {
    const fixture = await fixtures();
    const extensions = resolveExtensionPlan({
      allowedTools: ["mcp.remote.search"],
      mcp: parseMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "remote",
              transport: "streamable-http",
              url: "https://mcp.example.test/rpc",
              tools: [
                {
                  id: "search",
                  name: "search",
                  description: "Search",
                  permissions: ["read", "workspace-write", "network"],
                },
              ],
            },
          ],
        }),
      ),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: {
        trust: "trusted-write",
        allowed: true,
        reason: "test",
        capabilities: {
          readRepository: true,
          readCi: false,
          publishComments: true,
          executeRepositoryCode: true,
          loadExtensions: true,
          accessNetwork: true,
          modifyWorkspace: true,
          commit: true,
          push: true,
          createPullRequest: true,
          manageIssueLabels: true,
          manageIssueAssignees: true,
          updateIssueState: true,
          updatePullRequestMetadata: true,
        },
      },
    });
    const startProxy = vi.fn();
    const executeProcess = vi.fn();

    await expect(
      runDsh(
        request({
          operation: "fix",
          trust: "trusted-write",
          isolation: "docker",
          containerImage: PINNED_NODE_IMAGE,
          workspacePath: fixture.workspace,
          nativeTools: ["native.bash"],
          extensions,
        }),
        {
          assetsDirectory: fixture.assets,
          temporaryDirectory: fixture.root,
          startProxy,
          executeProcess,
        },
      ),
    ).rejects.toThrow(/native\.bash cannot share a worker with a bridge-networked extension/u);
    expect(startProxy).not.toHaveBeenCalled();
    expect(executeProcess).not.toHaveBeenCalled();
  });

  it("rejects model output containing a known controller credential", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    await expect(
      runDsh(request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }), {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: () =>
          Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "review",
              state: "final",
              summary: "controller-real-key",
              findings: [],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          }),
      }),
    ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
  });

  it.each(["path-secret", "query-secret", "header-secret"])(
    "rejects DSH output containing an MCP endpoint or header secret: %s",
    async (leakedSecret) => {
      const fixture = await fixtures();
      const proxy = fakeProxy();
      const extensions = resolveExtensionPlan({
        allowedTools: ["mcp.remote.search"],
        mcp: parseMcpConfiguration(
          JSON.stringify({
            schemaVersion: 1,
            servers: [
              {
                id: "remote",
                transport: "streamable-http",
                url: "https://mcp.example.test/rpc/path-secret?token=query-secret",
                headers: { Authorization: "Bearer header-secret" },
                tools: [
                  {
                    id: "search",
                    name: "search",
                    description: "Search",
                    permissions: ["read", "network"],
                  },
                ],
              },
            ],
          }),
        ),
        plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
        allowPluginInstall: false,
        policy: {
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
        },
      });
      await expect(
        runDsh(
          request({
            workspacePath: fixture.workspace,
            isolation: "docker",
            containerImage: PINNED_NODE_IMAGE,
            extensions,
          }),
          {
            assetsDirectory: fixture.assets,
            temporaryDirectory: fixture.root,
            startProxy: () => Promise.resolve(proxy),
            executeProcess: (spec) =>
              Promise.resolve(
                networkInspectResult(spec) ??
                  (spec.args.includes(CONTAINER_LAUNCHER)
                    ? {
                        stdout: JSON.stringify({
                          protocolVersion: 1,
                          operation: "review",
                          state: "final",
                          summary: "Done.",
                          findings: [],
                        }),
                        stderr: `MCP connection failed at ${leakedSecret}`,
                        exitCode: 0,
                        signal: null,
                      }
                    : { stdout: "", stderr: "", exitCode: 0, signal: null }),
              ),
          },
        ),
      ).rejects.toMatchObject({ code: "DSH_CREDENTIAL_LEAK" });
    },
  );
});
