import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, afterEach, expect, it } from "vitest";
import {
  assertExtensionPackagesDoNotShadowRuntime,
  assertInstalledRuntimeInventoryUnchanged,
  assertSupportedDshVersion,
  installedTopLevelPackageInventory,
  createDshRuntime,
  disposeDshRuntime,
  runDsh,
} from "../src/dsh/runner.js";
import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { parsePluginConfiguration } from "../src/extensions/schema.js";
import { evaluatePolicy } from "../src/security/policy.js";
import { permissions, pullRequestContext } from "./helpers.js";
import { dockerInstallAdapter, type InstalledFixture } from "./helpers/dsh-install-adapter.js";
import { fixtureObject, readFixtureManifest } from "./helpers/json-fixture.js";
import {
  createDshFixtureManager,
  fakeProxy,
  request,
  PINNED_NODE_IMAGE,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { temporaryPaths, fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

function extensionPlan(
  source = "1.2.3",
  packageName = "@acme/guard",
  kind: "bundle" | "plugin" = "bundle",
) {
  const definition = {
    id: "guard",
    package: packageName,
    source,
    network: false,
    tools: [
      {
        id: "lookup",
        name: "plugin__guard__lookup",
        description: "Read package metadata",
        permissions: ["read"],
      },
    ],
  };
  return resolveExtensionPlan({
    allowedTools: ["plugin.guard.lookup"],
    mcp: { schemaVersion: 1, servers: [] },
    plugins: parsePluginConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        bundles: kind === "bundle" ? [definition] : [],
        plugins: kind === "plugin" ? [definition] : [],
      }),
    ),
    allowPluginInstall: true,
    policy: evaluatePolicy({
      context: pullRequestContext(),
      operation: "review",
      allowWrite: false,
      permissions: permissions(true),
    }),
  });
}

async function installationFixture(
  mutate?: (fixture: InstalledFixture) => void | Promise<void>,
  source = "1.2.3",
  packageName = "@acme/guard",
  kind: "bundle" | "plugin" = "bundle",
) {
  const fixture = await fixtures();
  const runtime = await createDshRuntime(fixture.root);
  const plan = extensionPlan(source, packageName, kind);
  const adapter = dockerInstallAdapter(runtime, plan, mutate);
  const run = async () =>
    runDsh(
      request({
        workspacePath: fixture.workspace,
        isolation: "docker",
        containerImage: PINNED_NODE_IMAGE,
        extensions: plan,
      }),
      {
        runtime,
        assetsDirectory: fixture.assets,
        startProxy: () => Promise.resolve(fakeProxy()),
        executeProcess: adapter.executeProcess,
      },
    );
  return { run, runtime, adapter };
}

