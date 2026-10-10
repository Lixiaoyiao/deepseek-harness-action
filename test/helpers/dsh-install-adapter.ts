import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EffectiveExtensionPlan } from "../../src/extensions/plan.js";
import type { DshRuntime } from "../../src/dsh/runtime.js";
import type { DshProcessSpec } from "../../src/dsh/runner.js";
import { CONTAINER_LAUNCHER, networkInspectResult } from "./dsh-runner-fixtures.js";
import { fixtureObject, readFixtureManifest } from "./json-fixture.js";

export interface InstalledFixture {
  readonly manifest: Record<string, unknown>;
  readonly packageDirectory: string;
  readonly lock: Record<string, unknown>;
  readonly runtime: DshRuntime;
}

/** Filesystem-backed npm/Docker adapter; admission, installation audits and reuse are real. */
export function dockerInstallAdapter(
  runtime: DshRuntime,
  plan: EffectiveExtensionPlan,
  mutate?: (fixture: InstalledFixture) => void | Promise<void>,
) {
  const calls: DshProcessSpec[] = [];
  let workerLaunches = 0;
  const executeProcess = async (spec: DshProcessSpec) => {
    calls.push(spec);
    if (spec.args.includes("npm") && spec.args.includes("ci")) {
      const directory = join(runtime.packageRoot, "node_modules", "runtime-fixture");
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: "runtime-fixture", version: "1.0.0" }),
      );
    } else if (spec.args.includes("npm") && spec.args.includes("install")) {
      const extension = plan.bundles[0] ?? plan.plugins[0];
      if (extension === undefined) throw new Error("Missing fixture extension");
      const packageDirectory = join(
        runtime.packageRoot,
        "node_modules",
        ...extension.definition.package.split("/"),
      );
      await mkdir(packageDirectory, { recursive: true });
      const manifest: Record<string, unknown> = {
        name: extension.definition.package,
        version: "1.2.3",
        dsh: { bundle: { patch: "cordis.patch.yml" } },
      };
      await writeFile(join(packageDirectory, "cordis.patch.yml"), "[]\n");
      const lock = await readFixtureManifest(join(runtime.packageRoot, "package-lock.json"));
      const packages = fixtureObject(lock.packages);
      const root = fixtureObject(packages[""]);
      root.name = "dsh-profile-github-action";
      root.dependencies = { ...fixtureObject(root.dependencies), ...plan.packageDependencies };
      lock.name = root.name;
      packages[`node_modules/${extension.definition.package}`] = {
        version: "1.2.3",
        resolved: extension.definition.source.startsWith("git+")
          ? extension.definition.source
          : `https://registry.npmjs.org/${extension.definition.package}/-/guard-1.2.3.tgz`,
        ...(extension.definition.source.startsWith("git+")
          ? {}
          : {
              integrity: `sha512-${createHash("sha512").update("extension fixture").digest("base64")}`,
            }),
      };
      await mutate?.({ manifest, packageDirectory, lock, runtime });
      await writeFile(join(packageDirectory, "package.json"), JSON.stringify(manifest));
      await writeFile(join(runtime.packageRoot, "package-lock.json"), JSON.stringify(lock));
    } else if (spec.args.includes(CONTAINER_LAUNCHER)) {
      workerLaunches += 1;
      return {
        stdout: JSON.stringify({
          protocolVersion: 1,
          operation: "review",
          state: "final",
          summary: "Installed safely.",
          findings: [],
        }),
        stderr: "",
        exitCode: 0,
        signal: null,
      };
    }
    return networkInspectResult(spec) ?? { stdout: "", stderr: "", exitCode: 0, signal: null };
  };
  return {
    calls,
    executeProcess,
    get workerLaunches() {
      return workerLaunches;
    },
  };
}
