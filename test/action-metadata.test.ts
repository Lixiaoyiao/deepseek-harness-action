import { readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  ACTION_TAG,
  ACTION_VERSION,
  DIRECT_DSH_PACKAGES,
  DSH_VERSION,
  RELEASE_CANARY_VARIABLE,
} from "../src/release.js";

const RELEASE_REFERENCE = ACTION_TAG;

describe("Marketplace action metadata", () => {
  it("uses the supported Node 24 runtime and ships the declared bundle", async () => {
    const metadata = await readFile(new URL("../action.yml", import.meta.url), "utf8");
    expect(metadata).toContain('name: "DeepSeek Harness for GitHub"');
    expect(metadata).toContain('author: "Lixiaoyiao"');
    expect(metadata).toContain('using: "node24"');
    expect(metadata).toContain('main: "dist/index.js"');
    await expect(readFile(new URL("../dist/index.js", import.meta.url), "utf8")).resolves.not.toBe(
      "",
    );
  });

  it("keeps safe defaults in the published metadata", async () => {
    const metadata = await readFile(new URL("../action.yml", import.meta.url), "utf8");
    expect(metadata).toMatch(/allow-write:[\s\S]*?default: "false"/u);
    expect(metadata).toMatch(/progress-comment:[\s\S]*?default: "true"/u);
    expect(metadata).toMatch(/trigger-phrase:[\s\S]*?default: "@dsh"/u);
    expect(metadata).toMatch(/label-trigger:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/assignee-trigger:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/allowed-actors:[\s\S]*?default: "\*"/u);
    expect(metadata).toMatch(/allowed-bots:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/include-comments-by-actor:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/exclude-comments-by-actor:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/base-branch:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/branch-prefix:[\s\S]*?default: "dsh\/"/u);
    expect(metadata).toMatch(/branch-name-template:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/task-output-schema:[\s\S]*?default: ""/u);
    expect(metadata).toMatch(/task-access:[\s\S]*?default: "read"/u);
    expect(metadata).toMatch(/max-turns:[\s\S]*?default: "3"/u);
    expect(metadata).toMatch(/permission-profile:[\s\S]*?default: "strict"/u);
    expect(metadata).toMatch(/allowed-tools:[\s\S]*?default: "\[\]"/u);
    expect(metadata).toMatch(/disallowed-tools:[\s\S]*?default: "\[\]"/u);
    expect(metadata).toMatch(/validation-integrity:[\s\S]*?default: "warn"/u);
    expect(metadata).toMatch(/tool-config:[\s\S]*?schemaVersion/u);
    expect(metadata).toMatch(/mcp-config:[\s\S]*?schemaVersion/u);
    expect(metadata).toMatch(/plugin-config:[\s\S]*?schemaVersion/u);
    expect(metadata).toMatch(/allow-plugin-install:[\s\S]*?default: "false"/u);
    expect(metadata).toMatch(/isolation:[\s\S]*?default: "docker"/u);
    expect(metadata).toContain(`default: "${DSH_VERSION}"`);
    expect(metadata).toMatch(/extensions and writes require a full name@sha256 digest/iu);
    expect(metadata).toMatch(/mcp-config:[\s\S]*?stdio startup executes trusted worker code/iu);
    expect(metadata).toMatch(/plugin-config:[\s\S]*?startup executes trusted worker code/iu);
    expect(metadata).toMatch(/extension-profile-digest:[\s\S]*?SHA-256 digest/u);
    expect(metadata).toMatch(
      /tool-receipts:[\s\S]*?bounded controller\/DSH receipt arrays and truncation metadata/u,
    );
    expect(metadata).toMatch(/effective-tools:[\s\S]*?granted by the Controller/u);
    expect(metadata).toMatch(/result-json:[\s\S]*?tool-policy ownership audit/u);
    expect(metadata).toMatch(/result-json:[\s\S]*?known-authority audit/u);
    expect(metadata).toMatch(/result-json:[\s\S]*?Versioned JSON envelope/u);
    expect(metadata).toMatch(/task-output:[\s\S]*?Controller schema validation/u);
    expect(metadata).toMatch(/error-code:[\s\S]*?Stable failure code/u);
  });

  it("pins the official DSH rc.2 runtime and its lockfile exactly", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as {
      version: string;
      scripts: Record<string, string>;
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const lock = JSON.parse(
      await readFile(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as {
      packages: Record<string, { version?: string }>;
    };
    const directDependencies = { ...manifest.dependencies, ...manifest.devDependencies };

    expect(manifest.version).toBe(ACTION_VERSION);
    expect(manifest.scripts["test:release-contract"]).toBe(
      "node scripts/verify-release-contract.mjs",
    );
    expect(manifest.scripts.check).toContain("npm run test:release-contract");
    for (const packageName of DIRECT_DSH_PACKAGES) {
      expect(directDependencies[packageName]).toBe(DSH_VERSION);
      expect(lock.packages[`node_modules/${packageName}`]?.version).toBe(DSH_VERSION);
    }
    for (const [packageName, version] of Object.entries({
      ...manifest.dependencies,
      ...manifest.devDependencies,
    })) {
      if (packageName === "@deepseek-ai/dsh" || packageName.startsWith("@deepseek-ai/dsh-")) {
        expect(version).toBe(DSH_VERSION);
      }
    }

    const lockedDshVersions = Object.entries(lock.packages)
      .filter(([packagePath]) =>
        /(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/u.test(packagePath),
      )
      .map(([, entry]) => entry.version);
    expect(lockedDshVersions.length).toBeGreaterThan(0);
    expect(new Set(lockedDshVersions)).toEqual(new Set([DSH_VERSION]));
  });

  it("keeps active CI on the locked app-boot and MCP runtime smoke", async () => {
    const workflowsDirectory = new URL("../.github/workflows/", import.meta.url);
    const activeWorkflows = (await readdir(workflowsDirectory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name),
    );
    for (const workflow of activeWorkflows) {
      const contents = await readFile(new URL(workflow.name, workflowsDirectory), "utf8");
      expect(contents).not.toContain("0.1.0-rc.6");
    }

    const ci = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(ci).toContain("cp package.json package-lock.json");
    expect(ci).toContain("npm ci --no-audit --no-fund --omit=dev --ignore-scripts");
    expect(ci).toContain(`const expectedVersion = "${DSH_VERSION}"`);
    expect(ci).toContain("Object.keys(manifest.dependencies ?? {})");
    expect(ci).toContain('await import("@deepseek-ai/dsh-app-boot")');
    expect(ci).toContain('await import("@deepseek-ai/dsh-mcp-client")');
    expect(ci).toContain("action-launcher.mjs");
    expect(ci).toContain("action-policy.mjs");
    expect(ci).not.toContain("lib/bin.js");
    expect(ci).not.toContain("--dump-config");
    expect(ci).not.toContain("policy.patch.yml");
  });

  it("ships the rc.2 extension contract in dist without older release-candidate drift", async () => {
    const bundle = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
    expect(bundle).toContain(DSH_VERSION);
    expect(bundle).not.toContain("0.1.0-rc.8");
    for (const token of [
      "mcp-config",
      "plugin-config",
      "allow-plugin-install",
      "extension-profile-digest",
      "tool-receipts",
      "action-launcher.mjs",
      "@deepseek-ai/dsh-mcp-client",
      "trigger-phrase",
      "branch-name-template",
      "github.comment.create",
      "github.checks.read",
      "task-output-schema",
      "task-output",
    ]) {
      expect(bundle).toContain(token);
    }
  });

  it("binds the canary to the formal v0.7.0 release and its immutable tag commit", async () => {
    const canary = await readFile(
      new URL("../.github/workflows/release-canary.yml", import.meta.url),
      "utf8",
    );
    const gate = canary.slice(0, canary.indexOf("  smoke:"));
    expect(canary).toContain(`name: ${ACTION_TAG} release canary`);
    expect(gate).toContain('[[ "$WORKFLOW_REF" == "refs/heads/main" ]]');
    expect(gate).toContain('[[ "$RUN_SHA" == "$WORKFLOW_SHA" ]]');
    expect(gate).toContain('[[ "$RUN_SHA" == "$live_sha" ]]');
    expect(gate).not.toContain("secrets.");
    expect(canary).toContain("needs: gate");
    expect(canary.match(/environment: core-e2e/gu)).toHaveLength(1);
    expect(canary).toContain("DEEPSEEK_SECRET_PRESENT: ${{ secrets.DEEPSEEK_API_KEY != '' }}");
    expect(canary).toContain(`RELEASE_TAG: ${ACTION_TAG}`);
    expect(canary).toContain(`vars.${RELEASE_CANARY_VARIABLE}`);
    expect(canary).toContain("releases/tags/$RELEASE_TAG");
    expect(canary).toContain("git/ref/tags/$RELEASE_TAG");
    expect(canary).toContain(".draft == false and .prerelease == false");
    expect(canary).toContain('"$object_sha" != "$RELEASE_SHA"');
    expect(canary).toContain('git -C release-action rev-parse HEAD)" = "$RELEASE_SHA"');
    expect(canary).toContain("persist-credentials: false");
  });

  it("generates static bundle notices from NCC source maps only", async () => {
    const generator = await readFile(
      new URL("../scripts/generate-bundled-notices.mjs", import.meta.url),
      "utf8",
    );
    const notices = await readFile(new URL("../BUNDLED_DEPENDENCIES.md", import.meta.url), "utf8");
    expect(generator).toContain('.endsWith(".js.map")');
    expect(generator).toContain("packagePathFromSource");
    expect(generator).not.toMatch(/Object\.entries\(lock\.packages\).*metadata\.dev/su);
    expect(notices).toContain("reported by the committed NCC source maps");
    expect(notices).toContain("installed\nfrom `package-lock.json`");
    expect(notices).not.toContain("## @deepseek-ai/dsh@");
  });

  it("never executes the pull request revision before loading the DeepSeek secret", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/review.yml", import.meta.url),
      "utf8",
    );
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).not.toMatch(/^\s+pull_request:\s*$/mu);
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow.indexOf("ref: ${{ github.workflow_sha }}")).toBeLessThan(
      workflow.indexOf("deepseek-api-key:"),
    );
    expect(workflow).toContain("uses: ./");

    for (const relativePath of ["../examples/commands.yml", "../examples/ci-diagnose.yml"]) {
      const example = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(example).toContain("ref: ${{ github.event.repository.default_branch }}");
      expect(example.indexOf("ref: ${{ github.event.repository.default_branch }}")).toBeLessThan(
        example.indexOf("deepseek-api-key:"),
      );
    }
    const commands = await readFile(new URL("../examples/commands.yml", import.meta.url), "utf8");
    expect(commands).toContain("issue_comment:");
    expect(commands).not.toContain("pull_request_review:");
    expect(commands).not.toContain("pull_request_review_comment:");
    expect(commands).toContain(
      "container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059",
    );
    for (const relativePath of [
      "../README.md",
      "../README.zh-CN.md",
      "../examples/fork-review.yml",
      "../examples/commands.yml",
      "../examples/ci-diagnose.yml",
      "../examples/ci-auto-fix.yml",
      "../examples/task-automation.yml",
      "../examples/github-integration.yml",
    ]) {
      const example = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(example).toContain(`uses: Lixiaoyiao/deepseek-harness-action@${RELEASE_REFERENCE}`);
    }
  });

  it("ships release examples without reference placeholders", async () => {
    for (const relativePath of [
      "../README.md",
      "../README.zh-CN.md",
      "../examples/fork-review.yml",
      "../examples/commands.yml",
      "../examples/ci-diagnose.yml",
      "../examples/ci-auto-fix.yml",
      "../examples/task-automation.yml",
      "../examples/github-integration.yml",
    ]) {
      const document = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(document).not.toMatch(
        /your-org|@0{40}|sha256:0{64}|immutable-reference placeholders|replace (?:the zero|both)/iu,
      );
    }
  });

  it("ships the v0.7.0 task example with the standard coding profile", async () => {
    const example = await readFile(
      new URL("../examples/task-automation.yml", import.meta.url),
      "utf8",
    );
    expect(example).toContain(`deepseek-harness-action@${RELEASE_REFERENCE}`);
    expect(example).not.toMatch(/planned|@v0\.3(?:\s|$)/iu);
    expect(example).toContain("task-access:");
    expect(example).toContain("max-turns:");
    expect(example).toContain("permission-profile: standard");
    expect(example).toContain("validation-integrity: strict");
    expect(example).toContain("test-commands:");
  });

  it("ships a fail-closed v0.7.0 GitHub integration example", async () => {
    const example = await readFile(
      new URL("../examples/github-integration.yml", import.meta.url),
      "utf8",
    );
    expect(example).toContain(`deepseek-harness-action@${RELEASE_REFERENCE}`);
    expect(example).toContain("trigger-phrase: /deepseek");
    expect(example).toContain("label-trigger: dsh-ready");
    expect(example).toContain("allowed-actors: REPLACE_WITH_MAINTAINER_LOGIN");
    expect(example).toContain("github.issue.labels.set");
    expect(example).toContain("github.comment.create");
    expect(example).toContain("task-output-schema:");
    expect(example).toContain("{{prefix}}");
    expect(example).toContain("{{key}}");
    expect(example).toContain("persist-credentials: false");
    expect(example).toContain("validation-integrity: strict");
  });

  it("keeps active command and diagnosis workflows on trusted action code", async () => {
    const commands = await readFile(
      new URL("../.github/workflows/commands.yml", import.meta.url),
      "utf8",
    );
    expect(commands).toContain("issue_comment:");
    expect(commands).toContain("github.event.sender.id != 41898282");
    expect(commands).toContain("contains(github.event.comment.body, '@dsh')");
    expect(commands).toContain("ref: ${{ github.workflow_sha }}");
    expect(commands).toContain("persist-credentials: false");
    expect(commands).toContain("uses: ./");
    expect(commands).toContain('allow-write: "true"');
    expect(commands).toContain(
      "container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059",
    );
    expect(commands.indexOf("ref: ${{ github.workflow_sha }}")).toBeLessThan(
      commands.indexOf("deepseek-api-key:"),
    );

    const diagnose = await readFile(
      new URL("../.github/workflows/ci-diagnose.yml", import.meta.url),
      "utf8",
    );
    expect(diagnose).toContain("workflow_run:");
    expect(diagnose).toContain("workflows: [CI]");
    expect(diagnose).toContain("github.event.workflow_run.conclusion == 'failure'");
    expect(diagnose).toContain("ref: ${{ github.workflow_sha }}");
    expect(diagnose).toContain("persist-credentials: false");
    expect(diagnose).toContain("uses: ./");
    expect(diagnose).toContain('allow-write: "false"');
    expect(diagnose.indexOf("ref: ${{ github.workflow_sha }}")).toBeLessThan(
      diagnose.indexOf("deepseek-api-key:"),
    );
  });

  it("runs Core E2E only from the protected default-branch dispatch harness", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/e2e.yml", import.meta.url),
      "utf8",
    );
    const gate = workflow.slice(0, workflow.indexOf("  read_only:"));

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^ {2}pull_request:\s*$/mu);
    expect(gate).toContain("WORKFLOW_REF: ${{ github.ref }}");
    expect(gate).toContain("DISPATCH_SHA: ${{ github.sha }}");
    expect(gate).toContain("APPROVED_CANDIDATE_SHA: ${{ vars.DSH_E2E_CANDIDATE_SHA }}");
    expect(gate).toContain('"$DISPATCH_SHA" == "$default_sha"');
    expect(gate).toContain("candidate_mode:");
    expect(gate).toContain('"$CANDIDATE_SHA" == "$DISPATCH_SHA"');
    expect(gate).not.toContain("secrets.");
    expect(workflow.match(/environment: core-e2e/gu)).toHaveLength(3);
    expect(workflow.match(/ref: \$\{\{ needs\.gate\.outputs\.harness_sha \}\}/gu)).toHaveLength(4);
    expect(workflow).not.toContain("run-candidate.mjs");
    expect(workflow).toContain("dsh-e2e:cancellation:v1");
    expect(workflow).toContain("GITHUB_EVENT_NAME=issues");
    expect(workflow).toContain(
      'gh api --method DELETE "repos/$REPOSITORY/issues/comments/$comment_id"',
    );
    expect(workflow).toContain('gh api --method PATCH "repos/$REPOSITORY/issues/$ISSUE_NUMBER"');
    expect(workflow).toContain("[.ref,.object.type,.object.sha]");
    expect(workflow).toContain("bodyMarker:");
    expect(workflow).toContain("dsh-e2e:github-integration:v1");
    expect(workflow).toContain("github.comment.create");
    expect(workflow).toContain("github.issue.labels.set");
    expect(workflow).toContain("github.issue.assignees.set");
    expect(workflow).toContain("github.issue.state.update");
    expect(workflow).toContain("github.pull.metadata.update");
    expect(workflow).toContain("github.checks.read");
    expect(workflow).toContain("[image removed]");
    expect(workflow).toContain("if: always() && needs.gate.result == 'success'");
  });
});
