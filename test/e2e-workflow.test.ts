import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

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

  it("parses as YAML and exposes separate pull-request and exact-main qualification modes", () => {
    expect(() => {
      parse(workflow);
    }).not.toThrow();
    const gate = workflow.slice(0, workflow.indexOf("  read_only:"));

    for (const contract of [
      "candidate_mode:",
      "- pull-request",
      "- main",
      "APPROVED_CANDIDATE_SHA: ${{ vars.DSH_E2E_CANDIDATE_SHA }}",
      '[[ "$CANDIDATE_SHA" == "$DISPATCH_SHA" && "$CANDIDATE_SHA" == "$default_sha" ]]',
      'candidate_branch="$DEFAULT_BRANCH"',
    ]) {
      expect(gate).toContain(contract);
    }
    expect(gate).toContain('echo "pull_request=$CANDIDATE_PR" >> "$GITHUB_OUTPUT"');
    expect(workflow).toContain("bash .github/e2e/assert-candidate-binding.sh");
    expect(workflow).toContain('if [[ "$CANDIDATE_MODE" == "pull-request" ]]; then');
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
      "INPUT_EXCLUDE-COMMENTS-BY-ACTOR=$actor,github-actions[bot]",
      "github.issue.labels.set",
      "github.issue.assignees.set",
      "github.issue.state.update",
      "github.comment.create",
      "github.pull.metadata.update",
      'INPUT_ALLOWED-TOOLS=["github.checks.read"]',
      "INPUT_PROMPT=Update the bound draft PR metadata exactly as requested.",
      '.validation.status == "passed"',
      '.taskOutput == {route:"github",accepted:true}',
      "DSH_E2E_HISTORY_HIDDEN_",
      "DSH_E2E_TRIGGER_VISIBLE_",
      "[image removed]",
      "dsh-e2e-reference-must-not-forward",
      "dsh-e2e-source-must-not-forward",
      "dsh-e2e-html-must-not-forward",
      "dsh-e2e-raw-must-not-forward",
    ]) {
      expect(integration).toContain(contract);
    }
    expect(integration.match(/'INPUT_ISOLATION=none'/gu)).toHaveLength(3);
    expect(integration).not.toContain("secrets.DEEPSEEK_API_KEY");
  });

  it("creates an exact one-file fixture commit for main-safe checks coverage", () => {
    const creation = stepBlock(workflow, "Create isolated Issue and draft PR fixtures");

    for (const contract of [
      ".github/dsh-e2e-fixtures/checks-",
      'git/commits/$CANDIDATE_SHA" --jq .tree.sha',
      "base_tree:$base",
      "parents:[$parent]",
      'echo "tree_sha=$tree_sha"',
      'echo "head_sha=$head_sha"',
      '--arg sha "$head_sha"',
    ]) {
      expect(creation).toContain(contract);
    }
    expect(creation).not.toContain('-f sha="$CANDIDATE_SHA" >/dev/null');
  });

  it("asserts generic receipts and verifies typed payload effects through remote state", () => {
    const integration = stepBlock(
      workflow,
      "Exercise routes, filters, structured output, and typed GitHub tools",
    );

    expect(integration).toContain('.id == "github.issue.labels.set"');
    expect(integration).toContain('.id == "github.issue.assignees.set"');
    expect(integration).toContain('.id == "github.issue.state.update"');
    expect(integration).toContain('.id == "github.pull.metadata.update"');
    expect(integration).toContain('.id == "github.checks.read"');
    expect(integration).toContain("[.labels[].name] == [$label]");
    expect(integration).toContain("[.assignees[].login] == [$actor]");
    expect(integration).toContain('.state_reason == "completed"');
    expect(integration).toContain('--jq .head.sha)" == "$CHECKS_HEAD"');
    for (const forbiddenReceiptPayload of [
      ".labels == [$label]",
      ".assignees == [$actor]",
      ".title == $title",
      ".headSha == $head",
    ]) {
      expect(integration).not.toContain(forbiddenReceiptPayload);
    }
  });

  it("cleans partial integration fixtures independently and aggregates failures", () => {
    const cleanup = stepBlock(workflow, "Remove only verified integration fixtures");

    expect(cleanup).toContain("if: always()");
    expect(cleanup).toContain("set +e");
    expect(cleanup).toContain("dsh-e2e:github-integration:v1");
    expect(cleanup).toContain("^dsh-e2e/checks-");
    expect(cleanup).toContain("cleanup_issue() (");
    expect(cleanup).toContain("cleanup_label() (");
    expect(cleanup).toContain("cleanup_pull() (");
    expect(cleanup).toContain("cleanup_branch() (");
    expect(cleanup).toContain("cleanup_failures=$((cleanup_failures + 1))");
    expect(cleanup).toContain('[[ "$cleanup_failures" -eq 0 ]]');
    expect(cleanup).toContain(".parents[0].sha");
    expect(cleanup).toContain(".tree.sha");
    expect(cleanup).toContain(".files | length == 1");
    expect(cleanup).toContain("git/blobs/$blob_sha");
    expect(cleanup).toContain(
      'gh api --method DELETE "repos/$REPOSITORY/git/refs/heads/$CHECKS_BRANCH"',
    );
    expect(cleanup).not.toContain("matching-refs");
  });

  it("keeps the reusable candidate assertion fail-closed in both modes", async () => {
    const assertion = await readFile(
      new URL("../.github/e2e/assert-candidate-binding.sh", import.meta.url),
      "utf8",
    );

    expect(assertion).toContain("pull-request)");
    expect(assertion).toContain('.state == "open" and .draft == false');
    expect(assertion).toContain("main)");
    expect(assertion).toContain('live_sha="$(gh api');
    expect(assertion).toContain('"$live_sha" == "$CANDIDATE_SHA"');
    expect(assertion).not.toContain("matching-refs");
  });

  it("requires complete post-merge Core E2E on the exact release SHA before tagging", async () => {
    const guide = await readFile(new URL("../docs/maintainer-release.md", import.meta.url), "utf8");
    const merge = guide.slice(
      guide.indexOf("## Merge and qualify `main`"),
      guide.indexOf("## Tag and GitHub Release"),
    );

    expect(merge).toContain('gh variable set DSH_E2E_CANDIDATE_SHA --body "$release_sha"');
    expect(merge).toContain("-f candidate_mode=main");
    expect(merge).toContain('-f candidate_sha="$release_sha"');
    expect(merge).toContain("Wait for every Core E2E job");
    expect(merge.indexOf("candidate_mode=main")).toBeLessThan(merge.indexOf("Do not tag"));
  });
});
