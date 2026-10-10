import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { DshAbortedError } from "../src/dsh/errors.js";
import { executeBoundedDshProcess } from "../src/dsh/process.js";

it.runIf(process.platform !== "win32")(
  "settles cancellation after the leader exits while a descendant retains the output pipes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-descendant-test-"));
    const readyPath = join(root, "ready.json");
    const controller = new AbortController();
    let groupPid: number | undefined;
    const execution = executeBoundedDshProcess(
      {
        command: process.execPath,
        args: [
          fileURLToPath(new URL("./fixtures/dsh-ignoring-descendant.mjs", import.meta.url)),
          readyPath,
        ],
        cwd: root,
        env: {},
      },
      {
        timeoutMs: 10_000,
        maxStdoutBytes: 1024,
        maxStderrBytes: 1024,
        maxCombinedBytes: 2048,
        killGraceMs: 50,
        signal: controller.signal,
      },
    ).then(
      () => "completed",
      (error: unknown) => error,
    );
    try {
      await expect
        .poll(
          async () => {
            try {
              const ready: unknown = JSON.parse(await readFile(readyPath, "utf8"));
              if (
                typeof ready !== "object" ||
                ready === null ||
                !("pid" in ready) ||
                typeof ready.pid !== "number"
              ) {
                return false;
              }
              groupPid = ready.pid;
              return true;
            } catch {
              return false;
            }
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      controller.abort();
      const result = await Promise.race([
        execution,
        new Promise<string>((resolve) => setTimeout(() => resolve("did not settle"), 500)),
      ]);
      expect(result).toBeInstanceOf(DshAbortedError);
    } finally {
      controller.abort();
      if (groupPid !== undefined) {
        try {
          process.kill(-groupPid, "SIGKILL");
        } catch {
          /* The process group may already be gone. */
        }
      }
      await execution;
      await rm(root, { recursive: true, force: true });
    }
  },
);
