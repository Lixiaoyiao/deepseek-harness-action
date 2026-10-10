import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { isRecord } from "../src/security/record.js";

function stepBlock(workflow: string, name: string): string {
  const marker = `      - name: ${name}`;
  const start = workflow.indexOf(marker);
  if (start < 0) throw new Error(`Missing E2E workflow step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + marker.length);
  return workflow.slice(start, end < 0 ? undefined : end);
}

function workflowRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) {
    throw new Error("Expected a workflow mapping");
  }
  return value;
}

function candidateShellCalls(script: string): readonly { name: string; invocation: string }[] {
  const lines = script.split(/\r?\n/u);
  const calls: { name: string; invocation: string }[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (line === undefined) continue;
    const name = /^\s*run_candidate\s+(\w+)\s/u.exec(line)?.[1];
    if (name === undefined) continue;
    let invocation = line;
    while (line.trimEnd().endsWith("\\") && index + 1 < lines.length) {
      index += 1;
      line = lines[index] ?? "";
      invocation += `\n${line}`;
    }
    calls.push({ name, invocation });
  }
  return calls;
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
    expect(integrity).toContain("deepseek-api-key: dsh-e2e-integrity-fixture-key");
    expect(integrity).toContain("base-url: ${{ steps.integrity_fixture.outputs.base_url }}");
    expect(integrity).toContain("DSH_E2E_INTEGRITY_FIXTURE");
    expect(integrity).not.toContain("secrets.DEEPSEEK_API_KEY");
    const start = stepBlock(workflow, "Start deterministic integrity fixture");
    expect(start).toContain("node .github/e2e/integrity-llm.mjs");
    expect(start).not.toContain("secrets.");
    expect(stepBlock(workflow, "Stop deterministic integrity fixture")).toContain("if: always()");
    expect(stepBlock(workflow, "Assert integrity failure")).toContain(
      'map(.phase) == ["bash-issued", "bash-observed"]',
    );
  });

  it("uses the bound candidate runtime default at every Action and direct-process entry", () => {
    expect(workflow).not.toMatch(/^\s+dsh-version:/mu);
    expect(workflow).not.toContain("INPUT_DSH-VERSION=");
    expect(workflow).toContain("uses: ./candidate-action");
    expect(workflow).toContain("node candidate-action/dist/index.js");
  });

  it("declares real validation commands for the no-change Subagent write without executing validation", () => {
    const launch = stepBlock(workflow, "Real native.subagent with no-change write");
    const assertion = stepBlock(workflow, "Assert native.subagent and no-change semantics");
    const configured = /^\s+test-commands: '(.+)'$/mu.exec(launch)?.[1];
    if (configured === undefined)
      throw new Error("Subagent write lacks explicit validation commands");
    const commands: unknown = JSON.parse(configured);

    expect(commands).toEqual([
      ["npm", "ci", "--ignore-scripts"],
      ["npm", "run", "typecheck"],
      ["npm", "test"],
    ]);
    expect(launch).toContain("task-access: write");
    expect(launch).toContain('allow-write: "true"');
    expect(launch).toContain('run-tests: "true"');
    expect(launch).toContain('disallowed-tools: \'["native.bash","native.web-search"]\'');
    expect(assertion).toContain('.policy.trust == "trusted-write"');
    expect(assertion).toContain('.write.status == "no-changes" and .write.changedPaths == []');
    expect(assertion).toContain('.validation.status == "not-applicable"');
    expect(assertion).toContain('.id == "native.subagent" and .completed == true and .ok == true');
    expect(assertion).toContain("for component in main candidate prs comments task-refs task-prs");
  });

  it("requires nonempty validation argv for every explicit write task and preserves the failing validator", () => {
    const parsed: unknown = parse(workflow);
    const steps = Object.values(workflowRecord(workflowRecord(parsed).jobs)).flatMap((job) => {
      const candidates = workflowRecord(job).steps;
      return Array.isArray(candidates) ? candidates.map(workflowRecord) : [];
    });
    const writeTasks = steps.filter((step) => {
      if (step.uses !== "./candidate-action") return false;
      const inputs = workflowRecord(step.with);
      return inputs.command === "task" && inputs["task-access"] === "write";
    });
    expect(writeTasks.map((step) => step.name)).toEqual(
      expect.arrayContaining([
        "Native trusted-write workspace path",
        "Real native.subagent with no-change write",
      ]),
    );
    for (const step of writeTasks) {
      const configured = workflowRecord(step.with)["test-commands"];
      if (typeof configured !== "string") {
        throw new Error(`Positive write ${String(step.name)} lacks explicit validation commands`);
      }
      const commands: unknown = JSON.parse(configured);
      expect(commands, String(step.name)).toBeInstanceOf(Array);
      if (!Array.isArray(commands)) throw new Error("Validation commands must be argv arrays");
      expect(commands.length, String(step.name)).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command, String(step.name)).toBeInstanceOf(Array);
        if (!Array.isArray(command)) throw new Error("Validation command must be an argv array");
        expect(command.length, String(step.name)).toBeGreaterThan(0);
        expect(command.every((argument: unknown) => typeof argument === "string")).toBe(true);
      }
    }
    const failingValidator = writeTasks.find(
      (step) => workflowRecord(step.with)["test-commands"] === '[["false"]]',
    );
    expect(failingValidator?.["continue-on-error"]).toBe(true);
  });

  it("requires each shell-launched write to provide its own nonempty validation argv", () => {
    const parsed: unknown = parse(workflow);
    const scripts = Object.values(workflowRecord(workflowRecord(parsed).jobs)).flatMap((job) => {
      const steps = workflowRecord(job).steps;
      return Array.isArray(steps)
        ? steps.flatMap((step: unknown) => {
            const run = workflowRecord(step).run;
            return typeof run === "string" ? [run] : [];
          })
        : [];
    });
    const calls = scripts.flatMap(candidateShellCalls);
    const writes = calls.filter(({ invocation }) =>
      /INPUT_ALLOW-WRITE=true|INPUT_TASK-ACCESS=write|INPUT_COMMAND=(?:fix|implement)/u.test(
        invocation,
      ),
    );
    expect(writes.map(({ name }) => name)).toEqual([
      "github",
      "metadata",
      "native_write",
      "fix",
      "implement",
    ]);
    for (const { name, invocation } of writes) {
      expect(invocation, name).toContain("'INPUT_RUN-TESTS=true'");
      const configured = /(['"])INPUT_TEST-COMMANDS=(.*?)\1/u.exec(invocation)?.[2];
      expect(configured, name).toBeDefined();
      if (configured === undefined) throw new Error(`Shell write ${name} lacks validation argv`);
      if (configured === "$validation") {
        const script = scripts.find((candidate) => candidate.includes(invocation));
        const setup = script?.slice(0, script.indexOf(invocation));
        expect(setup, name).toContain(
          '\'[["node",".github/dsh-e2e-fixtures/validate-business-file.mjs",$path,$content]]\'',
        );
        continue;
      }
      const commands: unknown = JSON.parse(configured);
      expect(commands, name).toBeInstanceOf(Array);
      if (!Array.isArray(commands)) throw new Error(`Shell write ${name} has invalid validation`);
      expect(commands.length, name).toBeGreaterThan(0);
      for (const command of commands) {
        expect(command, name).toBeInstanceOf(Array);
        if (!Array.isArray(command)) throw new Error(`Shell write ${name} has invalid argv`);
        expect(command.length, name).toBeGreaterThan(0);
        expect(command.every((argument: unknown) => typeof argument === "string")).toBe(true);
      }
    }
    const nativeWrite = writes.find(({ name }) => name === "native_write")?.invocation;
    expect(nativeWrite).toContain(
      'INPUT_TEST-COMMANDS=[["npm","ci","--ignore-scripts"],["npm","run","typecheck"],["npm","test"]]',
    );
    for (const script of scripts.filter((candidate) => candidate.includes("run_candidate()"))) {
      const defaults = script.split("run_candidate() {")[1]?.split("read_output() {")[0];
      expect(defaults).toBeDefined();
      expect(defaults).not.toContain("INPUT_TEST-COMMANDS=");
    }
  });

  it("installs candidate test dependencies separately from the trusted harness lock", () => {
    const fixtures = stepBlock(workflow, "Install fixture dependencies without lifecycle scripts");
    const candidate = stepBlock(
      workflow,
      "Install exact candidate test dependencies without lifecycle scripts",
    );
    const ecosystem = stepBlock(workflow, "Deterministic native ecosystem compatibility");

    expect(fixtures).toContain("run: npm ci --ignore-scripts");
    expect(candidate).toContain("npm ci --prefix candidate-action --ignore-scripts --no-fund");
    expect(candidate).toContain("npm ls --prefix candidate-action --all");
    expect(candidate).not.toMatch(/--force|--legacy-peer-deps|--no-audit/u);
    expect(ecosystem).toContain("cd candidate-action");
    expect(ecosystem).toContain("./node_modules/.bin/vitest run");
    expect(ecosystem).not.toContain("../node_modules/.bin/vitest");
    expect(workflow.indexOf(candidate)).toBeLessThan(workflow.indexOf(ecosystem));
  });

  it("locks controlled tool-policy semantics into the strict and MCP golden paths", () => {
    const strict = stepBlock(workflow, "Assert strict/Profile/Bundle result");
    const mcp = stepBlock(workflow, "Assert MCP allow/deny and receipts");

    for (const assertion of [strict, mcp]) {
      expect(assertion).toContain('.toolPolicy.policyOwner == "controller"');
      expect(assertion).toContain(".toolPolicy.effectiveTools == .permissions.effectiveTools");
      expect(assertion).toContain('(.toolPolicy | has("observedTools") | not)');
    }
    expect(strict).toContain(
      '.toolPolicy.requestedTools == ["workspace.edit","workspace.read","workspace.search"]',
    );
    expect(mcp).toContain(
      '.toolPolicy.requestedTools == ["mcp.fixture.echo","mcp.fixture.hidden","workspace.read","workspace.search"]',
    );
  });

  it("requires an unknown MCP proof from the real model without exposing its expected value", () => {
    const start = stepBlock(workflow, "Start real Streamable HTTP MCP fixture");
    const launch = stepBlock(workflow, "MCP allow and deny");
    const assertion = stepBlock(workflow, "Assert MCP allow/deny and receipts");
    const report = stepBlock(workflow, "Report bounded MCP proof diagnostics");
    const artifact = stepBlock(workflow, "Preserve MCP execution evidence");

    expect(launch).toContain("deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}");
    expect(launch).toContain("taskOutput.proof");
    expect(launch).toContain('"proof":{"type":"string","minLength":48,"maxLength":48}');
    expect(launch).not.toMatch(/expectedProof|expected_proof|\.endpoint|const.*proof/iu);
    expect(launch).toContain('maxCalls":1');
    expect(launch).toContain("disallowed-tools: '[\"mcp.fixture.hidden\"]'");
    expect(start).toContain('echo "::add-mask::$proof"');
    expect(assertion).toContain("if: always()");
    expect(assertion.indexOf("mcp-proof-evidence.mjs capture")).toBeLessThan(
      assertion.indexOf("jq -e"),
    );
    expect(assertion).toContain('.actionOutcome == "success" and .proofMatches == true');
    expect(assertion).toContain('[[ "$(wc -l < "$MCP_AUDIT")" -eq 1 ]]');
    expect(assertion).toContain("length == 1");
    expect(assertion).toContain('all(.id != "mcp.fixture.hidden")');
    expect(report).toContain("if: always()");
    expect(report).not.toMatch(/RESULT_JSON|task-output|summary:|MCP_ENDPOINT|DEEPSEEK_API_KEY/u);
    expect(artifact).toContain("if: always()");
    expect(artifact).toContain("dsh-e2e-mcp-evidence.json");
    expect(artifact).toContain("dsh-e2e-mcp-audit.jsonl");
    expect(artifact).not.toMatch(/endpoint|server\.log|\.stdout|result-json/u);
  });

  it("requires a source from a real Web Search and records evidence before failed assertions", () => {
    const launch = stepBlock(workflow, "Real mediated Web Search");
    const assertion = stepBlock(workflow, "Assert Web Search mediation and receipt");
    const artifact = stepBlock(workflow, "Preserve bounded Web Search evidence");
    expect(launch).toContain("deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}");
    expect(launch).toContain("actual DSH runtime web_search tool exactly once");
    expect(launch).toContain("first source returned by that tool");
    expect(launch).toContain("site:api-docs.deepseek.com context caching");
    expect(launch).toContain("allowed-tools: '[\"native.web-search\"]'");
    expect(launch).toContain("task-output-schema:");
    expect(launch).not.toMatch(
      /base-url:|mcp-config:|isolation: none|official DeepSeek Harness repository/u,
    );
    expect(assertion).toContain("if: always()");
    expect(assertion.indexOf("node .github/e2e/web-search-evidence.mjs")).toBeLessThan(
      assertion.indexOf("jq -e"),
    );
    expect(assertion).toContain(".receiptCount == 1 and .completedWebSearchCount == 1");
    expect(assertion).toContain('.permissions.network == "mediated-web"');
    expect(assertion).toContain(".loop.dshToolReceipts // []");
    expect(artifact).toContain("if: always()");
    expect(artifact).toContain("dsh-e2e-web-evidence.json");
    expect(artifact).not.toMatch(/result-json|\.log|\.stdout/u);
  });

  it("runs an exact-candidate native read-only smoke with observed DSH inventory", () => {
    const launch = stepBlock(workflow, "Native headless read-only smoke");
    const assertion = stepBlock(workflow, "Assert native composition and observed inventory");

    expect(launch).toContain("uses: ./candidate-action");
    expect(launch).toContain("dsh-mode: native");
    expect(launch).toContain("isolation: docker");
    expect(launch).not.toContain("mcp-config:");
    expect(launch).not.toContain("plugin-config:");
    for (const contract of [
      '.dsh.mode == "native"',
      '.dsh.composition == "dsh-native-headless"',
      '.toolPolicy.policyOwner == "dsh"',
      'index("read") != null',
      'index("glob") != null',
      'index("grep") != null',
      'index("workspace.read") == null',
      '(.toolPolicy | has("effectiveTools") | not)',
      '(.toolPolicy | has("requestedTools") | not)',
      '.isolation.workspaceAccess == "read-only"',
      '.isolation.extensionProfile == "none"',
    ]) {
      expect(assertion).toContain(contract);
    }
  });

  it("qualifies the candidate native ecosystem, trusted-write workspace, and Controller GitHub path", async () => {
    const ecosystem = stepBlock(workflow, "Deterministic native ecosystem compatibility");
    const nativeWrite = stepBlock(workflow, "Native trusted-write workspace path");
    const nativeWriteAssertion = stepBlock(workflow, "Assert native trusted-write authority");
    const integration = stepBlock(
      workflow,
      "Exercise routes, filters, structured output, and typed GitHub tools",
    );
    const fixture = await readFile(
      new URL("../.github/e2e/github-integration-llm.mjs", import.meta.url),
      "utf8",
    );

    expect(ecosystem).toContain("cd candidate-action");
    expect(ecosystem).toContain(
      "./node_modules/.bin/vitest run test/native-ecosystem.integration.test.ts",
    );
    expect(nativeWrite).toContain("uses: ./candidate-action");
    expect(nativeWrite).toContain("deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}");
    expect(nativeWrite).toContain("dsh-mode: native");
    expect(nativeWrite).toContain("task-access: write");
    expect(nativeWrite).toContain(`allowed-tools: '["workspace.edit"]'`);
    expect(nativeWriteAssertion).toContain('.policy.trust == "trusted-write"');
    expect(nativeWriteAssertion).toContain('.isolation.workspaceAccess == "read-write"');
    expect(nativeWriteAssertion).toContain('.toolPolicy.policyOwner == "dsh"');
    for (const contract of [
      "run_candidate native_write",
      "run_candidate native_checks",
      "INPUT_DSH-MODE=native",
      'INPUT_ALLOWED-TOOLS=["workspace.edit"]',
      'INPUT_ALLOWED-TOOLS=["github.checks.read"]',
      '.dsh.composition == "dsh-native-headless"',
      '.toolPolicy.policyOwner == "dsh"',
      '(.toolPolicy | has("effectiveTools") | not)',
      '.isolation.workspaceAccess == "read-write"',
      '.permissions.effectiveTools == ["github.checks.read"]',
      'fixture_hash="$(printf',
      '[[ "$public_result" != *"$fixture_key"* ]]',
      '[[ "$public_result" != *"$fixture_hash"* ]]',
    ]) {
      expect(integration).toContain(contract);
    }
    expect(fixture).toContain('route.startsWith("native-")');
    expect(fixture).toContain('prompt.includes("Generate the session title")');
    expect(fixture).toContain('route === "native-write"');
    expect(fixture).toContain('route === "native-checks"');
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
    const install = stepBlock(
      workflow,
      "Install exact candidate runtime without lifecycle scripts",
    );
    const integration = stepBlock(
      workflow,
      "Exercise routes, filters, structured output, and typed GitHub tools",
    );

    expect(install).toContain(
      "npm ci --prefix candidate-action --omit=dev --ignore-scripts --no-audit --no-fund",
    );
    expect(install).toContain(
      'test -f "$GITHUB_WORKSPACE/candidate-action/node_modules/@deepseek-ai/dsh/lib/bin.js"',
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
    expect(
      integration.match(
        /INPUT_DSH-EXECUTABLE=\$GITHUB_WORKSPACE\/candidate-action\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js/gu,
      ),
    ).toHaveLength(3);
    expect(integration).not.toContain("secrets.DEEPSEEK_API_KEY");
  });

  it("creates a minimal base with an immutable validator and a one-file checks diff", () => {
    const creation = stepBlock(workflow, "Create isolated Issue and draft PR fixtures");

    for (const contract of [
      ".github/dsh-e2e-fixtures/checks-",
      "dsh-e2e/checks-base-",
      '{tree:[{path:$path,mode:"100644",type:"blob",sha:$sha},',
      '{path:".github/dsh-e2e-fixtures/validate-business-file.mjs",mode:"100644",type:"blob",sha:$validator}]}',
      "--rawfile content .github/e2e/validate-business-file.mjs",
      '[[ "$validator_blob_sha" == "$(git hash-object .github/e2e/validate-business-file.mjs)" ]]',
      "base_tree:$base",
      "parents:[$parent]",
      'echo "base_tree_sha=$base_tree_sha"',
      'echo "base_sha=$base_sha"',
      'echo "tree_sha=$tree_sha"',
      'echo "head_sha=$head_sha"',
      '-f base="$base_branch"',
      '--arg sha "$head_sha"',
    ]) {
      expect(creation).toContain(contract);
    }
    expect(creation).toContain('--arg parent "$CANDIDATE_SHA"');
    expect(creation).toContain('--arg parent "$base_sha"');
    expect(creation).not.toContain('-f sha="$CANDIDATE_SHA" >/dev/null');
    expect(creation).toContain(
      'node .github/e2e/fixture-ref.mjs create "$base_branch" "$base_sha"',
    );
    expect(creation).toContain('node .github/e2e/fixture-ref.mjs create "$branch" "$head_sha"');
    expect(creation).not.toContain('gh api --method POST "repos/$REPOSITORY/git/refs"');
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

  it("qualifies PR review, failed-CI fix, and Issue implementation through recorded effects", () => {
    const integration = stepBlock(
      workflow,
      "Exercise routes, filters, structured output, and typed GitHub tools",
    );
    for (const contract of [
      "run_candidate review",
      "run_candidate fix",
      "run_candidate implement",
      ".publication.inlinePublished == 1",
      "repos/$REPOSITORY/check-runs",
      "DSH_E2E_CI_FAILURE_",
      "INPUT_RUN-TESTS=true",
      "INPUT_VALIDATION-INTEGRITY=strict",
      'select(.id == "native.bash" and .completed and .ok)',
      "node .github/e2e/assert-business-effects.mjs fix",
      "node .github/e2e/assert-business-effects.mjs implement",
      'echo "implementation_branch=$implementation_branch"',
      'echo "implementation_pull_ids=',
      '["bash-issued","bash-observed"]',
    ])
      expect(integration).toContain(contract);
    expect(integration.indexOf('echo "implementation_branch=')).toBeLessThan(
      integration.indexOf("run_candidate implement"),
    );
    expect(integration.indexOf('echo "implementation_pull_ids=')).toBeLessThan(
      integration.indexOf('[[ "$implement_ok" == "true" ]]'),
    );
    const cleanup = stepBlock(workflow, "Remove only verified integration fixtures");
    expect(cleanup).toContain("assert-business-effects.mjs cleanup-implement");
    expect(cleanup).toContain("assert-business-effects.mjs fix-cleanup");
    expect(cleanup).toContain("cleanup_failure_check");
    expect(cleanup).toContain("-f conclusion=neutral");
    expect(cleanup).toContain("original_commit_id == $head");
    const evidence = stepBlock(workflow, "Capture bounded business execution evidence");
    expect(evidence).toContain("if: always()");
    expect(evidence).toContain("{route,index,kind,phase,authorizationMatches}");
    expect(evidence).not.toContain(".prompt");
  });

  it.each(["fix", "implement"])(
    "explicitly grants workspace editing before the %s fixture requests a Bash write",
    (operation) => {
      const integration = stepBlock(
        workflow,
        "Exercise routes, filters, structured output, and typed GitHub tools",
      );
      const invocation = integration
        .split(`run_candidate ${operation} `)[1]
        ?.split(`|| ${operation}_ok=false`)[0];

      expect(invocation).toContain("'INPUT_PERMISSION-PROFILE=custom'");
      expect(invocation).toContain('INPUT_ALLOWED-TOOLS=["workspace.edit","native.bash"]');
      expect(invocation).toContain("'INPUT_ALLOW-WRITE=true'");
      expect(invocation).toContain("'INPUT_ISOLATION=docker'");
      expect(invocation).toContain("'INPUT_RUN-TESTS=true'");
      expect(invocation).toContain("'INPUT_VALIDATION-INTEGRITY=strict'");
    },
  );

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
    expect(cleanup).toContain("cleanup_base_branch() (");
    expect(cleanup).toContain("cleanup_failures=$((cleanup_failures + 1))");
    expect(cleanup).toContain('[[ "$cleanup_failures" -eq 0 ]]');
    expect(cleanup).toContain(".parents[0].sha");
    expect(cleanup).toContain(".tree.sha");
    expect(cleanup).toContain(".files | length == 1");
    expect(cleanup).toContain('path == ".github/dsh-e2e-fixtures"');
    expect(cleanup).toContain(".tree | length == 4");
    expect(cleanup).toContain(
      'validator_blob_sha="$(git hash-object .github/e2e/validate-business-file.mjs)"',
    );
    expect(cleanup).toContain(
      'select(.path == ".github/dsh-e2e-fixtures/validate-business-file.mjs" and .mode == "100644" and .type == "blob" and .sha == $validator)',
    );
    expect(cleanup).toContain("git/blobs/$blob_sha");
    expect(cleanup).toContain(
      'node .github/e2e/fixture-ref.mjs delete "$CHECKS_BRANCH" "$ref_sha"',
    );
    expect(cleanup).toContain(
      'node .github/e2e/fixture-ref.mjs delete "$CHECKS_BASE_BRANCH" "$ref_sha"',
    );
    expect(cleanup.match(/\.status == "404" or \.status == 404/gu)).toHaveLength(2);
    expect(cleanup).toContain("Fixture ref preflight could not confirm absence.");
    expect(cleanup).not.toMatch(/ref_sha=.*\|\| return 0/u);
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
