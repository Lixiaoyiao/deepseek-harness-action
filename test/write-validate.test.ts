import { describe, expect, it } from "vitest";

import { DshConfigurationError } from "../src/dsh/errors.js";
import { runValidationCommandsInDocker } from "../src/write/validate.js";

describe("trusted-write validation container", () => {
  it("rejects a mutable image before copying a workspace or starting Docker", async () => {
    await expect(
      runValidationCommandsInDocker("path-that-must-not-be-read", [["npm", "test"]], "node:24"),
    ).rejects.toBeInstanceOf(DshConfigurationError);
  });
});
