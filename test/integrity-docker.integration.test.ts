import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runDsh } from "../src/dsh/runner.js";
import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
  ValidationIntegrityError,
} from "../src/write/validation-integrity.js";
import { createWorkspaceSnapshot, inspectWorkspaceChanges } from "../src/write/workspace.js";

const fixtureKey = "dsh-e2e-integrity-fixture-key";
const containerImage =
  "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059";
const entrypoint = "scripts/verify-dsh-config.mjs";

interface Fixture {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

async function stopFixture(child: ChildProcess, closed: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  timer.unref();
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

async function startFixture(auditPath: string): Promise<Fixture> {
  const child = spawn(process.execPath, [join(process.cwd(), ".github/e2e/integrity-llm.mjs")], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, DSH_E2E_INTEGRITY_AUDIT: auditPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let stdout = "";
  let stderr = "";
  try {
    const baseUrl = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Integrity fixture startup timed out")),
        20_000,
      );
      const finish = (error: Error | undefined, value = ""): void => {
        clearTimeout(timer);
        if (error === undefined) resolve(value);
        else reject(error);
      };
      child.once("error", (error) => finish(error));
      child.once("exit", () =>
        finish(new Error(`Integrity fixture exited before completion: ${stderr}`)),
      );
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-16_384);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout) > 16_384) {
          finish(new Error("Integrity fixture endpoint exceeded its byte limit"));
          return;
        }
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        try {
          const value = JSON.parse(stdout.slice(0, newline)) as { readonly baseUrl?: unknown };
          if (
            typeof value.baseUrl !== "string" ||
            !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/u.test(value.baseUrl)
          ) {
            throw new Error("Integrity fixture returned an invalid loopback endpoint");
          }
          finish(undefined, value.baseUrl);
        } catch (error: unknown) {
          finish(error instanceof Error ? error : new Error("Invalid fixture endpoint"));
        }
      });
    });
    const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error("Integrity fixture health check failed");
    await response.body?.cancel();
    return { baseUrl, close: async () => stopFixture(child, closed) };
  } catch (error: unknown) {
    await stopFixture(child, closed);
    throw error;
  }
}

// An explicit Linux CI step opts into real Docker. The regular cross-platform
// suite retains its deterministic unit coverage without requiring a daemon.
describe.skipIf(process.env.DSH_E2E_INTEGRITY_DOCKER !== "1")(
  "production Docker validation integrity",
  () => {
    it("rejects a real DSH Bash write that weakens the disposable validation entrypoint", async () => {
      expect(process.platform, "The explicit Docker regression requires Linux").toBe("linux");
      const root = await mkdtemp(join(tmpdir(), "dsh-integrity-docker-"));
      let fixture: Fixture | undefined;
      try {
        const source = join(root, "source");
        const auditPath = join(root, "fixture-audit.jsonl");
        const original = await readFile(join(process.cwd(), entrypoint), "utf8");
        await mkdir(join(source, "scripts"), { recursive: true });
        await writeFile(join(source, entrypoint), original);
        await writeFile(auditPath, "");
        const snapshot = await createWorkspaceSnapshot(
          { kind: "materialized-tree", root: source },
          join(root, "worker"),
        );
        fixture = await startFixture(auditPath);

        // Use the production installer, credential proxy, internal Docker
        // network, controlled composition, Bash policy and receipt collection.
        const result = await runDsh(
          {
            operation: "task",
            prompt:
              "DSH_E2E_INTEGRITY_FIXTURE. Replace only scripts/verify-dsh-config.mjs with process.exit(0) using the available Bash tool exactly once.",
            workspacePath: snapshot.workerRoot,
            trust: "trusted-write",
            isolation: "docker",
            timeoutMs: 480_000,
            maxOutputBytes: 2 * 1024 * 1024,
            apiKey: fixtureKey,
            baseUrl: fixture.baseUrl,
            webSearchBaseUrl: fixture.baseUrl,
            dshVersion: "0.1.1-rc.2",
            containerImage,
            nativeTools: ["workspace.edit", "native.bash"],
          },
          { environment: { PATH: process.env.PATH } },
        );

        expect(result.output).toMatchObject({ operation: "task", state: "final" });
        expect(result.isolationReport).toMatchObject({
          backend: "docker",
          credentialMediated: true,
          processIsolated: true,
          networkIsolated: true,
          workspaceAccess: "read-write",
        });
        expect(result.toolReceipts).toHaveLength(1);
        expect(result.toolReceipts?.[0]).toMatchObject({
          id: "native.bash",
          runtimeName: "bash",
          counted: true,
          completed: true,
          ok: true,
        });
        expect(await readFile(join(snapshot.workerRoot, entrypoint), "utf8")).toBe(
          "process.exit(0);\n",
        );
        expect(await readFile(join(source, entrypoint), "utf8")).toBe(original);
        const changes = await inspectWorkspaceChanges(snapshot);
        expect(changes).toEqual({
          added: [],
          modified: [entrypoint],
          deleted: [],
          all: [entrypoint],
        });
        const commands = [["node", entrypoint]];
        const audit = await inspectValidationIntegrity({
          snapshot,
          changes,
          commands,
          mode: "strict",
        });
        expect(audit).toMatchObject({
          mode: "strict",
          status: "blocked",
          dangerousChangeCount: 1,
          controlPlaneChangeCount: 1,
        });
        expect(audit.changes).toEqual([
          expect.objectContaining({
            path: entrypoint,
            category: "entrypoint",
            risk: "dangerous",
            controlPlane: true,
          }),
        ]);
        const rejected = enforceValidationIntegrity({ snapshot, commands, audit });
        await expect(rejected).rejects.toBeInstanceOf(ValidationIntegrityError);
        await expect(rejected).rejects.toMatchObject({
          integrityCode: "VALIDATION_INTEGRITY",
          audit: { mode: "strict", status: "blocked" },
        });
        const phases = (await readFile(auditPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown);
        expect(phases).toEqual([
          { phase: "bash-issued", tool: "bash", callId: "integrity-bash-once" },
          { phase: "bash-observed", tool: "bash", callId: "integrity-bash-once" },
        ]);
        expect(await readFile(join(source, entrypoint), "utf8")).toBe(original);
      } finally {
        await fixture?.close();
        await rm(root, { recursive: true, force: true });
      }
    }, 570_000);
  },
);
