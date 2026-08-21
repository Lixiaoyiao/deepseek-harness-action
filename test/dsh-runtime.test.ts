import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  bindDshRuntime,
  createDshRuntime,
  disposeDshRuntime,
  fingerprintDshRuntimeBinding,
  type DshRuntime,
  type DshRuntimeBinding,
} from "../src/dsh/runtime.js";

const EXTENSION_DIGEST = "a".repeat(64);

function binding(overrides: Partial<DshRuntimeBinding> = {}): DshRuntimeBinding {
  return {
    dshVersion: "0.1.0-rc.8",
    containerImage: `docker.io/library/node@sha256:${"1".repeat(64)}`,
    isolation: "docker",
    workspacePath: join(tmpdir(), "dsh-runtime-workspace"),
    chatBaseUrl: "https://api.deepseek.com/",
    extensionConfigurationDigest: EXTENSION_DIGEST,
    nativeRuntimeTools: ["read", "grep", "bash"],
    workspaceWrite: false,
    network: false,
    profileSchemaVersion: 1,
    ...overrides,
  };
}

function runtimeStub(): DshRuntime {
  return {
    root: "runtime-root",
    dshHome: "runtime-home",
    packageRoot: "runtime-package",
    npmCache: "runtime-npm-cache",
  };
}

