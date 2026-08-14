import { describe, expect, it } from "vitest";

import { canDeployProduction } from "./fixtures/deployment-policy.js";

describe("E2E deployment policy fixture", () => {
  it("allows administrators and maintainers to deploy to production", () => {
    expect(canDeployProduction("admin")).toBe(true);
    expect(canDeployProduction("maintainer")).toBe(true);
  });

  it("denies production deployment to viewers", () => {
    expect(canDeployProduction("viewer")).toBe(false);
  });
});
