import { describe, expect, it } from "vitest";

import { canDeleteRepository } from "./fixtures/access-policy.js";

describe("E2E access policy fixture", () => {
  it("allows administrators and owners to delete a repository", () => {
    expect(canDeleteRepository("admin")).toBe(true);
    expect(canDeleteRepository("owner")).toBe(true);
  });

  it("denies repository deletion to viewers", () => {
    expect(canDeleteRepository("viewer")).toBe(false);
  });
});
