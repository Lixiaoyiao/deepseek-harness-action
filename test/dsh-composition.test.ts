import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DshComposition, PrepareDshCompositionOptions } from "../src/dsh/composition.js";
import {
  ControlledComposition,
  PRODUCTION_DSH_COMPOSITION,
} from "../src/dsh/controlled-composition.js";
import { NativeComposition, NATIVE_DSH_COMPOSITION } from "../src/dsh/native-composition.js";
import { createDshRuntime, disposeDshRuntime, type DshRuntime } from "../src/dsh/runtime.js";
import { selectDshComposition } from "../src/dsh/select-composition.js";
import { resolveExtensionPlan, type EffectiveExtensionPlan } from "../src/extensions/plan.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import type { SecurityPolicy } from "../src/security/policy.js";

const temporaryPaths: string[] = [];
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
    temporaryPaths.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

function extensionPlan(
  options: {
    readonly allowedTools?: readonly `mcp.${string}.${string}`[];
    readonly mcp?: string;
  } = {},
): EffectiveExtensionPlan {
  return resolveExtensionPlan({
    allowedTools: options.allowedTools ?? [],
    mcp: parseMcpConfiguration(options.mcp ?? '{"schemaVersion":1,"servers":[]}'),
    plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
    allowPluginInstall: false,
    policy: trustedRead,
  });
}

function managedMcpPlan(): EffectiveExtensionPlan {
  return extensionPlan({
    allowedTools: ["mcp.fixture.echo"],
    mcp: JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          id: "fixture",
          transport: "stdio",
          command: "fixture-mcp",
          tools: [
            {
              id: "echo",
              name: "echo",
              description: "Echo a fixture value",
              permissions: ["read"],
            },
          ],
        },
      ],
    }),
  });
}

async function controlledAssets(): Promise<{ readonly root: string; readonly assets: string }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-composition-test-"));
  temporaryPaths.push(root);
  const assets = join(root, "assets");
  await mkdir(assets);
  await Promise.all([
    writeFile(join(assets, "strict-untrusted.patch.yml"), "[]\n"),
    writeFile(join(assets, "trusted-read.patch.yml"), "[]\n"),
    writeFile(join(assets, "trusted-write.patch.yml"), "[]\n"),
    writeFile(join(assets, "action-policy.mjs"), "export default class ActionPolicy {}\n"),
    writeFile(join(assets, "action-workspace.mjs"), "export default class ActionWorkspace {}\n"),
    writeFile(join(assets, "action-launcher.mjs"), "export default async function main() {}\n"),
  ]);
  return { root, assets };
}

async function nativeAssets(): Promise<{
  readonly root: string;
  readonly assets: string;
  readonly launcher: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-composition-test-"));
  temporaryPaths.push(root);
  const assets = join(root, "assets");
  const launcher = "export default async function nativeMain() {}\n";
  await mkdir(assets);
  await writeFile(join(assets, "native-launcher.mjs"), launcher);
  return { root, assets, launcher };
}

function prepareOptions(
  runtime: DshRuntime,
  assetsDirectory: string,
  overrides: Partial<PrepareDshCompositionOptions> = {},
): PrepareDshCompositionOptions {
  return {
    isolation: "docker",
    assetsDirectory,
    runtime,
    plan: extensionPlan(),
    nativeTools: ["workspace.read", "workspace.search"],
    trust: "trusted-read",
    workspaceWrite: false,
    expectedOperation: "review",
    task: "review packet",
    workspacePath: runtime.root,
    manifestBase: { name: "locked-runtime", dependencies: {} },
    ...overrides,
  };
}

