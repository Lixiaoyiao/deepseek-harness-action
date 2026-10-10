import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, afterEach, expect, it, vi } from "vitest";
import type { DeepSeekProxyOptions } from "../src/dsh/proxy.js";
import { createDshRuntime, runDsh } from "../src/dsh/runner.js";
import type { DshProcessSpec } from "../src/dsh/runner.js";
import {
  PINNED_NODE_IMAGE,
  CONTAINER_PACKAGE_ROOT,
  CONTAINER_LAUNCHER,
  fakeProxy,
  networkInspectResult,
  request,
  createDshFixtureManager,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

describe("runDsh isolation", () => {
  it("rejects a Docker gateway that is not a local interface without opening a wildcard proxy", async () => {
    const fixture = await fixtures();
    await expect(
      runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        executeProcess: (spec) =>
          Promise.resolve({
            stdout: spec.args[1] === "inspect" ? "203.0.113.1\n" : "",
            stderr: "",
            exitCode: 0,
            signal: null,
          }),
      }),
    ).rejects.toThrow("requires a local Linux Docker bridge gateway");
  });

  it("checks Docker daemon before installing packages or starting the proxy/model", async () => {
    const fixture = await fixtures();
    const proxy = vi.fn(() => Promise.resolve(fakeProxy()));
    const specs: DshProcessSpec[] = [];
    await expect(
      runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
        assetsDirectory: fixture.assets,
        environment: {
          PATH: process.env.PATH,
          DEEPSEEK_API_KEY: "real-key-never-forwarded",
          GITHUB_TOKEN: "github-token-never-forwarded",
          DOCKER_CONTEXT: "maintainer-context",
        },
        startProxy: proxy,
        executeProcess: (spec, limits) => {
          specs.push(spec);
          expect(limits.timeoutMs).toBeLessThanOrEqual(5_000);
          expect(spec.args).toEqual(["info", "--format", "{{.ServerVersion}}"]);
          expect(spec.env.DOCKER_CONTEXT).toBe("maintainer-context");
          expect(JSON.stringify(spec.env)).not.toContain("never-forwarded");
          return Promise.resolve({
            exitCode: 1,
            signal: null,
            stdout: "",
            stderr: "Cannot connect to the Docker daemon",
          });
        },
      }),
    ).rejects.toThrow(/Docker CLI\/daemon is unavailable/u);
    expect(specs).toHaveLength(1);
    expect(proxy).not.toHaveBeenCalled();
  });

  it("builds a hardened Docker argv around the locked github-action Profile", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    let copiedLauncher: string | undefined;
    let controlledProfilePatch: string | undefined;
    const observedSpecs: DshProcessSpec[] = [];
    const result = await runDsh(
      request({
        operation: "fix",
        trust: "trusted-write",
        isolation: "docker",
        containerImage: PINNED_NODE_IMAGE,
        workspacePath: fixture.workspace,
      }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: (options) => {
          expect(options.bindHost).toBe("172.30.0.1");
          expect(options.workerHost).toBe("172.30.0.1");
          return Promise.resolve(proxy);
        },
        executeProcess: async (spec) => {
          observedSpecs.push(spec);
          if (spec.args[1] === "inspect") {
            return Promise.resolve({
              stdout: "172.30.0.1\n",
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          }
          if (!spec.args.includes(CONTAINER_LAUNCHER)) {
            return Promise.resolve({ stdout: "", stderr: "", exitCode: 0, signal: null });
          }
          captured = spec;
          const packageMount = spec.args.find((argument) =>
            argument.endsWith(`:${CONTAINER_PACKAGE_ROOT}:ro`),
          );
          if (packageMount === undefined) throw new Error("missing package-root mount");
          controlledProfilePatch = await readFile(
            join(
              packageMount.slice(0, -`:${CONTAINER_PACKAGE_ROOT}:ro`.length),
              "cordis.patch.yml",
            ),
            "utf8",
          );
          copiedLauncher = await readFile(
            join(
              packageMount.slice(0, -`:${CONTAINER_PACKAGE_ROOT}:ro`.length),
              "action-launcher.mjs",
            ),
            "utf8",
          );
          return Promise.resolve({
            stdout: JSON.stringify({
              protocolVersion: 1,
              operation: "fix",
              state: "final",
              summary: "Fixed.",
              findings: [],
            }),
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(observedSpecs).toHaveLength(6);
    expect(observedSpecs[0]?.args).toEqual(["info", "--format", "{{.ServerVersion}}"]);
    const installSpec = observedSpecs[1];
    const createNetworkSpec = observedSpecs[2];
    const inspectNetworkSpec = observedSpecs[3];
    const removeNetworkSpec = observedSpecs[5];
    const internalNetwork = createNetworkSpec?.args.at(-1);
    const installerCacheMount = installSpec?.args.find((argument) =>
      argument.endsWith(":/tmp/npm-cache:rw"),
    );
    expect(installSpec?.args).toContain("ci");
    expect(installSpec?.args).toContain("--ignore-scripts");
    expect(installSpec?.args).toContain("--omit=dev");
    expect(installSpec?.args).toContain("--no-audit");
    expect(installSpec?.args).toContain("4g");
    expect(installSpec?.args).toContain("NODE_OPTIONS=--max-old-space-size=3072");
    expect(installSpec?.args.some((argument) => argument.includes("@deepseek-ai/dsh@"))).toBe(
      false,
    );
    expect(installerCacheMount).toBeDefined();
    expect(createNetworkSpec?.args.slice(0, 3)).toEqual(["network", "create", "--internal"]);
    expect(inspectNetworkSpec?.args.slice(0, 4)).toEqual([
      "network",
      "inspect",
      "--format",
      "{{(index .IPAM.Config 0).Gateway}}",
    ]);
    expect(removeNetworkSpec?.args).toEqual(["network", "rm", internalNetwork]);
    expect(captured?.command).toBe("docker");
    expect(captured?.args).toContain("--read-only");
    expect(captured?.args).toContain("--user");
    expect(captured?.args).toContain("no-new-privileges");
    expect(captured?.args).toContain("/tmp:rw,noexec,nosuid,nodev,size=536870912");
    expect(captured?.args).toContain("NARB_DISABLE_NATIVE_CACHE=1");
    expect(captured?.args.some((argument) => argument.startsWith("NARB_NATIVE_CACHE_DIR="))).toBe(
      false,
    );
    expect(captured?.args).toContain(PINNED_NODE_IMAGE);
    expect(captured?.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(captured?.env).not.toHaveProperty("GH_TOKEN");
    expect(Object.values(captured?.env ?? {})).not.toContain("controller-real-key");
    expect(captured?.args.some((argument) => argument.includes("controller-real-key"))).toBe(false);
    expect(captured?.args).toContain(`${fixture.workspace}:/workspace:rw`);
    expect(captured?.args).not.toContain(installerCacheMount);
    expect(captured?.args.some((argument) => argument.endsWith(":/tmp/npm-cache:rw"))).toBe(false);
    expect(captured?.args).toContain(
      `${join(fixture.assets, "action-policy.mjs")}:/opt/dsh-action/action-policy.mjs:ro`,
    );
    expect(captured?.args).toContain(
      `${join(fixture.assets, "action-workspace.mjs")}:/opt/dsh-action/action-workspace.mjs:ro`,
    );
    expect(captured?.args).not.toContain(
      `${join(fixture.assets, "action-launcher.mjs")}:${CONTAINER_LAUNCHER}:ro`,
    );
    expect(copiedLauncher).toBe("export default async function main() {}\n");
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home:ro"))).toBe(true);
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/action-state:rw"))).toBe(
      true,
    );
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/sessions:rw"))).toBe(
      true,
    );
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/attachments:rw"))).toBe(
      true,
    );
    expect(captured?.args.some((argument) => argument.endsWith(":/dsh-home/storages:rw"))).toBe(
      true,
    );
    expect(
      captured?.args.some((argument) => argument.endsWith(":/dsh-home/profiles/github-action:ro")),
    ).toBe(true);
    expect(
      captured?.args.some((argument) => argument.endsWith(":/opt/dsh-action/package:ro")),
    ).toBe(true);
    expect(captured?.args).toContain(internalNetwork);
    expect(captured?.args).toContain("host.docker.internal:172.30.0.1");
    expect(captured?.args).not.toContain("--profile");
    expect(captured?.args).not.toContain("--patch");
    expect(captured?.args).toContain(CONTAINER_LAUNCHER);
    expect(captured?.args).not.toContain(
      "/opt/dsh-action/package/node_modules/@deepseek-ai/dsh/lib/bin.js",
    );
    expect(captured?.args).toContain("--expose-internals");
    expect(captured?.args).toContain("HOME=/dsh-home");
    expect(captured?.args).toContain("DSH_HOME=/dsh-home");
    expect(captured?.args).toContain("npm_config_cache=/tmp/npm-cache");
    expect(captured?.args).toContain("DSH_PERMISSION_MODE=workspace-write");
    expect(captured?.args).toContain("DEEPSEEK_API_KEY=ephemeral-worker-token");
    expect(captured?.args).not.toContain("npx");
    expect(captured?.termination).toMatchObject({ command: "docker" });
    expect(result.isolationReport).toMatchObject({
      networkIsolated: true,
      extensionProfile: "github-action",
    });
    expect(controlledProfilePatch).toContain('"expectedOperation": "fix"');
  });

  it("enables only read/search tools for trusted Docker reviews", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    let captured: DshProcessSpec | undefined;
    const observedSpecs: DshProcessSpec[] = [];
    const result = await runDsh(
      request({ isolation: "docker", workspacePath: fixture.workspace }),
      {
        assetsDirectory: fixture.assets,
        temporaryDirectory: fixture.root,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          observedSpecs.push(spec);
          if (spec.args[1] === "inspect") {
            return Promise.resolve({
              stdout: "172.30.0.1\n",
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          }
          const isDsh = spec.args.includes(CONTAINER_LAUNCHER);
          if (isDsh) captured = spec;
          return Promise.resolve({
            stdout: isDsh
              ? JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: "Done.",
                  findings: [],
                })
              : "",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );
    expect(result.isolationReport.repoToolsEnabled).toBe(true);
    expect(result.isolationReport.workspaceAccess).toBe("read-only");
    expect(result.isolationReport.networkIsolated).toBe(true);
    expect(result.isolationReport.extensionProfile).toBe("github-action");
    expect(captured?.args).toContain(`${fixture.workspace}:/workspace:ro`);
    const createNetworkSpec = observedSpecs.find(
      (spec) => spec.args[0] === "network" && spec.args[1] === "create",
    );
    expect(createNetworkSpec?.args).toContain("--internal");
    expect(captured?.args).toContain(createNetworkSpec?.args.at(-1));
    expect(captured?.args).toContain(CONTAINER_LAUNCHER);
    expect(captured?.args).not.toContain("--profile");
  });

  it("mediates web search through exact proxy options and worker-only proxy environment", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const proxy = {
      ...fakeProxy(),
      workerWebSearchBaseUrl: "http://host.docker.internal:3456/anthropic/v1",
    };
    let proxyOptions: DeepSeekProxyOptions | undefined;
    let captured: DshProcessSpec | undefined;

    await runDsh(
      request({
        isolation: "docker",
        workspacePath: fixture.workspace,
        nativeTools: ["workspace.read", "native.web-search"],
      }),
      {
        assetsDirectory: fixture.assets,
        runtime,
        startProxy: (options) => {
          proxyOptions = options;
          return Promise.resolve(proxy);
        },
        executeProcess: (spec) => {
          const inspected = networkInspectResult(spec);
          if (inspected !== undefined) return Promise.resolve(inspected);
          const isDsh = spec.args.includes(CONTAINER_LAUNCHER);
          if (isDsh) captured = spec;
          return Promise.resolve({
            stdout: isDsh
              ? JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: "Done.",
                  findings: [],
                })
              : "",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      },
    );

    expect(proxyOptions).toMatchObject({
      apiKey: "controller-real-key",
      baseUrl: "https://api.deepseek.com",
      webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
      allowWebSearch: true,
      bindHost: "172.30.0.1",
      workerHost: "172.30.0.1",
    });
    expect(captured?.args).toContain(
      "DEEPSEEK_SEARCH_BASE_URL=http://host.docker.internal:3456/anthropic/v1",
    );
    expect(captured?.args.join(" ")).not.toContain("https://api.deepseek.com/anthropic/v1");
    expect(Object.values(captured?.env ?? {})).not.toContain("controller-real-key");
    expect(runtime.binding?.binding.webSearchBaseUrl).toBe("https://api.deepseek.com/anthropic/v1");

    await expect(
      runDsh(
        request({
          isolation: "docker",
          workspacePath: fixture.workspace,
          nativeTools: ["workspace.read", "native.web-search"],
          webSearchBaseUrl: "https://search.example.test/anthropic/v1",
        }),
        {
          assetsDirectory: fixture.assets,
          runtime,
          startProxy: vi.fn(),
          executeProcess: vi.fn(),
        },
      ),
    ).rejects.toThrow(/binding changed:.*webSearchBaseUrl/u);
  });

  it("resolves the launcher and policy plugins from the action package instead of the caller workspace", async () => {
    const fixture = await fixtures();
    const proxy = fakeProxy();
    const callerWorkspace = join(fixture.root, "caller-workspace");
    const callerAssets = join(callerWorkspace, "assets", "dsh");
    await mkdir(callerAssets, { recursive: true });
    await writeFile(join(callerAssets, "action-policy.mjs"), "malicious caller policy\n");
    await writeFile(join(callerAssets, "action-workspace.mjs"), "malicious caller workspace\n");
    await writeFile(join(callerAssets, "action-launcher.mjs"), "malicious caller launcher\n");
    vi.spyOn(process, "cwd").mockReturnValue(callerWorkspace);
    let captured: DshProcessSpec | undefined;
    let copiedLauncher: string | undefined;

    await runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
      temporaryDirectory: fixture.root,
      environment: { PATH: process.env.PATH, GITHUB_ACTION_PATH: callerWorkspace },
      startProxy: () => Promise.resolve(proxy),
      executeProcess: async (spec) => {
        if (spec.args[1] === "inspect") {
          return Promise.resolve({
            stdout: "172.30.0.1\n",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        }
        const isDsh = spec.args.includes(CONTAINER_LAUNCHER);
        if (isDsh) {
          captured = spec;
          const packageMount = spec.args.find((argument) =>
            argument.endsWith(`:${CONTAINER_PACKAGE_ROOT}:ro`),
          );
          if (packageMount === undefined) throw new Error("missing package-root mount");
          copiedLauncher = await readFile(
            join(
              packageMount.slice(0, -`:${CONTAINER_PACKAGE_ROOT}:ro`.length),
              "action-launcher.mjs",
            ),
            "utf8",
          );
        }
        return Promise.resolve({
          stdout: isDsh
            ? JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "Done.",
                findings: [],
              })
            : "",
          stderr: "",
          exitCode: 0,
          signal: null,
        });
      },
    });

    const packagedPolicy = fileURLToPath(
      new URL("../assets/dsh/action-policy.mjs", import.meta.url),
    );
    const packagedWorkspace = fileURLToPath(
      new URL("../assets/dsh/action-workspace.mjs", import.meta.url),
    );
    const packagedLauncher = fileURLToPath(
      new URL("../assets/dsh/action-launcher.mjs", import.meta.url),
    );
    expect(captured?.args).toContain(`${packagedPolicy}:/opt/dsh-action/action-policy.mjs:ro`);
    expect(captured?.args).toContain(
      `${packagedWorkspace}:/opt/dsh-action/action-workspace.mjs:ro`,
    );
    expect(captured?.args).not.toContain(`${packagedLauncher}:${CONTAINER_LAUNCHER}:ro`);
    await expect(readFile(packagedLauncher, "utf8")).resolves.toBe(copiedLauncher);
    expect(captured?.args.join(" ")).not.toContain(callerWorkspace);
  });
});
