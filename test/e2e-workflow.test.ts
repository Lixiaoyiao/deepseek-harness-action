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
      '.error.category == "domain"',
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

  it("exercises v0.6 GitHub integration through deterministic exact-DSH runs", () => {
    const integration = stepBlock(
      workflow,
      "Exercise routes, filters, structured output, and typed GitHub tools",
    );

    for (const contract of [
      "INPUT_LABEL-TRIGGER=dsh-e2e-label",
      "INPUT_ASSIGNEE-TRIGGER=dsh-e2e-assignee",
      "INPUT_ALLOWED-ACTORS=dsh-e2e-no-match",
      "INPUT_TRIGGER-PHRASE=/deepseek",
      "INPUT_EXCLUDE-COMMENTS-BY-ACTOR=github-actions[bot]",
      'INPUT_ALLOWED-TOOLS=[\"workspace.edit\",\"github.comment.create\"]',
      'INPUT_ALLOWED-TOOLS=[\"github.checks.read\"]',
      '.validation.status == "passed"',
      '.taskOutput == {route:"github",accepted:true}',
      "DSH_E2E_HISTORY_HIDDEN_",
      "DSH_E2E_TRIGGER_VISIBLE_",
      "[image removed]",
    ]) {
      expect(integration).toContain(contract);
    }
    expect(integration).not.toContain("secrets.DEEPSEEK_API_KEY");
  });

  it("cleans only the identity-verified integration Issue, draft PR, and ref", () => {
    const cleanup = stepBlock(workflow, "Remove only verified integration fixtures");

    expect(cleanup).toContain("if: always()");
    expect(cleanup).toContain("dsh-e2e:github-integration:v1");
    expect(cleanup).toContain("^dsh-e2e/checks-");
    expect(cleanup).toContain("(.head.repo.full_name | ascii_downcase) == $repo");
    expect(cleanup).toContain(
      'gh api --method DELETE "repos/$REPOSITORY/git/refs/heads/$CHECKS_BRANCH"',
    );
    expect(cleanup).not.toContain("matching-refs");
  });
});
