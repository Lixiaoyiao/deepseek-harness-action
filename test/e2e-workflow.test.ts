import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

function stepBlock(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing E2E workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

describe("trusted core E2E workflow", () => {
  let workflow: string;

  beforeAll(async () => {
    workflow = await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8");
  });

  it("keeps the integrity golden path on one minimal trusted-write turn", () => {
    const integrity = stepBlock(workflow, "Validation Integrity blocks weakened entrypoint");

    expect(integrity).toContain("permission-profile: custom");
    expect(integrity).toContain(`allowed-tools: '["workspace.edit","native.bash"]'`);
    expect(integrity).toContain('max-turns: "1"');
    expect(integrity).not.toContain("permission-profile: standard");
  });

  it("requires an authoritative blocked integrity result without a write envelope", () => {
    const assertion = stepBlock(workflow, "Assert integrity failure");

    for (const contract of [
      '.error.code == "VALIDATION_INTEGRITY"',
      '.error.phase == "validation"',
      ".error.retryable == false",
      '.validation.integrity.mode == "strict"',
      '.validation.integrity.status == "blocked"',
      ".validation.integrity.dangerousChangeCount >= 1",
      ".validation.integrity.controlPlaneChangeCount >= 1",
      '.path == "scripts/verify-dsh-config.mjs"',
      '.change == "modified"',
      '.category == "entrypoint"',
      '.risk == "dangerous"',
      'contains("no-op")',
      '(has("write") | not)',
    ]) {
      expect(assertion).toContain(contract);
    }
  });

  it("checks remote mutation state even after a semantic assertion failure", () => {
    const mutation = stepBlock(workflow, "Assert expected failures made no GitHub mutation");

    expect(mutation).toMatch(
      /Assert expected failures made no GitHub mutation\n\s+if: always\(\)\n/u,
    );
    expect(mutation).toContain("for component in main candidate prs comments task-refs task-prs");
  });

  it("does not warn about cleanup when the trusted-write step never ran", () => {
    const cleanup = stepBlock(workflow, "Close only the verified E2E PR and delete its branch");

    expect(cleanup).toContain("if: ${{ always() && steps.trusted.outcome != 'skipped' }}");
    expect(cleanup).toContain("No broad cleanup was attempted.");
  });
});
