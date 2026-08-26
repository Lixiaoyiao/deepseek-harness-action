import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const INVARIANTS = [
  "INV-001 NativeRequiresDocker",
  "INV-002 ExplicitDenyWins",
  "INV-003 ControllerCredentialsNeverEnterWorker",
  "INV-004 GithubMutationRequiresValidation",
  "INV-005 NativeInventoryIsObservedNotGranted",
] as const;

describe("architecture invariant catalog", () => {
  it("keeps a small, stable catalog linked from architecture and security docs", async () => {
    const [catalog, architecture, security] = await Promise.all([
      readFile(new URL("../docs/invariants.md", import.meta.url), "utf8"),
      readFile(new URL("../ARCHITECTURE.md", import.meta.url), "utf8"),
      readFile(new URL("../SECURITY.md", import.meta.url), "utf8"),
    ]);

    for (const invariant of INVARIANTS) {
      const [id] = invariant.split(" ");
      expect(catalog.match(new RegExp(`^## ${invariant}$`, "gmu"))).toHaveLength(1);
      expect(architecture).toContain(id);
    }
    expect(catalog).toContain("six-axis matrix");
    expect(catalog).toContain("without importing a shared");
    expect(security).toContain("docs/invariants.md");
    expect(security).toContain("ARCHITECTURE.md");
  });
});
