import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type * as DshModule from "../src/dsh/runner.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as ValidationModule from "../src/write/validate.js";
import { DshProcessError } from "../src/dsh/errors.js";
import { runAction } from "../src/orchestrator.js";
import { SessionCheckpointError } from "../src/session/errors.js";
import { githubClientFixture } from "./helpers/github-client.js";
import { actionLifecycleGitHub } from "./helpers/action-lifecycle-github.js";
import type { ReviewFinding } from "../src/review/schema.js";
import { record } from "../src/security/record.js";

const ports = vi.hoisted(() => ({
  client: vi.fn(),
  runDsh: vi.fn<typeof DshModule.runDsh>(),
  validate: vi.fn<typeof ValidationModule.runValidationCommandsInDocker>(),
  session: vi.fn(),
}));
vi.mock("../src/github/client.js", async (original) => ({
  ...(await original<typeof GitHubClientModule>()),
  createGitHubClient: ports.client,
}));
vi.mock("../src/dsh/runner.js", async (original) => ({
  ...(await original<typeof DshModule>()),
  runDsh: ports.runDsh,
}));
vi.mock("../src/write/validate.js", async (original) => ({
  ...(await original<typeof ValidationModule>()),
  runValidationCommandsInDocker: ports.validate,
}));
// Session storage is the external checkpoint port in the final lifecycle case.
vi.mock("../src/session/controller.js", () => ({ prepareControllerSession: ports.session }));

const base = "a".repeat(40);
const tree = "b".repeat(40);
const commit = "c".repeat(40);
let created: ReturnType<typeof actionLifecycleGitHub>["created"];
let published: ReturnType<typeof actionLifecycleGitHub>["published"];
let fixtureRoot: string;
let permission = "write";
let workerPath: string;
let fixture: NonNullable<Parameters<typeof githubClientFixture>[0]>;
const repository = {
  id: 1,
  name: "repo",
  full_name: "octo/repo",
  default_branch: "main",
  owner: { login: "octo" },
};
const issue = {
  id: 301,
  number: 7,
  title: "Create hello.txt",
  body: "Implement the change",
  user: { id: 101, login: "alice" },
  state: "open",
  updated_at: "2026-10-10T00:00:00Z",
};
const pullRequest = {
  ...issue,
  draft: false,
  head: { sha: base, ref: "feature", repo: repository },
  base: { sha: base, ref: "main", repo: repository },
};
const reviewFindings: readonly ReviewFinding[] = [
  {
    title: "Regression in changed line",
    body: "The replacement skips the required check.",
    evidence: "The changed line calls new() instead of the old validation routine.",
    severity: "high",
    category: "correctness",
    confidence: 0.99,
    path: "src/value.ts",
    line: 2,
  },
  {
    title: "Related source needs attention",
    body: "The consumer still assumes the old behavior.",
    evidence: "The consumer contract requires the result that old() returned.",
    severity: "high",
    category: "regression",
    confidence: 0.98,
    path: "src/consumer.ts",
    line: 8,
  },
  {
    title: "Uncertain observation",
    body: "This is not confirmed by the current evidence.",
    severity: "low",
    category: "other",
    confidence: 0.4,
    path: "src/value.ts",
    line: 1,
  },
];

async function selectEntity(
  operation: "review" | "diagnose" | "task" | "implement" | "fix",
  kind: "issue" | "pull_request",
) {
  vi.stubEnv("INPUT_COMMAND", operation);
  vi.stubEnv(
    "GITHUB_EVENT_NAME",
    kind === "issue" ? "issues" : operation === "fix" ? "pull_request" : "pull_request_target",
  );
  if (operation === "review" || operation === "diagnose") {
    vi.stubEnv("INPUT_TASK-ACCESS", "read");
    vi.stubEnv("INPUT_ALLOW-WRITE", "false");
  }
  await writeFile(
    join(fixtureRoot, "event.json"),
    JSON.stringify({
      action: "opened",
      repository,
      sender: { login: "alice" },
      ...(kind === "issue" ? { issue } : { pull_request: pullRequest }),
    }),
  );
}

function reviewWorkerResult(): DshModule.DshRunResult {
  const result = readonlyWorkerResult("final");
  return {
    ...result,
    output: {
      ...result.output,
      operation: "review",
      summary: "Two confirmed review findings",
      findings: [...reviewFindings],
    },
  };
}

