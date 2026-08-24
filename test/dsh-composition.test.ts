import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DshComposition } from "../src/dsh/composition.js";
import {
  ControlledComposition,
  PRODUCTION_DSH_COMPOSITION,
} from "../src/dsh/controlled-composition.js";
import { createDshRuntime, disposeDshRuntime } from "../src/dsh/runtime.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
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

describe("ControlledComposition", () => {
  it("owns the existing trust patches and host ToolRuntime policy", async () => {
    const fixture = await controlledAssets();
    const runtime = await createDshRuntime(fixture.root);
    const composition: DshComposition = PRODUCTION_DSH_COMPOSITION.create();

    try {
      await expect(
        composition.prepareBasePatch({
          assetsDirectory: fixture.assets,
          trust: "trusted-read",
          isolation: "none",
        }),
      ).resolves.toEqual({ patchPath: join(fixture.assets, "strict-untrusted.patch.yml") });
      await expect(
        composition.prepareBasePatch({
          assetsDirectory: fixture.assets,
          trust: "trusted-read",
          isolation: "docker",
        }),
      ).resolves.toEqual({ patchPath: join(fixture.assets, "trusted-read.patch.yml") });
      await expect(
        composition.prepareBasePatch({
          assetsDirectory: fixture.assets,
          trust: "trusted-write",
          isolation: "docker",
        }),
      ).resolves.toEqual({ patchPath: join(fixture.assets, "trusted-write.patch.yml") });

      const prepared = await composition.prepareLocal({
        isolation: "none",
        assetsDirectory: fixture.assets,
        runtime,
        nativeTools: [],
      });
      await expect(readFile(prepared.toolPolicyPath, "utf8")).resolves.toBe(
        "- id: tool-fs\n  disabled: true\n\n- id: tool-fs-search\n  disabled: true\n\n- id: tool-str-replace-editor\n  disabled: true\n",
      );
      expect(composition.id).toBe("github-action-controlled");
      expect(PRODUCTION_DSH_COMPOSITION.toolPolicyOwner).toBe(composition.toolPolicyOwner);
      expect(composition.toolPolicyOwner).toBe("controller");
      expect(composition.profileSchemaVersion).toBe(1);
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
    const plan = resolveExtensionPlan({
      allowedTools: ["workspace.read", "workspace.search"],
      mcp: parseMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
      plugins: parsePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
      allowPluginInstall: false,
      policy: trustedRead,
    });

    try {
      const prepared = await composition.prepareDocker({
        isolation: "docker",
        assetsDirectory: fixture.assets,
        runtime,
        plan,
        nativeTools: ["workspace.read", "workspace.search"],
        workspaceWrite: false,
        expectedOperation: "review",
        task: "review packet",
        manifestBase: { name: "locked-runtime", dependencies: {} },
      });
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

      expect(prepared).toMatchObject({
        isolation: "docker",
        statePath: join(runtime.dshHome, "action-state", "tool-counts.json"),
        auditPath: join(runtime.dshHome, "action-state", "tool-receipts.jsonl"),
      });
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
      expect(prepared.rules.map(({ runtimeName }) => runtimeName)).toEqual([
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
    const options = {
      isolation: "docker" as const,
      assetsDirectory: fixture.assets,
      runtime,
      plan,
      nativeTools: [],
      workspaceWrite: false,
      expectedOperation: "task" as const,
      task: "Call the controlled plugin.",
      manifestBase: { name: "locked-runtime", dependencies: {} },
    };

    try {
      const prepared = await composition.prepareDocker(options);
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
