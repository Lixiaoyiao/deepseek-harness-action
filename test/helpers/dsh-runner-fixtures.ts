import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

import type { DshProcessResult, DshProcessSpec, DshRunRequest } from "../../src/dsh/runner.js";
import type { DeepSeekProxyHandle } from "../../src/dsh/proxy.js";

export const PINNED_NODE_IMAGE = `node@sha256:${"a".repeat(64)}`;
export const CONTAINER_PACKAGE_ROOT = "/opt/dsh-action/package";
export const CONTAINER_LAUNCHER = "/dsh-home/profiles/github-action/action-launcher.mjs";
export const CONTAINER_NATIVE_LAUNCHER = "/dsh-home/profiles/github-action/native-launcher.mjs";

/** Per-suite disposable filesystem adapter; the real DSH runner remains under test. */
export function createDshFixtureManager() {
  const temporaryPaths: string[] = [];
  const fixtures = async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-runner-test-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    const assets = join(root, "assets");
    await mkdir(workspace);
    await mkdir(assets);
    for (const patch of ["strict-untrusted", "trusted-read", "trusted-write"]) {
      await writeFile(join(assets, `${patch}.patch.yml`), "[]\n");
    }
    await writeFile(join(assets, "action-policy.mjs"), "export default class ActionPolicy {}\n");
    await writeFile(
      join(assets, "action-workspace.mjs"),
      "export default class ActionWorkspace {}\n",
    );
    await writeFile(
      join(assets, "action-launcher.mjs"),
      "export default async function main() {}\n",
    );
    await writeFile(
      join(assets, "native-launcher.mjs"),
      "export default async function main() {}\n",
    );
    const executable = join(root, "bin.js");
    await writeFile(executable, "");
    return { root, workspace, assets, executable };
  };
  const dispose = async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryPaths.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
    );
  };
  return { fixtures, temporaryPaths, dispose };
}

export function request(overrides: Partial<DshRunRequest>): DshRunRequest {
  return {
    operation: "review",
    prompt: "review packet",
    trust: "trusted-read",
    isolation: "none",
    timeoutMs: 5_000,
    maxOutputBytes: 64 * 1024,
    apiKey: "controller-real-key",
    baseUrl: "https://api.deepseek.com",
    webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
    dshVersion: "0.2.0-rc.2",
    containerImage: "node:24-bookworm",
    ...overrides,
  };
}

export function fakeProxy(): DeepSeekProxyHandle & {
  readonly closeMock: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn(() => Promise.resolve());
  return {
    workerBaseUrl: "http://127.0.0.1:3456",
    workerToken: "ephemeral-worker-token",
    boundHost: "127.0.0.1",
    port: 3456,
    close: closeMock,
    closeMock,
  };
}

export function networkInspectResult(spec: DshProcessSpec): DshProcessResult | undefined {
  return spec.args[1] === "inspect"
    ? { stdout: "172.30.0.1\n", stderr: "", exitCode: 0, signal: null }
    : undefined;
}

export function actionStateDirectory(spec: DshProcessSpec): string {
  const suffix = ":/dsh-home/action-state:rw";
  const mount = spec.args.find((argument) => argument.endsWith(suffix));
  if (mount === undefined) throw new Error("missing action-state mount");
  return mount.slice(0, -suffix.length);
}
