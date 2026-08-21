import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { createDshRuntime, disposeDshRuntime } from "../src/dsh/runner.js";
import type { EffectiveExtensionPlan } from "../src/extensions/plan.js";
import { prepareControlledProfile } from "../src/extensions/profile.js";
import {
  assertExtensionPackagesAbsentFromRuntimeLock,
  auditExtensionRuntimeLock,
  snapshotRuntimeLock,
} from "../src/extensions/runtime-lock.js";

type LockPackage = Record<string, unknown>;

interface LockFixture extends Record<string, unknown> {
  name: string;
  version: string;
  lockfileVersion: 3;
  requires: true;
  packages: Record<string, LockPackage>;
}

const integrity = (value: string): string =>
  `sha512-${createHash("sha512").update(value, "utf8").digest("base64")}`;
const INTEGRITY_A = integrity("runtime");
const INTEGRITY_B = integrity("extension");
const INTEGRITY_C = integrity("transitive");

function packageEntry(lock: LockFixture, path: string): LockPackage {
  const entry = lock.packages[path];
  if (entry === undefined) throw new Error(`Missing fixture package: ${path}`);
  return entry;
}

function baselineLock(): LockFixture {
  return {
    name: "deepseek-harness-action",
    version: "0.4.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": {
        name: "deepseek-harness-action",
        version: "0.4.0",
        license: "MIT",
        dependencies: { runtime: "1.0.0" },
        devDependencies: { test: "2.0.0" },
        engines: { node: ">=24" },
      },
      "node_modules/runtime": {
        version: "1.0.0",
        resolved: "https://registry.npmjs.org/runtime/-/runtime-1.0.0.tgz",
        integrity: INTEGRITY_A,
        license: "MIT",
      },
    },
  };
}

function installedRegistryLock(): LockFixture {
  const lock = baselineLock();
  lock.name = "dsh-profile-github-action";
  lock.packages[""] = {
    ...packageEntry(lock, ""),
    name: "dsh-profile-github-action",
    dependencies: { runtime: "1.0.0", "@acme/dsh-lint": "1.2.3" },
  };
  lock.packages["node_modules/@acme/dsh-lint"] = {
    version: "1.2.3",
    resolved: "https://registry.npmjs.org/@acme/dsh-lint/-/dsh-lint-1.2.3.tgz",
    integrity: INTEGRITY_B,
    dependencies: { helper: "3.0.0" },
  };
  lock.packages["node_modules/@acme/dsh-lint/node_modules/helper"] = {
    version: "3.0.0",
    resolved: "https://registry.npmjs.org/helper/-/helper-3.0.0.tgz",
    integrity: INTEGRITY_C,
  };
  return lock;
}

function audit(lock: LockFixture) {
  return auditExtensionRuntimeLock({
    lockText: JSON.stringify(lock),
    baseline: snapshotRuntimeLock(JSON.stringify(baselineLock())),
    extensionDependencies: { "@acme/dsh-lint": "1.2.3" },
    expectedRootName: "dsh-profile-github-action",
  });
}

