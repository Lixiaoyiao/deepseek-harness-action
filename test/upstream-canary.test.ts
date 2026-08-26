import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { DSH_VERSION } from "../src/release.js";

describe("DSH upstream compatibility canary", () => {
  it("is advisory, non-release-gating, and leaves production pins unchanged", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/dsh-upstream-canary.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toMatch(/^\s+(?:pull_request|push|release):/mu);
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain(`AUDITED_DSH_VERSION: ${DSH_VERSION}`);
    expect(workflow).toContain('npm view "@deepseek-ai/dsh" versions --json');
    expect(workflow).not.toContain("|| printf '[]'");
    expect(workflow).toContain("versions.indexOf(process.env.AUDITED_DSH_VERSION)");
    expect(workflow).toContain("The audited DSH version is absent");
    expect(workflow).toContain("--no-save --package-lock=false");
    expect(workflow).toContain("test/dsh-composition.test.ts");
    expect(workflow).toContain("test/native-ecosystem.integration.test.ts");
    expect(workflow).toContain(
      "git diff --exit-code -- package.json package-lock.json src/release.ts action.yml",
    );
    expect(workflow).toContain("::warning::The next DSH candidate failed");
    expect(workflow).toContain(`Production remains pinned and supported only at ${DSH_VERSION}`);
    expect(workflow).not.toContain("git commit");
    expect(workflow).not.toContain("git push");
  });
});
