import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const RELEASE_RUNTIME_SHA = "8eaaa7777a4756c5e519e791b6613b302fc0a92e";

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
    expect(metadata).toMatch(/task-access:[\s\S]*?default: "read"/u);
    expect(metadata).toMatch(/max-turns:[\s\S]*?default: "3"/u);
    expect(metadata).toMatch(/allowed-tools:[\s\S]*?workspace\.read/u);
    expect(metadata).toMatch(/tool-config:[\s\S]*?schemaVersion/u);
    expect(metadata).toMatch(/isolation:[\s\S]*?default: "docker"/u);
    expect(metadata).toContain('default: "0.1.0-rc.6"');
    expect(metadata).toContain("Trusted-write requires a full name@sha256 digest");
    expect(metadata).toMatch(/result-json:[\s\S]*?Versioned JSON envelope/u);
    expect(metadata).toMatch(/error-code:[\s\S]*?Stable failure code/u);
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
    ]) {
      const example = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(example).toContain(`uses: Lixiaoyiao/deepseek-harness-action@${RELEASE_RUNTIME_SHA}`);
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
    ]) {
      const document = await readFile(new URL(relativePath, import.meta.url), "utf8");
      expect(document).not.toMatch(
        /your-org|@0{40}|sha256:0{64}|immutable-reference placeholders|replace (?:the zero|both)/iu,
      );
    }
  });

  it("ships the v0.3.0 task example with a pinned runtime and safe named tool", async () => {
    const example = await readFile(
      new URL("../examples/task-automation.yml", import.meta.url),
      "utf8",
    );
    expect(example).toContain(`deepseek-harness-action@${RELEASE_RUNTIME_SHA}`);
    expect(example).not.toMatch(/planned|@v0\.3(?:\s|$)/iu);
    expect(example).toContain("task-access:");
    expect(example).toContain("max-turns:");
    expect(example).toContain("allowed-tools:");
    expect(example).toContain("tool-config:");
    expect(example).toContain("command.bundle-syntax");
    expect(example).toContain('"argv": ["node", "--check", "dist/index.js"]');
    expect(example).toContain('"workspaceAccess": "read"');
    expect(example).toContain('"network": "none"');
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
});
