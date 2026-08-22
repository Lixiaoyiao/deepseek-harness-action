import { copyFile, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { EffectiveExtensionPlan } from "../extensions/plan.js";
import {
  assertExtensionPackagesAbsentFromRuntimeLock,
  auditExtensionRuntimeLock,
  snapshotRuntimeLock,
} from "../extensions/runtime-lock.js";
import { DshConfigurationError } from "./errors.js";
import type { DshRuntime } from "./runtime.js";

export async function prepareLockedRuntimeFiles(
  runtime: DshRuntime,
  version: string,
  actionRoot: string,
): Promise<Record<string, unknown>> {
  const manifestSource = join(actionRoot, "package.json");
  const lockSource = join(actionRoot, "package-lock.json");
  const manifest = JSON.parse(await readFile(manifestSource, "utf8")) as Record<string, unknown>;
  const lock = JSON.parse(await readFile(lockSource, "utf8")) as {
    readonly packages?: Readonly<Record<string, { readonly version?: string }>>;
  };
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/u.test(path)) continue;
    if (entry.version !== version) {
      throw new DshConfigurationError(
        `DSH lockfile drift at ${path}: expected ${version}, found ${entry.version ?? "unknown"}`,
      );
    }
  }
  await copyFile(manifestSource, join(runtime.packageRoot, "package.json"));
  await copyFile(lockSource, join(runtime.packageRoot, "package-lock.json"));
  return manifest;
}

