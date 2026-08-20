import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DshConfigurationError } from "../src/dsh/errors.js";
import {
  assertValidationSucceeded,
  runValidationCommandsInDocker,
  ValidationFailureError,
} from "../src/write/validate.js";

describe("trusted-write validation container", () => {
  it("rejects a mutable image before copying a workspace or starting Docker", async () => {
    await expect(
      runValidationCommandsInDocker("path-that-must-not-be-read", [["npm", "test"]], "node:24"),
    ).rejects.toBeInstanceOf(DshConfigurationError);
  });

  it("copies into a nonexistent child of the temporary validation directory", async () => {
    const source = await mkdtemp(join(tmpdir(), "dsh-action-validation-source-"));
    try {
      await writeFile(join(source, "tracked.txt"), "validated\n", "utf8");
      await expect(
        runValidationCommandsInDocker(
          source,
          [],
          "docker.io/library/node:24@sha256:" + "a".repeat(64),
        ),
      ).resolves.toEqual([]);
    } finally {
      await rm(source, { force: true, recursive: true });
    }
  });

  it("excludes ignored root metadata and generated dependencies from validation", async () => {
    const source = await mkdtemp(join(tmpdir(), "dsh-action-validation-source-"));
    try {
      await writeFile(join(source, "tracked.txt"), "validated\n", "utf8");
      await mkdir(join(source, ".git"), { recursive: true });
      await writeFile(join(source, ".git", "config"), "poisoned\n", "utf8");
      await mkdir(join(source, "node_modules", ".bin"), { recursive: true });
      await writeFile(join(source, "node_modules", ".bin", "test"), "poisoned\n", "utf8");
      let inspected = false;
      await expect(
        runValidationCommandsInDocker(
          source,
          [["node", "check.js"]],
          "docker.io/library/node:24@sha256:" + "a".repeat(64),
          30_000,
          async (options) => {
            const mountIndex = options.args.indexOf("--mount");
            const mount = options.args[mountIndex + 1] ?? "";
            const prefix = "type=bind,source=";
            const suffix = ",target=/workspace";
            if (!mount.startsWith(prefix) || !mount.endsWith(suffix)) {
              throw new Error("validation workspace mount is missing");
            }
            const validationRoot = mount.slice(prefix.length, -suffix.length);
            await expect(readFile(join(validationRoot, "tracked.txt"), "utf8")).resolves.toBe(
              "validated\n",
            );
            await expect(
              readFile(join(validationRoot, ".git", "config"), "utf8"),
            ).rejects.toThrow();
            await expect(
              readFile(join(validationRoot, "node_modules", ".bin", "test"), "utf8"),
            ).rejects.toThrow();
            inspected = true;
            return {
              exitCode: 0,
              stdout: "",
              stderr: "",
              timedOut: false,
              outputTruncated: false,
            };
          },
        ),
      ).resolves.toHaveLength(1);
      expect(inspected).toBe(true);
    } finally {
      await rm(source, { force: true, recursive: true });
    }
  });

  it("names, constrains, and force-cleans a timed-out validation container", async () => {
    const source = await mkdtemp(join(tmpdir(), "dsh-action-validation-source-"));
    const calls: { command: string; args: readonly string[] }[] = [];
    try {
      await writeFile(join(source, "tracked.txt"), "validated\n", "utf8");
      const results = await runValidationCommandsInDocker(
        source,
        [["npm", "test"]],
        "docker.io/library/node:24@sha256:" + "a".repeat(64),
        30_000,
        (options) => {
          calls.push({ command: options.command, args: options.args });
          return Promise.resolve({
            exitCode: 1,
            stdout: "",
            stderr: "timeout",
            timedOut: calls.length === 1,
            outputTruncated: false,
          });
        },
      );
      expect(results[0]?.result.timedOut).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.args).toEqual(
        expect.arrayContaining([
          "--init",
          "--name",
          "--pids-limit",
          "256",
          "--memory",
          "2g",
          "--cpus",
          "2",
        ]),
      );
      expect(calls[1]?.args.slice(0, 2)).toEqual(["rm", "--force"]);
    } finally {
      await rm(source, { force: true, recursive: true });
    }
  });

  it("classifies a non-zero command before any controller write", () => {
    let thrown: unknown;
    try {
      assertValidationSucceeded([
        {
          argv: ["npm", "test"],
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "failed",
            timedOut: false,
            outputTruncated: true,
          },
        },
      ]);
    } catch (error: unknown) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ValidationFailureError);
    expect(thrown).toMatchObject({
      code: "VALIDATION_FAILED",
      argv: ["npm", "test"],
      exitCode: 1,
      timedOut: false,
      outputTruncated: true,
    });
    expect((thrown as Error).message).toContain('"npm test" exited with code 1');
  });

  it("reports validation timeouts separately", () => {
    expect(() =>
      assertValidationSucceeded([
        {
          argv: ["npm", "test"],
          result: {
            exitCode: 137,
            stdout: "",
            stderr: "",
            timedOut: true,
            outputTruncated: false,
          },
        },
      ]),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_TIMEOUT", timedOut: true }));
  });
});