function readonlyWorkerResult(
  state: "final" | "blocked",
  mode: "controlled" | "native" = "controlled",
): DshModule.DshRunResult {
  return {
    output: {
      protocolVersion: 1,
      operation: "task",
      state,
      summary: state === "blocked" ? "Cannot safely proceed" : "Task answered",
      findings: [],
    },
    durationMs: 20,
    isolationReport: {
      backend: "docker",
      credentialMediated: true,
      repoToolsEnabled: true,
      processIsolated: true,
      networkIsolated: true,
      workspaceAccess: "read-only",
      extensionProfile: mode === "native" ? "headless-native" : "github-action",
      limitations: [],
    },
    ...(mode === "native" ? { observedTools: ["read", "grep"] } : {}),
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  permission = "write";
  fixtureRoot = await mkdtemp(join(tmpdir(), "dsh-action-lifecycle-"));
  const eventPath = join(fixtureRoot, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: {
        id: 1,
        name: "repo",
        full_name: "octo/repo",
        default_branch: "main",
        owner: { login: "octo" },
      },
      sender: { login: "alice" },
    }),
  );
  for (const [name, value] of Object.entries({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_ACTOR: "alice",
    GITHUB_RUN_ID: "99",
    GITHUB_REPOSITORY: "octo/repo",
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_WORKSPACE: fixtureRoot,
    "INPUT_DEEPSEEK-API-KEY": "sk-fixture-controller-secret",
    "INPUT_GITHUB-TOKEN": "ghs_fixture-controller-secret",
    INPUT_COMMAND: "task",
    INPUT_PROMPT: "Create hello.txt",
    "INPUT_TASK-ACCESS": "write",
    "INPUT_ALLOW-WRITE": "true",
    "INPUT_PROGRESS-COMMENT": "false",
    "INPUT_TEST-COMMANDS": '[["node","--version"]]',
    "INPUT_ALLOWED-TOOLS": '["workspace.read","workspace.edit"]',
  }))
    vi.stubEnv(name, value);
  const github = actionLifecycleGitHub({ base, tree, commit, permission: () => permission });
  fixture = github.transport;
  created = github.created;
  published = github.published;
  ports.client.mockReturnValue(githubClientFixture(fixture));
  ports.validate.mockResolvedValue([
    {
      argv: ["node", "--version"],
      result: {
        exitCode: 0,
        stdout: "v24.15.0",
        stderr: "",
        timedOut: false,
        outputTruncated: false,
      },
    },
  ]);
  ports.session.mockResolvedValue(undefined);
  ports.runDsh.mockImplementation(async (request) => {
    if (request.workspacePath === undefined) throw new Error("Missing worker workspace");
    workerPath = request.workspacePath;
    await writeFile(join(workerPath, "hello.txt"), "hello\n");
    return {
      output: {
        protocolVersion: 1,
        operation: "task",
        state: "final",
        summary: "Created hello.txt",
        findings: [],
      },
      durationMs: 12,
      isolationReport: {
        backend: "docker",
        credentialMediated: true,
        repoToolsEnabled: true,
        processIsolated: true,
        networkIsolated: true,
        workspaceAccess: "read-write",
        extensionProfile: "github-action",
        limitations: [],
      },
    };
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(fixtureRoot, { recursive: true, force: true });
});