describe("run-scoped DSH runtime", () => {
  it("creates private runtime, profile, state, and installer-cache directories", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-runtime-test-"));
    const runtime = await createDshRuntime(temporaryRoot);
    try {
      expect(runtime.root.startsWith(temporaryRoot)).toBe(true);
      expect(runtime.dshHome).toBe(join(runtime.root, "home"));
      expect(runtime.packageRoot).toBe(join(runtime.dshHome, "profiles", "github-action"));
      expect(runtime.npmCache).toBe(join(runtime.root, "npm-cache"));
      expect(runtime.npmCache.startsWith(`${runtime.dshHome}/`)).toBe(false);
      expect(runtime).not.toHaveProperty("binding");
      expect(runtime).not.toHaveProperty("installedVersion");
      expect(runtime).not.toHaveProperty("installedExtensionDigest");
      expect(runtime).not.toHaveProperty("installedPackageInventory");
      expect(runtime).not.toHaveProperty("installedPackageLockBaseline");
      expect(runtime).not.toHaveProperty("installedExtensionRuntimeLock");
      expect(runtime).not.toHaveProperty("verifiedPluginModuleSpecifiers");

      const directories = [
        runtime.root,
        runtime.dshHome,
        runtime.packageRoot,
        runtime.npmCache,
        join(runtime.dshHome, "action-state"),
        join(runtime.dshHome, "sessions"),
        join(runtime.dshHome, "attachments"),
      ];
      for (const directory of directories) {
        const details = await stat(directory);
        expect(details.isDirectory()).toBe(true);
        if (process.platform !== "win32") expect(details.mode & 0o777).toBe(0o700);
      }

      await disposeDshRuntime(runtime);
      await expect(stat(runtime.root)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(temporaryRoot, { force: true, recursive: true });
    }
  });

  it("canonicalizes tool order and reuses an identical immutable binding", () => {
    const runtime = runtimeStub();
    const first = bindDshRuntime(runtime, binding());
    const reordered = binding({
      workspacePath: join(tmpdir(), "dsh-runtime-workspace", "."),
      chatBaseUrl: "https://API.DEEPSEEK.COM:443/?ignored=yes#fragment",
      nativeRuntimeTools: ["bash", "read", "grep", "read"],
    });
    const second = bindDshRuntime(runtime, reordered);

    expect(second).toBe(first);
    expect(first.binding.nativeRuntimeTools).toEqual(["bash", "grep", "read"]);
    expect(first.binding.workspacePath).toBe(join(tmpdir(), "dsh-runtime-workspace"));
    expect(first.binding.chatBaseUrl).toBe("https://api.deepseek.com/");
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(fingerprintDshRuntimeBinding(binding())).toBe(fingerprintDshRuntimeBinding(reordered));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.binding)).toBe(true);
    expect(Object.isFrozen(first.binding.nativeRuntimeTools)).toBe(true);
    expect(Object.getOwnPropertyDescriptor(runtime, "binding")).toMatchObject({
      configurable: false,
      enumerable: true,
      writable: false,
    });
  });

  it("rejects every authorization-relevant field change with the field name", () => {
    const changes: readonly [
      keyof DshRuntimeBinding,
      Partial<DshRuntimeBinding>,
      Partial<DshRuntimeBinding>,
    ][] = [
      ["dshVersion", {}, { dshVersion: "0.1.0-rc.9" }],
      ["containerImage", {}, { containerImage: `example.invalid/node@sha256:${"2".repeat(64)}` }],
      [
        "isolation",
        {},
        {
          isolation: "none",
          dshExecutableIdentity: join(tmpdir(), "dsh-runtime-bin.js"),
        },
      ],
      ["workspacePath", {}, { workspacePath: join(tmpdir(), "another-workspace") }],
      ["chatBaseUrl", {}, { chatBaseUrl: "https://chat.example.test/v1" }],
      [
        "webSearchBaseUrl",
        {
          nativeRuntimeTools: ["read", "web_search"],
          webSearchBaseUrl: "https://search.example.test/anthropic/v1",
        },
        {
          nativeRuntimeTools: ["read", "web_search"],
          webSearchBaseUrl: "https://other-search.example.test/anthropic/v1",
        },
      ],
      [
        "dshExecutableIdentity",
        {
          isolation: "none",
          dshExecutableIdentity: join(tmpdir(), "dsh-runtime-bin.js"),
        },
        {
          isolation: "none",
          dshExecutableIdentity: join(tmpdir(), "other-dsh-runtime-bin.js"),
        },
      ],
      ["extensionConfigurationDigest", {}, { extensionConfigurationDigest: "b".repeat(64) }],
      ["nativeRuntimeTools", {}, { nativeRuntimeTools: ["read", "grep"] }],
      ["workspaceWrite", {}, { workspaceWrite: true }],
      ["network", {}, { network: true }],
      ["profileSchemaVersion", {}, { profileSchemaVersion: 2 }],
    ];

    for (const [field, initial, change] of changes) {
      const runtime = runtimeStub();
      bindDshRuntime(runtime, binding(initial));
      expect(() => bindDshRuntime(runtime, binding({ ...initial, ...change }))).toThrow(
        new RegExp(`binding changed:.*${field}`, "u"),
      );
    }
  });

  it("rejects malformed first-use bindings before fixing the runtime", () => {
    const malformed: readonly Partial<DshRuntimeBinding>[] = [
      { dshVersion: "" },
      { containerImage: " " },
      { isolation: "invalid" as DshRuntimeBinding["isolation"] },
      { workspacePath: "relative/workspace" },
      { chatBaseUrl: "http://remote.example.test" },
      { chatBaseUrl: "https://user:password@api.example.test" },
      { webSearchBaseUrl: "https://search.example.test/anthropic/v1" },
      { nativeRuntimeTools: ["read", "web_search"] },
      { isolation: "none" },
      { dshExecutableIdentity: join(tmpdir(), "docker-cannot-use-host-bin.js") },
      { extensionConfigurationDigest: "not-a-digest" },
      { nativeRuntimeTools: "read" as unknown as readonly string[] },
      { nativeRuntimeTools: ["not/a/tool"] },
      { workspaceWrite: "yes" as unknown as boolean },
      { network: 1 as unknown as boolean },
      { profileSchemaVersion: 0 },
    ];

    for (const invalid of malformed) {
      const runtime = runtimeStub();
      expect(() => bindDshRuntime(runtime, binding(invalid))).toThrow(/DSH runtime binding/u);
      expect(runtime).not.toHaveProperty("binding");
    }
  });

  it("rejects a forged existing fingerprint and an unbindable runtime", () => {
    const requested = binding();
    const forged = runtimeStub() as DshRuntime & {
      binding: NonNullable<DshRuntime["binding"]>;
    };
    Object.defineProperty(forged, "binding", {
      value: Object.freeze({ fingerprint: "0".repeat(64), binding: requested }),
      enumerable: true,
    });
    expect(() => bindDshRuntime(forged, requested)).toThrow(/invalid binding fingerprint/u);

    const sealed = Object.preventExtensions(runtimeStub());
    expect(() => bindDshRuntime(sealed, requested)).toThrow(/could not be fixed on first use/u);
  });
});
