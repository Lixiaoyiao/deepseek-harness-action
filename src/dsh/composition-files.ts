import { copyFile, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";

import type { DshDockerMount } from "./composition.js";
import { DshConfigurationError } from "./errors.js";
import type { DshRuntime } from "./runtime.js";

export async function assertDshFile(path: string, description: string): Promise<void> {
  const metadata = await stat(path).catch((error: unknown) => {
    throw new DshConfigurationError(`${description} does not exist`, { cause: error });
  });
  if (!metadata.isFile()) throw new DshConfigurationError(`${description} is not a file`);
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readDshManifest(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isJsonObject(value))
    throw new DshConfigurationError("DSH runtime manifest must be an object");
  return value;
}

/** Stage identical launcher/Session mechanics without merging composition policy. */
export async function prepareCompositionLauncher(options: {
  readonly runtime: DshRuntime;
  readonly assetsDirectory: string;
  readonly launcherPath: string;
  readonly containerLauncher: string;
  readonly task: string;
}): Promise<{ readonly args: readonly string[]; readonly mounts: readonly DshDockerMount[] }> {
  await assertDshFile(options.launcherPath, "DSH Action launcher");
  await copyFile(
    options.launcherPath,
    join(options.runtime.packageRoot, basename(options.containerLauncher)),
  );
  const sessionEnabled = options.runtime.session !== undefined;
  if (sessionEnabled) {
    const sessionSource = join(options.assetsDirectory, "action-session.mjs");
    await assertDshFile(sessionSource, "DSH Session launcher");
    await copyFile(sessionSource, join(options.runtime.packageRoot, "action-session.mjs"));
  }
  return {
    args: [
      "--expose-internals",
      options.containerLauncher,
      options.task,
      ...(sessionEnabled ? ["--action-session"] : []),
    ],
    mounts: sessionEnabled
      ? [
          {
            sourcePath: join(options.runtime.dshHome, "action-state", "session-plan.json"),
            destinationPath: "/dsh-home/action-state/session-plan.json",
            readOnly: true,
          },
        ]
      : [],
  };
}
