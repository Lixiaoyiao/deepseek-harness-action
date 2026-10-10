import { describe, expect, it } from "vitest";
import { DshAbortedError, DshOutputLimitError, DshTimeoutError } from "../src/dsh/errors.js";
import { executeBoundedDshProcess } from "../src/dsh/runner.js";
import type { DshProcessLimits, DshProcessSpec } from "../src/dsh/runner.js";

describe("executeBoundedDshProcess", () => {
  const spec = (source: string): DshProcessSpec => ({
    command: process.execPath,
    args: ["--eval", source],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH },
  });
  const limits = (overrides: Partial<DshProcessLimits> = {}): DshProcessLimits => ({
    // A saturated Windows worker can take several seconds just to start a child
    // Node process during the full coverage run. Keep the production timeout
    // behavior covered by the explicit 50 ms case below.
    timeoutMs: 10_000,
    maxStdoutBytes: 1_024,
    maxStderrBytes: 1_024,
    maxCombinedBytes: 2_048,
    killGraceMs: 50,
    ...overrides,
  });

  it("captures stdout and stderr", async () => {
    const result = await executeBoundedDshProcess(
      spec('process.stdout.write("ok"); process.stderr.write("note")'),
      limits(),
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "ok", stderr: "note" });
  });

  it("fails closed on timeout even when a process handles SIGTERM", async () => {
    await expect(
      executeBoundedDshProcess(
        spec('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000)'),
        limits({ timeoutMs: 50 }),
      ),
    ).rejects.toBeInstanceOf(DshTimeoutError);
  }, 15_000);

  it("terminates the process tree when the run is cancelled", async () => {
    const controller = new AbortController();
    const execution = executeBoundedDshProcess(
      spec('process.on("SIGTERM",()=>process.exit(0)); setInterval(()=>{},1000)'),
      limits({ signal: controller.signal }),
    );
    setTimeout(() => controller.abort(), 25);
    await expect(execution).rejects.toBeInstanceOf(DshAbortedError);
  }, 15_000);

  it("kills on stdout and aggregate output caps", async () => {
    await expect(
      executeBoundedDshProcess(
        spec('process.stdout.write("x".repeat(200))'),
        limits({ maxStdoutBytes: 100 }),
      ),
    ).rejects.toBeInstanceOf(DshOutputLimitError);
    await expect(
      executeBoundedDshProcess(
        spec('process.stdout.write("x".repeat(80)); process.stderr.write("y".repeat(80))'),
        limits({ maxCombinedBytes: 100 }),
      ),
    ).rejects.toBeInstanceOf(DshOutputLimitError);
  });
});