describe("extension runtime package lock", () => {
  it("installs extensions from the same package root that official Profile loading uses", async () => {
    const runtime = await createDshRuntime();
    const plan: EffectiveExtensionPlan = {
      schemaVersion: 1,
      profileName: "github-action",
      digest: "a".repeat(64),
      configurationDigest: "b".repeat(64),
      network: false,
      mcpServers: [],
      bundles: [],
      plugins: [],
      tools: [],
      manifests: [],
      packageDependencies: { "@acme/dsh-lint": "1.2.3" },
      audit: {
        schemaVersion: 1,
        profile: "github-action",
        digest: "a".repeat(64),
        network: false,
        entries: [],
      },
    };
    try {
      const profile = await prepareControlledProfile({
        dshHome: runtime.dshHome,
        plan,
        workspaceTools: [],
        workspaceWrite: false,
        task: "test",
        workerWorkspacePath: "/workspace",
        policyPluginPath: "/controller/action-policy.mjs",
        workspacePluginPath: "/controller/action-workspace.mjs",
        workerStatePath: "/dsh-home/action-state/tool-counts.json",
        workerAuditPath: "/dsh-home/action-state/tool-receipts.jsonl",
        manifestBase: {
          name: "deepseek-harness-action",
          version: "0.4.0",
          dependencies: { runtime: "1.0.0" },
        },
      });
      const manifest = JSON.parse(await readFile(profile.manifestPath, "utf8")) as {
        readonly dependencies?: Readonly<Record<string, string>>;
      };

      expect(profile.profileDir).toBe(runtime.packageRoot);
      expect(manifest.dependencies).toEqual({
        runtime: "1.0.0",
        "@acme/dsh-lint": "1.2.3",
      });
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("hashes the complete resolved/integrity graph independently of JSON key order", () => {
    const lock = installedRegistryLock();
    const first = audit(lock);
    const reordered: LockFixture = {
      requires: true,
      lockfileVersion: 3,
      version: "0.4.0",
      name: "dsh-profile-github-action",
      packages: Object.fromEntries(Object.entries(lock.packages).reverse()),
    };
    const second = audit(reordered);

    expect(first).toMatchObject({
      schemaVersion: 1,
      algorithm: "sha256",
      lockfileVersion: 3,
      packageCount: 3,
      extensionPackageCount: 2,
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.digest).toBe(first.digest);
  });

  it("rejects any mutation of a Controller baseline lock entry", () => {
    const lock = installedRegistryLock();
    lock.packages["node_modules/runtime"] = {
      ...packageEntry(lock, "node_modules/runtime"),
      integrity: INTEGRITY_B,
    };
    expect(() => audit(lock)).toThrow(/changed Controller package-lock entry/u);
  });

  it("rejects registry transitives without sha512 integrity", () => {
    const lock = installedRegistryLock();
    delete packageEntry(lock, "node_modules/@acme/dsh-lint/node_modules/helper").integrity;
    expect(() => audit(lock)).toThrow(/must include a sha512 integrity/u);
  });

  it.each(["sha512-AAAA", `sha512-${"B".repeat(86)}==`])(
    "rejects short or non-canonical sha512 integrity %s",
    (invalidIntegrity) => {
      const lock = installedRegistryLock();
      packageEntry(lock, "node_modules/@acme/dsh-lint/node_modules/helper").integrity =
        invalidIntegrity;
      expect(() => audit(lock)).toThrow(/must include a sha512 integrity/u);
    },
  );

  it("accepts npm's strict SSH normalization of an exact git+https GitHub commit", () => {
    const commit = "a".repeat(40);
    const source = `git+https://github.com/acme/dsh-plugin.git#${commit}`;
    const npmResolved = `git+ssh://git@github.com/Acme/DSH-Plugin.git#${commit}`;
    const lock = baselineLock();
    lock.name = "dsh-profile-github-action";
    lock.packages[""] = {
      ...packageEntry(lock, ""),
      name: "dsh-profile-github-action",
      dependencies: { runtime: "1.0.0", "@acme/dsh-plugin": source },
    };
    lock.packages["node_modules/@acme/dsh-plugin"] = {
      version: "1.0.0",
      resolved: npmResolved,
      integrity: INTEGRITY_B,
    };
    const baseline = snapshotRuntimeLock(JSON.stringify(baselineLock()));
    expect(
      auditExtensionRuntimeLock({
        lockText: JSON.stringify(lock),
        baseline,
        extensionDependencies: { "@acme/dsh-plugin": source },
        expectedRootName: "dsh-profile-github-action",
      }).digest,
    ).toMatch(/^[0-9a-f]{64}$/u);

    packageEntry(lock, "node_modules/@acme/dsh-plugin").resolved = source;
    expect(
      auditExtensionRuntimeLock({
        lockText: JSON.stringify(lock),
        baseline,
        extensionDependencies: { "@acme/dsh-plugin": source },
        expectedRootName: "dsh-profile-github-action",
      }).digest,
    ).toMatch(/^[0-9a-f]{64}$/u);
  });

  it.each([
    "git+https://github.com/acme/dsh-plugin.git#main",
    `git+ssh://other@github.com/acme/dsh-plugin.git#${"a".repeat(40)}`,
    `git+ssh://git@github.example/acme/dsh-plugin.git#${"a".repeat(40)}`,
    `git+ssh://git@github.com.evil.test/acme/dsh-plugin.git#${"a".repeat(40)}`,
    `git+ssh://git@github.com:22/acme/dsh-plugin.git#${"a".repeat(40)}`,
    `git+ssh://git@github.com/acme/dsh-plugin#${"a".repeat(40)}`,
    `git+ssh://git@github.com/acme/dsh-plugin.git#${"A".repeat(40)}`,
  ])("rejects unsupported or mutable git resolution %s", (resolved) => {
    const commit = "a".repeat(40);
    const source = `git+https://github.com/acme/dsh-plugin.git#${commit}`;
    const lock = baselineLock();
    lock.name = "dsh-profile-github-action";
    lock.packages[""] = {
      ...packageEntry(lock, ""),
      name: "dsh-profile-github-action",
      dependencies: { runtime: "1.0.0", "@acme/dsh-plugin": source },
    };
    lock.packages["node_modules/@acme/dsh-plugin"] = {
      version: "1.0.0",
      resolved,
    };
    expect(() =>
      auditExtensionRuntimeLock({
        lockText: JSON.stringify(lock),
        baseline: snapshotRuntimeLock(JSON.stringify(baselineLock())),
        extensionDependencies: { "@acme/dsh-plugin": source },
        expectedRootName: "dsh-profile-github-action",
      }),
    ).toThrow(/40-character commit/u);
  });

  it.each([
    `git+ssh://git@github.com/acme/dsh-plugin.git#${"b".repeat(40)}`,
    `git+ssh://git@github.com/other/dsh-plugin.git#${"a".repeat(40)}`,
    `git+ssh://git@github.com/acme/other.git#${"a".repeat(40)}`,
  ])("rejects npm SSH normalization to a different identity %s", (resolved) => {
    const source = `git+https://github.com/acme/dsh-plugin.git#${"a".repeat(40)}`;
    const lock = baselineLock();
    lock.name = "dsh-profile-github-action";
    lock.packages[""] = {
      ...packageEntry(lock, ""),
      name: "dsh-profile-github-action",
      dependencies: { runtime: "1.0.0", "@acme/dsh-plugin": source },
    };
    lock.packages["node_modules/@acme/dsh-plugin"] = {
      version: "1.0.0",
      resolved,
    };
    expect(() =>
      auditExtensionRuntimeLock({
        lockText: JSON.stringify(lock),
        baseline: snapshotRuntimeLock(JSON.stringify(baselineLock())),
        extensionDependencies: { "@acme/dsh-plugin": source },
        expectedRootName: "dsh-profile-github-action",
      }),
    ).toThrow(/did not preserve the pinned git source/u);
  });

  it("does not accept npm's SSH normalization as the configured source", () => {
    const commit = "a".repeat(40);
    const sshSource = `git+ssh://git@github.com/acme/dsh-plugin.git#${commit}`;
    const lock = baselineLock();
    lock.name = "dsh-profile-github-action";
    lock.packages[""] = {
      ...packageEntry(lock, ""),
      name: "dsh-profile-github-action",
      dependencies: { runtime: "1.0.0", "@acme/dsh-plugin": sshSource },
    };
    lock.packages["node_modules/@acme/dsh-plugin"] = {
      version: "1.0.0",
      resolved: sshSource,
    };
    expect(() =>
      auditExtensionRuntimeLock({
        lockText: JSON.stringify(lock),
        baseline: snapshotRuntimeLock(JSON.stringify(baselineLock())),
        extensionDependencies: { "@acme/dsh-plugin": sshSource },
        expectedRootName: "dsh-profile-github-action",
      }),
    ).toThrow(/did not preserve the pinned git source/u);
  });

  it("rejects direct packages already represented by a Controller lock path", () => {
    const baseline = snapshotRuntimeLock(JSON.stringify(baselineLock()));
    expect(() =>
      assertExtensionPackagesAbsentFromRuntimeLock(baseline, { runtime: "1.0.0" }),
    ).toThrow(/shadow a Controller-owned package-lock entry/u);
  });

  it("rejects root dependencies not exactly bound to the allowed extension plan", () => {
    const lock = installedRegistryLock();
    lock.packages[""] = {
      ...packageEntry(lock, ""),
      dependencies: {
        runtime: "1.0.0",
        "@acme/dsh-lint": "1.2.3",
        surprise: "9.9.9",
      },
    };
    expect(() => audit(lock)).toThrow(/do not exactly match/u);
  });
});