describe("composition selection", () => {
  it("keeps controlled as the production/default selection", () => {
    const selected = selectDshComposition("controlled");

    expect(selected).toMatchObject({
      mode: "controlled",
      id: "github-action-controlled",
      toolPolicyOwner: "controller",
    });
    expect(PRODUCTION_DSH_COMPOSITION).toMatchObject(selected);
    expect(selected.create()).toBeInstanceOf(ControlledComposition);
  });

  it("selects the DSH-owned native headless composition", () => {
    const selected = selectDshComposition("native");

    expect(selected).toMatchObject({
      mode: "native",
      id: "dsh-native-headless",
      toolPolicyOwner: "dsh",
    });
    expect(NATIVE_DSH_COMPOSITION).toMatchObject(selected);
    expect(selected.create()).toBeInstanceOf(NativeComposition);
  });
});

describe("ControlledComposition", () => {
  it("preserves the host headless patches and ToolRuntime policy launch", async () => {
    const fixture = await controlledAssets();
    const runtime = await createDshRuntime(fixture.root);
    const composition: DshComposition = PRODUCTION_DSH_COMPOSITION.create();

    try {
      const prepared = await composition.prepare(
        prepareOptions(runtime, fixture.assets, {
          isolation: "none",
          nativeTools: [],
          dshExecutableIdentity: process.execPath,
        }),
      );
      expect(prepared.isolation).toBe("none");
      if (prepared.isolation !== "none") throw new Error("expected a local launch plan");

      expect(prepared.launchPlan).toMatchObject({
        command: process.execPath,
        cwd: runtime.root,
      });
      expect(prepared.launchPlan.args.slice(0, 7)).toEqual([
        "--expose-internals",
        process.execPath,
        "--profile",
        "headless",
        "--patch",
        join(fixture.assets, "strict-untrusted.patch.yml"),
        "--patch",
      ]);
      const toolPolicyPath = prepared.launchPlan.args[7];
      expect(toolPolicyPath).toBeTypeOf("string");
      await expect(readFile(toolPolicyPath ?? "", "utf8")).resolves.toBe(
        "- id: tool-fs\n  disabled: true\n\n- id: tool-fs-search\n  disabled: true\n\n- id: tool-str-replace-editor\n  disabled: true\n",
      );
      expect(prepared.launchPlan.args.at(-1)).toBe("review packet");
      expect(composition.id).toBe("github-action-controlled");
      expect(PRODUCTION_DSH_COMPOSITION.toolPolicyOwner).toBe(composition.toolPolicyOwner);
      expect(composition.toolPolicyOwner).toBe("controller");
      expect(composition.profileSchemaVersion).toBe(1);
      expect(composition.actionManagedExtensionProfile).toBe(true);
      expect(composition.promptToolPolicy(["workspace.read"])).toEqual({
        policyOwner: "controller",
        nativeTools: ["workspace.read"],
      });
      expect(composition.runtimeToolNames(["workspace.read", "workspace.search"])).toEqual([
        "glob",
        "grep",
        "read",
        "read_image",
      ]);
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("prepares the current github-action Profile and positive policy artifacts", async () => {
    const fixture = await controlledAssets();
    const runtime = await createDshRuntime(fixture.root);
    const composition: DshComposition = new ControlledComposition();

    try {
      const prepared = await composition.prepare(prepareOptions(runtime, fixture.assets));
      expect(prepared.isolation).toBe("docker");
      if (prepared.isolation !== "docker") throw new Error("expected a Docker launch plan");
      const receipts = prepared.receipts;
      expect(receipts).toBeDefined();
      if (receipts === undefined) throw new Error("expected controlled receipt metadata");

      const manifest = JSON.parse(
        await readFile(join(runtime.packageRoot, "package.json"), "utf8"),
      ) as {
        readonly name: string;
        readonly dsh: { readonly profile: { readonly bundles: readonly string[] } };
      };
      const rows = JSON.parse(
        await readFile(join(runtime.packageRoot, "cordis.patch.yml"), "utf8"),
      ) as {
        readonly insert?: readonly { readonly id?: string; readonly config?: unknown }[];
      }[];
      const policy = rows
        .flatMap(({ insert }) => insert ?? [])
        .find(({ id }) => id === "dsh-action-policy");

      expect(receipts).toMatchObject({
        statePath: join(runtime.dshHome, "action-state", "tool-counts.json"),
        auditPath: join(runtime.dshHome, "action-state", "tool-receipts.jsonl"),
      });
      expect(prepared.launchPlan).toMatchObject({
        command: "node",
        args: [
          "--expose-internals",
          "/opt/dsh-action/package/action-launcher.mjs",
          "review packet",
        ],
        workdir: "/tmp",
      });
      expect(prepared.launchPlan.mounts.map(({ destinationPath }) => destinationPath)).toEqual([
        "/dsh-home/profiles/github-action",
        "/opt/dsh-action/action-policy.mjs",
        "/opt/dsh-action/action-workspace.mjs",
      ]);
      expect(manifest).toMatchObject({
        name: "dsh-profile-github-action",
        dsh: {
          profile: {
            bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"],
          },
        },
      });
      expect(policy?.config).toMatchObject({
        expectedOperation: "review",
        allowedRuntimeTools: ["read", "read_image", "glob", "grep"],
      });
      expect(receipts.rules.map(({ runtimeName }) => runtimeName)).toEqual([
        "read",
        "read_image",
        "glob",
        "grep",
      ]);
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("keeps direct plugins unbootable until their installed entry is containment-validated", async () => {
    const fixture = await controlledAssets();
    const runtime = await createDshRuntime(fixture.root);
    const composition: DshComposition = new ControlledComposition();
    const packageName = "@acme/dsh-fixture";
    const plan = resolveExtensionPlan({
      allowedTools: ["plugin.fixture.allowed"],
      mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
      plugins: parsePluginConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          bundles: [],
          plugins: [
            {
              id: "fixture",
              package: packageName,
              source: "1.2.3",
              config: { fixture: "direct" },
              tools: [
                {
                  id: "allowed",
                  name: "plugin__fixture__allowed",
                  description: "Return a controlled marker",
                  permissions: ["read"],
                  maxCalls: 1,
                },
              ],
            },
          ],
        }),
      ),
      allowPluginInstall: true,
      policy: trustedRead,
    });
    const options = prepareOptions(runtime, fixture.assets, {
      plan,
      nativeTools: [],
      expectedOperation: "task",
      task: "Call the controlled plugin.",
    });

    try {
      const prepared = await composition.prepare(options);
      expect(prepared.isolation).toBe("docker");
      if (prepared.isolation !== "docker") throw new Error("expected a Docker launch plan");
      await expect(
        readFile(join(runtime.packageRoot, "cordis.patch.yml"), "utf8"),
      ).resolves.toContain("file:///__dsh_action_unresolved_plugin__/fixture.mjs");

      const installedPackage = join(runtime.packageRoot, "node_modules", ...packageName.split("/"));
      await mkdir(installedPackage, { recursive: true });
      await writeFile(
        join(installedPackage, "package.json"),
        `${JSON.stringify({ name: packageName, version: "1.2.3", main: "./index.mjs" })}\n`,
      );
      await writeFile(join(installedPackage, "index.mjs"), "export default class Fixture {}\n");

      if (prepared.finalizeAfterInstall === undefined) {
        throw new Error("expected controlled plugin finalization");
      }
      await prepared.finalizeAfterInstall(async (prepare) => await prepare());
      expect(runtime.verifiedPluginModuleSpecifiers).toEqual({
        fixture: "/dsh-home/profiles/github-action/node_modules/@acme/dsh-fixture/index.mjs",
      });
      const finalPatch = await readFile(join(runtime.packageRoot, "cordis.patch.yml"), "utf8");
      expect(finalPatch).toContain(
        "/dsh-home/profiles/github-action/node_modules/@acme/dsh-fixture/index.mjs",
      );
      expect(finalPatch).not.toContain("__dsh_action_unresolved_plugin__");
    } finally {
      await disposeDshRuntime(runtime);
    }
  });
});

describe("NativeComposition", () => {
  it("prepares the official native headless plan without controlled artifacts", async () => {
    const fixture = await nativeAssets();
    const runtime = await createDshRuntime(fixture.root);
    const composition: DshComposition = new NativeComposition();

    try {
      await expect(readFile(join(fixture.assets, "action-policy.mjs"), "utf8")).rejects.toThrow();
      await expect(
        readFile(join(fixture.assets, "action-workspace.mjs"), "utf8"),
      ).rejects.toThrow();
      const prepared = await composition.prepare(prepareOptions(runtime, fixture.assets));
      expect(prepared.isolation).toBe("docker");
      if (prepared.isolation !== "docker") throw new Error("expected a Docker launch plan");

      expect(composition).toMatchObject({
        id: "dsh-native-headless",
        toolPolicyOwner: "dsh",
        actionManagedExtensionProfile: false,
      });
      expect(composition.promptToolPolicy(["workspace.read", "native.bash"])).toEqual({
        policyOwner: "dsh",
      });
      expect(composition.runtimeToolNames(["workspace.read", "native.bash"])).toEqual([]);
      expect(composition.requiresWebSearchProxy([])).toBe(true);
      expect(prepared.launchPlan).toEqual({
        command: "node",
        args: [
          "--expose-internals",
          "/opt/dsh-action/package/native-launcher.mjs",
          "review packet",
        ],
        workdir: "/workspace",
        mounts: [],
      });
      expect(prepared).not.toHaveProperty("receipts");
      expect(prepared).not.toHaveProperty("finalizeAfterInstall");
      expect(prepared.launchPlan).not.toHaveProperty("policyPluginPath");
      expect(prepared.launchPlan).not.toHaveProperty("workspacePluginPath");
      expect(JSON.stringify(prepared.launchPlan)).not.toContain("action-policy");
      expect(JSON.stringify(prepared.launchPlan)).not.toContain("action-workspace");
      await expect(
        readFile(join(runtime.packageRoot, "native-launcher.mjs"), "utf8"),
      ).resolves.toBe(fixture.launcher);

      const nativeManifest = JSON.parse(
        await readFile(join(runtime.dshHome, "profiles", "headless", "package.json"), "utf8"),
      ) as { readonly dsh: { readonly profile: { readonly bundles: readonly string[] } } };
      expect(nativeManifest.dsh.profile.bundles).toEqual([
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
      ]);
      await expect(
        readFile(join(runtime.dshHome, "profiles", "headless", "action-native-root.yml"), "utf8"),
      ).resolves.toBe("[]\n");
      await expect(
        readFile(join(runtime.dshHome, "profiles", "headless", "cordis.patch.yml"), "utf8"),
      ).resolves.toBe("[]\n");

      const observationPath = join(runtime.dshHome, "action-state", "native-observed-tools.jsonl");
      await appendFile(
        observationPath,
        `${JSON.stringify({
          schemaVersion: 1,
          source: "ctx.tools.schemas(agent)",
          observedTools: ["read", "bash", "grep"],
        })}\n${JSON.stringify({
          schemaVersion: 1,
          source: "ctx.tools.schemas(agent)",
          observedTools: ["web_search", "read"],
        })}\n`,
      );
      expect(prepared.observedTools).toBeDefined();
      await expect(prepared.observedTools?.collect()).resolves.toEqual([
        "bash",
        "grep",
        "read",
        "web_search",
      ]);
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("fails closed for host isolation and Action-managed extensions", async () => {
    const fixture = await nativeAssets();
    const runtime = await createDshRuntime(fixture.root);
    const composition: DshComposition = new NativeComposition();

    try {
      await expect(
        composition.prepare(
          prepareOptions(runtime, fixture.assets, {
            isolation: "none",
            dshExecutableIdentity: process.execPath,
          }),
        ),
      ).rejects.toThrow(/requires Docker isolation/u);

      await expect(
        composition.prepare(
          prepareOptions(runtime, fixture.assets, {
            plan: managedMcpPlan(),
          }),
        ),
      ).rejects.toThrow(/does not yet support Action-managed MCP, Bundle, or Plugin/u);
    } finally {
      await disposeDshRuntime(runtime);
    }
  });
});