describe("runDsh installation", () => {
  it("audits a registry Bundle before launch, then reuses its immutable installation", async () => {
    const fixture = await installationFixture();
    try {
      const first = await fixture.run();
      const second = await fixture.run();
      expect(first.extensionAudit?.runtimeLock?.digest).toHaveLength(64);
      expect(second.extensionAudit).toEqual(first.extensionAudit);
      expect(fixture.adapter.workerLaunches).toBe(2);
      expect(fixture.adapter.calls.filter((spec) => spec.args.includes("ci"))).toHaveLength(1);
      expect(fixture.adapter.calls.filter((spec) => spec.args.includes("install"))).toHaveLength(1);
    } finally {
      await disposeDshRuntime(fixture.runtime);
    }
  });

  it.each([
    {
      name: "package identity",
      message: /identity mismatch/u,
      mutate: ({ manifest }: InstalledFixture) => {
        manifest.name = "@acme/impostor";
        return Promise.resolve();
      },
    },
    {
      name: "registry version",
      message: /expected 1.2.3/u,
      mutate: ({ manifest }: InstalledFixture) => {
        manifest.version = "9.9.9";
        return Promise.resolve();
      },
    },
    {
      name: "missing Bundle patch",
      message: /has no dsh.bundle.patch/u,
      mutate: ({ manifest }: InstalledFixture) => {
        manifest.dsh = {};
        return Promise.resolve();
      },
    },
    {
      name: "escaping Bundle patch",
      message: /patch escapes/u,
      mutate: async ({ manifest, packageDirectory }: InstalledFixture) => {
        manifest.dsh = { bundle: { patch: "../outside.patch.yml" } };
        await writeFile(join(packageDirectory, "..", "outside.patch.yml"), "[]\n");
      },
    },
    {
      name: "replaced runtime package",
      message: /changed runtime package/u,
      mutate: async ({ runtime }: InstalledFixture) => {
        await writeFile(
          join(runtime.packageRoot, "node_modules", "runtime-fixture", "package.json"),
          JSON.stringify({ name: "runtime-fixture", version: "2.0.0" }),
        );
      },
    },
    {
      name: "modified Controller lock",
      message: /changed Controller package-lock entry/u,
      mutate: ({ lock }: InstalledFixture) => {
        fixtureObject(fixtureObject(lock.packages)["node_modules/zod"]).license = "changed";
        return Promise.resolve();
      },
    },
  ])("rejects $name before any worker starts", async ({ mutate, message }) => {
    const fixture = await installationFixture(mutate);
    try {
      await expect(fixture.run()).rejects.toThrow(message);
      expect(fixture.adapter.workerLaunches).toBe(0);
    } finally {
      await disposeDshRuntime(fixture.runtime);
    }
  });

  it("rejects a direct extension that shadows an installed runtime package before npm install", async () => {
    const fixture = await installationFixture(undefined, "1.2.3", "runtime-fixture");
    try {
      await expect(fixture.run()).rejects.toThrow(/shadow a Controller-owned runtime dependency/u);
      expect(fixture.adapter.calls.some((spec) => spec.args.includes("install"))).toBe(false);
      expect(fixture.adapter.workerLaunches).toBe(0);
    } finally {
      await disposeDshRuntime(fixture.runtime);
    }
  });

  it.each([undefined, "a".repeat(40)])(
    "accepts a git Bundle whose optional gitHead is %s when lock provenance matches",
    async (gitHead) => {
      const fixture = await installationFixture(
        ({ manifest }) => {
          if (gitHead !== undefined) manifest.gitHead = gitHead;
        },
        `git+https://github.com/acme/guard.git#${"a".repeat(40)}`,
      );
      try {
        await expect(fixture.run()).resolves.toMatchObject({
          output: { summary: "Installed safely." },
        });
      } finally {
        await disposeDshRuntime(fixture.runtime);
      }
    },
  );

  it("rejects a git Bundle that reports a different commit before worker execution", async () => {
    const fixture = await installationFixture(
      ({ manifest }) => {
        manifest.gitHead = "b".repeat(40);
      },
      `git+https://github.com/acme/guard.git#${"a".repeat(40)}`,
    );
    try {
      await expect(fixture.run()).rejects.toThrow(/reports a different git commit/u);
      expect(fixture.adapter.workerLaunches).toBe(0);
    } finally {
      await disposeDshRuntime(fixture.runtime);
    }
  });

  it("loads a direct Plugin from its verified entry without requiring Bundle metadata", async () => {
    const fixture = await installationFixture(
      async ({ manifest, packageDirectory }) => {
        delete manifest.dsh;
        manifest.exports = "./index.mjs";
        await writeFile(join(packageDirectory, "index.mjs"), "export default class Plugin {}\n");
      },
      "1.2.3",
      "@acme/guard",
      "plugin",
    );
    try {
      await expect(fixture.run()).resolves.toMatchObject({
        output: { summary: "Installed safely." },
      });
      expect(fixture.runtime.verifiedPluginModuleSpecifiers?.guard).toContain(
        "/node_modules/@acme/guard/index.mjs",
      );
    } finally {
      await disposeDshRuntime(fixture.runtime);
    }
  });

  it("re-audits the lock digest before a reused worker starts", async () => {
    const fixture = await installationFixture();
    try {
      await fixture.run();
      const lockPath = join(fixture.runtime.packageRoot, "package-lock.json");
      const lock = await readFixtureManifest(lockPath);
      fixtureObject(fixtureObject(lock.packages)["node_modules/@acme/guard"]).license = "changed";
      await writeFile(lockPath, JSON.stringify(lock));
      await expect(fixture.run()).rejects.toThrow(/package-lock digest changed/u);
      expect(fixture.adapter.workerLaunches).toBe(1);
    } finally {
      await disposeDshRuntime(fixture.runtime);
    }
  });
  it("prevents extension installation from shadowing the locked runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-runtime-inventory-test-"));
    temporaryPaths.push(root);
    const packageRoot = join(root, "package");
    await mkdir(join(packageRoot, "node_modules", "zod"), { recursive: true });
    await mkdir(join(packageRoot, "node_modules", "@scope", "stable"), { recursive: true });
    await writeFile(
      join(packageRoot, "node_modules", "zod", "package.json"),
      '{"name":"zod","version":"4.4.3"}\n',
    );
    await writeFile(
      join(packageRoot, "node_modules", "@scope", "stable", "package.json"),
      '{"name":"@scope/stable","version":"1.2.3"}\n',
    );
    const baseline = await installedTopLevelPackageInventory(packageRoot);
    expect(baseline).toEqual({ zod: "4.4.3", "@scope/stable": "1.2.3" });
    expect(() =>
      assertExtensionPackagesDoNotShadowRuntime(
        { packageDependencies: { zod: "4.4.3" } },
        baseline,
      ),
    ).toThrow(/shadow a Controller-owned runtime dependency/u);
    expect(() =>
      assertInstalledRuntimeInventoryUnchanged(baseline, {
        zod: "4.5.0",
        "@scope/stable": "1.2.3",
      }),
    ).toThrow(/changed runtime package zod/u);
  });

  it("binds policy patches to the audited DSH version", () => {
    expect(() => assertSupportedDshVersion("0.2.0-rc.2")).not.toThrow();
    expect(() => assertSupportedDshVersion("0.1.7-rc.2")).toThrow(/no audited/u);
    expect(() => assertSupportedDshVersion("0.2.1-alpha.1")).toThrow(/no audited/u);
    expect(() => assertSupportedDshVersion("0.1.1-rc.2")).toThrow();
    expect(() => assertSupportedDshVersion("latest")).toThrow(/exact semver/u);
    expect(() => assertSupportedDshVersion("0.1.0-rc.6")).toThrow(/no audited/u);
  });
});