it("returns a blocked task without validation, repository writes or saving a Session", async () => {
  const save = vi.fn(() => Promise.resolve());
  ports.session.mockResolvedValue({ restore: () => Promise.resolve(), save });
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("blocked"));
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "neutral",
    summary: "Cannot safely proceed",
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(save).not.toHaveBeenCalled();
  expect(ports.validate).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it.each(["controlled", "native"] as const)(
  "completes a readonly %s task through the real lifecycle",
  async (mode) => {
    vi.stubEnv("INPUT_TASK-ACCESS", "read");
    vi.stubEnv("INPUT_ALLOW-WRITE", "false");
    vi.stubEnv("INPUT_DSH-MODE", mode);
    ports.runDsh.mockResolvedValue(readonlyWorkerResult("final", mode));
    const outcome = await runAction();
    expect(outcome).toMatchObject({
      conclusion: "success",
      summary: "Task answered",
      validation: { status: "not-applicable", commandCount: 0 },
    });
    if (mode === "native")
      expect(outcome.toolPolicy).toEqual({
        schemaVersion: 1,
        policyOwner: "dsh",
        observedTools: ["grep", "read"],
      });
    expect(ports.validate).not.toHaveBeenCalled();
    for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  },
);

it("keeps failed native worker evidence and known usage without publishing a write", async () => {
  vi.stubEnv("INPUT_DSH-MODE", "native");
  const report = readonlyWorkerResult("final", "native");
  const usage = {
    source: "headless-worker" as const,
    completeness: "partial" as const,
    reportedSteps: 1,
    observedSteps: 2,
    tokens: { inputTokens: 100, outputTokens: 20 },
  };
  ports.runDsh.mockRejectedValue(
    new DshProcessError(1, null, "Worker crashed").attachTelemetry({
      durationMs: 20,
      isolationReport: report.isolationReport,
      usage,
      observedTools: ["read", "grep"],
    }),
  );
  const outcome = await runAction();
  expect(outcome).toMatchObject({ conclusion: "failure", agent: { durationMs: 20, usage } });
  expect(outcome.toolPolicy).toEqual({
    schemaVersion: 1,
    policyOwner: "dsh",
    observedTools: ["grep", "read"],
  });
  expect(ports.validate).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("denies an actor revoked during the model turn before any persistent GitHub effect", async () => {
  const run = ports.runDsh.getMockImplementation();
  ports.runDsh.mockImplementation(async (...args) => {
    if (run === undefined) throw new Error("Missing model adapter");
    const result = await run(...args);
    permission = "read";
    return result;
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    validation: { status: "passed", commandCount: 1 },
    error: { code: "POLICY_DENIED" },
  });
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
  await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
});

it("keeps passed validation and confirmed PR evidence when checkpoint upload fails", async () => {
  ports.session.mockResolvedValue({
    restore: () => Promise.resolve(),
    save: () => Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    validation: { status: "passed", commandCount: 1 },
    writeStatus: "partial-success",
    pullRequestNumber: 123,
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(created.blob).toHaveBeenCalledOnce();
  expect(created.commit).toHaveBeenCalledOnce();
  expect(created.branch).toHaveBeenCalledOnce();
  expect(created.pull).toHaveBeenCalledOnce();
  await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
});

it("retains the confirmed PR when final progress publication fails without a Session", async () => {
  vi.stubEnv("GITHUB_EVENT_NAME", "issues");
  vi.stubEnv("INPUT_PROGRESS-COMMENT", "true");
  await writeFile(
    join(fixtureRoot, "event.json"),
    JSON.stringify({
      action: "opened",
      issue: { number: 7 },
      sender: { login: "alice" },
      repository: {
        id: 1,
        name: "repo",
        full_name: "octo/repo",
        default_branch: "main",
        owner: { login: "octo" },
      },
    }),
  );
  const comment = vi.fn(() => Promise.reject(new Error("Comment transport failed")));
  ports.client.mockReturnValue(
    githubClientFixture({
      ...fixture,
      rest: {
        ...fixture.rest,
        issues: {
          get: () =>
            Promise.resolve({
              data: {
                id: 301,
                number: 7,
                title: "Create hello.txt",
                body: "Implement the change",
                user: { id: 101, login: "alice" },
                state: "open",
                updated_at: "2026-10-10T00:00:00Z",
              },
            }),
          listComments: () => Promise.resolve({ data: [], headers: {} }),
          createComment: comment,
        },
      },
      paginate: () => Promise.resolve([]),
    }),
  );
  const outcome = await runAction();
  expect(outcome.error).toBeUndefined();
  expect(outcome).toMatchObject({
    conclusion: "success",
    writeStatus: "success",
    pullRequestNumber: 123,
    validation: { status: "passed" },
  });
  expect(created.pull).toHaveBeenCalledOnce();
  expect(comment).toHaveBeenCalled();
});

it("publishes a current-head review and projects selected inline and summary-only findings", async () => {
  await selectEntity("review", "pull_request");
  ports.runDsh.mockResolvedValue(reviewWorkerResult());
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "review",
    findingsCount: 2,
    publication: { selected: 2, inlinePublished: 1, summaryOnly: 1, failures: [] },
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(published.inline).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      pull_number: 7,
      commit_id: base,
      path: "src/value.ts",
      line: 2,
      side: "RIGHT",
    }),
  );
  expect(published.comment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 7 }),
  );
  const summaryBody = record(published.comment.mock.calls[0]?.[0]).body;
  expect(summaryBody).toContain("Related source needs attention");
  expect(summaryBody).not.toContain("Uncertain observation");
  expect(ports.validate).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("publishes a bounded CI diagnosis from failed checks through the real read lifecycle", async () => {
  await selectEntity("diagnose", "pull_request");
  const result = readonlyWorkerResult("final");
  ports.runDsh.mockResolvedValue({
    ...result,
    output: {
      ...result.output,
      operation: "diagnose",
      summary: "CI diagnosis completed",
      diagnosis: "The required check failed because the new branch skipped validation.",
      findings: reviewFindings.slice(0, 1),
    },
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "diagnose",
    findingsCount: 1,
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(ports.runDsh.mock.calls[0]?.[0].prompt).toContain("FAILED_CHECK_MARKER");
  expect(published.comment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 7 }),
  );
  expect(record(published.comment.mock.calls[0]?.[0]).body).toContain(
    "DeepSeek Harness CI diagnosis",
  );
  expect(published.inline).not.toHaveBeenCalled();
  expect(ports.validate).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("completes a write task with no repository changes and preserves its structured task output", async () => {
  vi.stubEnv(
    "INPUT_TASK-OUTPUT-SCHEMA",
    '{"type":"object","properties":{"needsChange":{"type":"boolean"}},"required":["needsChange"],"additionalProperties":false}',
  );
  const result = readonlyWorkerResult("final");
  ports.runDsh.mockResolvedValue({
    ...result,
    output: { ...result.output, taskOutput: { needsChange: false } },
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "task",
    writeStatus: "no-changes",
    changedPaths: [],
    taskOutput: { needsChange: false },
    validation: { status: "not-applicable", commandCount: 0, integrity: { status: "clean" } },
  });
  expect(ports.validate).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("answers an Issue write task with no changes using a tracked comment instead of a PR", async () => {
  await selectEntity("task", "issue");
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("final"));
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    writeStatus: "no-changes",
    changedPaths: [],
    commentId: 901,
    validation: { status: "not-applicable", commandCount: 0 },
  });
  expect(published.comment).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ issue_number: 7 }),
  );
  expect(record(published.comment.mock.calls[0]?.[0]).body).toContain(
    "<!-- dsh-action:v1 kind=task -->",
  );
  expect(ports.validate).not.toHaveBeenCalled();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("retains confirmed review publication when a later checkpoint upload fails", async () => {
  await selectEntity("review", "pull_request");
  ports.runDsh.mockResolvedValue(reviewWorkerResult());
  const save = vi.fn(() =>
    Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
  );
  ports.session.mockResolvedValue({ restore: () => Promise.resolve(), save });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    publication: { selected: 2, inlinePublished: 1, summaryOnly: 1, failures: [] },
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(published.inline).toHaveBeenCalledOnce();
  expect(published.comment).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledOnce();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("retains an already published no-change answer when its Session checkpoint fails", async () => {
  await selectEntity("task", "issue");
  ports.runDsh.mockResolvedValue(readonlyWorkerResult("final"));
  ports.session.mockResolvedValue({
    restore: () => Promise.resolve(),
    save: () => Promise.reject(new SessionCheckpointError("artifact upload failed", "runtime")),
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "failure",
    operation: "task",
    commentId: 901,
    error: { code: "SESSION_CHECKPOINT", phase: "publication" },
  });
  expect(published.comment).toHaveBeenCalledOnce();
  for (const effect of Object.values(created)) expect(effect).not.toHaveBeenCalled();
});

it("implements an Issue through validation and projects its newly created PR", async () => {
  await selectEntity("implement", "issue");
  const run = ports.runDsh.getMockImplementation();
  ports.runDsh.mockImplementation(async (...args) => {
    if (run === undefined) throw new Error("Missing model adapter");
    const result = await run(...args);
    return { ...result, output: { ...result.output, operation: "implement" } };
  });
  const outcome = await runAction();
  expect(outcome).toMatchObject({
    conclusion: "success",
    operation: "implement",
    writeStatus: "success",
    pullRequestNumber: 123,
    pullRequestUrl: "https://github.com/octo/repo/pull/123",
    validation: { status: "passed", commandCount: 1 },
  });
  expect(created.blob).toHaveBeenCalledOnce();
  expect(created.commit).toHaveBeenCalledOnce();
  expect(created.branch).toHaveBeenCalledOnce();
  expect(created.pull).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ base: "main" }));
  expect(record(created.pull.mock.calls[0]?.[0]).body).toContain("#7");
  expect(created.updateBranch).not.toHaveBeenCalled();
  await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
});

it.each([false, true])(
  "projects a confirmed PR-head fix when final comment failure=%s",
  async (commentFails) => {
    await selectEntity("fix", "pull_request");
    const run = ports.runDsh.getMockImplementation();
    ports.runDsh.mockImplementation(async (...args) => {
      if (run === undefined) throw new Error("Missing model adapter");
      const result = await run(...args);
      return { ...result, output: { ...result.output, operation: "fix" } };
    });
    if (commentFails)
      published.comment.mockRejectedValue(new Error("Final status comment unavailable"));
    const outcome = await runAction();
    expect(outcome.error).toBeUndefined();
    expect(outcome).toMatchObject({
      conclusion: "success",
      operation: "fix",
      writeStatus: commentFails ? "partial-success" : "success",
      commitSha: commit,
      changedPaths: ["hello.txt"],
      validation: { status: "passed", commandCount: 1 },
    });
    expect(created.updateBranch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ ref: "heads/feature", sha: commit, force: false }),
    );
    expect(created.commit).toHaveBeenCalledOnce();
    expect(created.branch).not.toHaveBeenCalled();
    expect(created.pull).not.toHaveBeenCalled();
    expect(published.comment).toHaveBeenCalledOnce();
    await expect(readFile(join(workerPath, "hello.txt"))).rejects.toThrow();
  },
);
