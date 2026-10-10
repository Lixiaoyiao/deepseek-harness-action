import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  PrepareDshCompositionOptions,
  PreparedDshComposition,
} from "../src/dsh/composition.js";
import { ControlledComposition } from "../src/dsh/controlled-composition.js";
import { DshConfigurationError } from "../src/dsh/errors.js";
import { createDshRuntime, disposeDshRuntime, runDsh, type DshRuntime } from "../src/dsh/runner.js";
import { PolicyDeniedError } from "../src/errors.js";

const runtimes: DshRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(disposeDshRuntime));
});
const assets = fileURLToPath(new URL("../assets/dsh/", import.meta.url));
const sessionId = "session-11111111-1111-4111-8111-111111111111";
const bindingDigest = "b".repeat(64);

// The ordinary controlled composition supplies its real receipt contract. The
// runner seam also permits an observed inventory, as its existing tests cover.
class ObservedControlledComposition extends ControlledComposition {
  public override async prepare(
    options: PrepareDshCompositionOptions,
  ): Promise<PreparedDshComposition> {
    const prepared = await super.prepare(options);
    return prepared.isolation === "docker"
      ? { ...prepared, observedTools: { collect: () => Promise.resolve(["read"]) } }
      : prepared;
  }
}

async function fixture(rejection: "secret" | "extra-session", enabled = true) {
  const runtime = await createDshRuntime();
  runtimes.push(runtime);
  const workspace = join(runtime.root, "workspace");
  await mkdir(workspace);
  if (enabled) runtime.session = { bindingDigest, knownSecrets: new Set() };
  const close = vi.fn(() => Promise.resolve());
  const execute = vi.fn(async (spec: { args: readonly string[] }) => {
    if (spec.args[0] === "network" && spec.args[1] === "inspect") {
      return { stdout: "172.30.0.1\n", stderr: "", exitCode: 0, signal: null };
    }
    const worker = spec.args.includes("/dsh-home/profiles/github-action/action-launcher.mjs");
    if (!worker) return { stdout: "", stderr: "", exitCode: 0, signal: null };
    const state = join(runtime.dshHome, "action-state");
    await writeFile(
      join(state, "tool-counts.json"),
      JSON.stringify({
        schemaVersion: 1,
        tools: { "workspace.read": 1 },
        groups: { "builtin.workspace": 1 },
      }),
    );
    const receipt = {
      schemaVersion: 1,
      callId: "completed-call",
      id: "workspace.read",
      runtimeName: "read",
      provider: "builtin",
      counted: true,
    };
    await writeFile(
      join(state, "tool-receipts.jsonl"),
      [
        { ...receipt, phase: "started", ok: false, durationMs: 0, code: "ACTION_TOOL_INCOMPLETE" },
        { ...receipt, phase: "completed", ok: true, durationMs: 7 },
      ]
        .map((row) => JSON.stringify(row))
        .join("\n") + "\n",
    );
    if (enabled) {
      await writeFile(
        join(state, "session-admission.json"),
        JSON.stringify({
          schemaVersion: 1,
          bindingDigest,
          sessionId,
          source: "startup",
          workingDirectory: "/workspace",
          permissionMode: "read-only",
          approvalPolicy: "never",
          permissionPreset: "read-only",
          beforeSeq: 0,
          afterSeq: 1,
        }),
      );
      const storage = join(runtime.dshHome, "sessions", "--workspace--", sessionId);
      await mkdir(storage, { recursive: true });
      await writeFile(
        join(storage, "session.v4.jsonl"),
        [
          {
            type: "session",
            version: 4,
            id: sessionId,
            createdAt: 1,
            cwd: "/workspace",
            isSeeded: false,
            delegationDepth: 0,
          },
          {
            type: "fixture/optional",
            seq: 0,
            time: 1,
            data: { arbitrary: rejection === "secret" ? "ephemeral-worker-token" : "safe" },
            ignorable: true,
          },
        ]
          .map((row) => JSON.stringify(row))
          .join("\n") + "\n",
      );
      if (rejection === "extra-session")
        await mkdir(join(runtime.dshHome, "sessions", "--workspace--", "child-session"));
    }
    return {
      stdout: JSON.stringify({
        protocolVersion: 1,
        operation: "review",
        state: "final",
        summary: "Complete",
        findings: [],
      }),
      stderr: "",
      exitCode: 0,
      signal: null,
    };
  });
  const run = () =>
    runDsh(
      {
        operation: "review",
        prompt: "review context",
        workspacePath: workspace,
        trust: "trusted-read",
        isolation: "docker",
        timeoutMs: 5_000,
        maxOutputBytes: 64 * 1024,
        apiKey: "controller-real-key",
        baseUrl: "https://api.deepseek.com",
        webSearchBaseUrl: "https://api.deepseek.com/anthropic/v1",
        dshVersion: "0.2.0-rc.2",
        containerImage: `node@sha256:${"a".repeat(64)}`,
      },
      {
        runtime,
        assetsDirectory: assets,
        composition: new ObservedControlledComposition(),
        environment: {},
        startProxy: () =>
          Promise.resolve({
            workerBaseUrl: "http://host.docker.internal:3456",
            workerToken: "ephemeral-worker-token",
            boundHost: "0.0.0.0",
            port: 3456,
            close,
          }),
        executeProcess: execute,
      },
    );
  return { run, close, execute };
}

describe("post-worker Session failures retain existing telemetry", () => {
  it.each(["secret", "extra-session"] as const)(
    "retains tool execution evidence after %s raw persistence rejection",
    async (rejection) => {
      const { run, close } = await fixture(rejection);
      let failure: unknown;
      try {
        await run();
      } catch (error: unknown) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DshConfigurationError);
      if (!(failure instanceof DshConfigurationError)) throw failure;
      expect(failure.cause).toBeInstanceOf(PolicyDeniedError);
      expect(failure).toMatchObject({
        telemetry: {
          extensionAudit: { profile: "github-action" },
          observedTools: ["read"],
          toolReceipts: [
            {
              callId: "completed-call",
              id: "workspace.read",
              counted: true,
              completed: true,
              ok: true,
              durationMs: 7,
            },
          ],
        },
      });
      expect(failure.message).not.toContain("ephemeral-worker-token");
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it("keeps the default-off path independent of Session persistence", async () => {
    const { run } = await fixture("secret", false);
    const result = await run();
    expect(result.output.state).toBe("final");
    expect(result.observedTools).toEqual(["read"]);
    expect(result.toolReceipts?.[0]).toMatchObject({ callId: "completed-call", completed: true });
  });
});