function insideDirectory(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function verifyInstalledExtensions(
  packageRoot: string,
  plan: EffectiveExtensionPlan,
): Promise<void> {
  const installed = [
    ...plan.bundles.map((extension) => ({ extension, bundle: true })),
    ...plan.plugins.map((extension) => ({ extension, bundle: false })),
  ];
  for (const { extension, bundle } of installed) {
    const packageDirectory = join(
      packageRoot,
      "node_modules",
      ...extension.definition.package.split("/"),
    );
    const packageReal = await realpath(packageDirectory);
    const manifestPath = join(packageReal, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      readonly name?: string;
      readonly version?: string;
      readonly gitHead?: string;
      readonly dsh?: { readonly bundle?: { readonly patch?: string } };
    };
    if (manifest.name !== extension.definition.package) {
      throw new DshConfigurationError(
        `Installed extension package identity mismatch: ${extension.definition.id}`,
      );
    }
    const source = extension.definition.source;
    if (/^\d/u.test(source) && manifest.version !== source) {
      throw new DshConfigurationError(
        `Installed extension ${extension.definition.package} is ${manifest.version ?? "unknown"}, expected ${source}`,
      );
    }
    // npm does not guarantee that a git install rewrites package.json with
    // gitHead. The package-lock resolved URL is verified against the approved
    // 40-character commit immediately after this identity/manifest check.
    if (
      source.startsWith("git+") &&
      manifest.gitHead !== undefined &&
      manifest.gitHead !== source.slice(source.lastIndexOf("#") + 1)
    ) {
      throw new DshConfigurationError(
        `Installed extension ${extension.definition.package} reports a different git commit`,
      );
    }
    if (bundle) {
      const patch = manifest.dsh?.bundle?.patch;
      if (typeof patch !== "string" || patch.trim() === "") {
        throw new DshConfigurationError(
          `Bundle ${extension.definition.package} has no dsh.bundle.patch`,
        );
      }
      const patchReal = await realpath(resolve(packageReal, patch));
      if (!insideDirectory(packageReal, patchReal)) {
        throw new DshConfigurationError(
          `Bundle ${extension.definition.package} patch escapes the installed package`,
        );
      }
    }
  }
}

/** @internal Supply-chain invariant used by the Docker extension installer. */
export async function installedTopLevelPackageInventory(
  packageRoot: string,
): Promise<Readonly<Record<string, string>>> {
  const modulesRoot = join(packageRoot, "node_modules");
  const packagePaths: string[] = [];
  for (const entry of await readdir(modulesRoot, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = join(modulesRoot, entry.name);
    if (entry.name.startsWith("@")) {
      if (!entry.isDirectory()) {
        throw new DshConfigurationError(`Invalid scoped package directory: ${entry.name}`);
      }
      for (const child of await readdir(entryPath, { withFileTypes: true })) {
        if (child.isDirectory() || child.isSymbolicLink()) {
          packagePaths.push(join(entryPath, child.name));
        }
      }
      continue;
    }
    if (entry.isDirectory() || entry.isSymbolicLink()) packagePaths.push(entryPath);
  }

  const inventory: Record<string, string> = {};
  for (const packagePath of packagePaths) {
    const manifest = JSON.parse(await readFile(join(packagePath, "package.json"), "utf8")) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new DshConfigurationError(`Installed package has invalid identity: ${packagePath}`);
    }
    if (inventory[manifest.name] !== undefined) {
      throw new DshConfigurationError(`Duplicate top-level package identity: ${manifest.name}`);
    }
    inventory[manifest.name] = manifest.version;
  }
  return Object.freeze(inventory);
}

/** @internal Reject direct extension identities that collide with the locked runtime. */
export function assertExtensionPackagesDoNotShadowRuntime(
  plan: Pick<EffectiveExtensionPlan, "packageDependencies">,
  inventory: Readonly<Record<string, string>>,
): void {
  const collision = Object.keys(plan.packageDependencies).find(
    (packageName) => inventory[packageName] !== undefined,
  );
  if (collision !== undefined) {
    throw new DshConfigurationError(
      `Extension package ${collision} would shadow a Controller-owned runtime dependency`,
    );
  }
}

/** @internal Verify npm did not replace or remove any pre-existing runtime package. */
export function assertInstalledRuntimeInventoryUnchanged(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): void {
  for (const [packageName, version] of Object.entries(before)) {
    if (after[packageName] !== version) {
      throw new DshConfigurationError(
        `Extension installation changed runtime package ${packageName}: expected ${version}, found ${after[packageName] ?? "missing"}`,
      );
    }
  }
}

/** Capture the Controller-owned inventory before any extension package is installed. */
export async function captureExtensionInstallBaseline(
  runtime: DshRuntime,
  plan: EffectiveExtensionPlan,
): Promise<void> {
  if (Object.keys(plan.packageDependencies).length === 0) return;
  runtime.installedPackageInventory = await installedTopLevelPackageInventory(runtime.packageRoot);
  runtime.installedPackageLockBaseline = snapshotRuntimeLock(
    await readFile(join(runtime.packageRoot, "package-lock.json"), "utf8"),
  );
}

/** Validate the pre-install inventory and lock before npm may resolve extensions. */
export function assertExtensionInstallBaseline(
  runtime: DshRuntime,
  plan: EffectiveExtensionPlan,
): void {
  const baseline = runtime.installedPackageInventory;
  const lockBaseline = runtime.installedPackageLockBaseline;
  if (baseline === undefined || lockBaseline === undefined) {
    throw new DshConfigurationError(
      "Extension installation requires a Controller-owned runtime package and lock inventory",
    );
  }
  assertExtensionPackagesDoNotShadowRuntime(plan, baseline);
  assertExtensionPackagesAbsentFromRuntimeLock(lockBaseline, plan.packageDependencies);
}

/** Verify post-install package identity, inventory preservation, and lock provenance. */
export async function auditFreshExtensionInstallation(
  runtime: DshRuntime,
  plan: EffectiveExtensionPlan,
): Promise<void> {
  const baseline = runtime.installedPackageInventory;
  const lockBaseline = runtime.installedPackageLockBaseline;
  if (baseline === undefined || lockBaseline === undefined) {
    throw new DshConfigurationError(
      "Extension installation requires a Controller-owned runtime package and lock inventory",
    );
  }
  assertInstalledRuntimeInventoryUnchanged(
    baseline,
    await installedTopLevelPackageInventory(runtime.packageRoot),
  );
  await verifyInstalledExtensions(runtime.packageRoot, plan);
  runtime.installedExtensionRuntimeLock = auditExtensionRuntimeLock({
    lockText: await readFile(join(runtime.packageRoot, "package-lock.json"), "utf8"),
    baseline: lockBaseline,
    extensionDependencies: plan.packageDependencies,
    expectedRootName: "dsh-profile-github-action",
  });
}

/** Re-audit a reused extension lock before another worker receives it. */
export async function auditReusedExtensionInstallation(
  runtime: DshRuntime,
  plan: EffectiveExtensionPlan,
): Promise<void> {
  const lockBaseline = runtime.installedPackageLockBaseline;
  const installedLock = runtime.installedExtensionRuntimeLock;
  if (lockBaseline === undefined || installedLock === undefined) {
    throw new DshConfigurationError(
      "Reused extension runtime has no Controller-verified package-lock audit",
    );
  }
  const currentLock = auditExtensionRuntimeLock({
    lockText: await readFile(join(runtime.packageRoot, "package-lock.json"), "utf8"),
    baseline: lockBaseline,
    extensionDependencies: plan.packageDependencies,
    expectedRootName: "dsh-profile-github-action",
  });
  if (currentLock.digest !== installedLock.digest) {
    throw new DshConfigurationError("Reused extension runtime package-lock digest changed");
  }
}
