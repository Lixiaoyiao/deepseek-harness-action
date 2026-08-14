import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DshConfigurationError } from "../src/dsh/errors.js";
import { runValidationCommandsInDocker } from "../src/write/validate.js";

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
});
