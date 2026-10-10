import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type * as DshModule from "../src/dsh/runner.js";
import type * as GitHubClientModule from "../src/github/client.js";
import type * as ValidationModule from "../src/write/validate.js";
import { runAction } from "../src/orchestrator.js";
import { SessionCheckpointError } from "../src/session/errors.js";
import { githubClientFixture } from "./helpers/github-client.js";

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
const created = { blob: vi.fn(), commit: vi.fn(), branch: vi.fn(), pull: vi.fn() };
let fixtureRoot: string;
let permission = "write";
let workerPath: string;
let fixture: NonNullable<Parameters<typeof githubClientFixture>[0]>;

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
  const refs = new Map([["heads/main", base]]);
  fixture = {
    rest: {
      users: { getByUsername: () => Promise.resolve({ data: { type: "User" } }) },
      repos: { getCollaboratorPermissionLevel: () => Promise.resolve({ data: { permission } }) },
      git: {
        getRef: ({ ref }: { ref: string }) => {
          const sha = refs.get(ref);
          if (sha === undefined) throw Object.assign(new Error("not found"), { status: 404 });
          return Promise.resolve({ data: { object: { sha } } });
        },
        getCommit: () => Promise.resolve({ data: { sha: base, tree: { sha: tree } } }),
        getTree: () => Promise.resolve({ data: { sha: tree, truncated: false, tree: [] } }),
        createBlob: created.blob.mockResolvedValue({ data: { sha: "d".repeat(40) } }),
        createTree: () => Promise.resolve({ data: { sha: tree } }),
        createCommit: created.commit.mockResolvedValue({ data: { sha: commit } }),
        createRef: created.branch.mockImplementation(
          ({ ref, sha }: { ref: string; sha: string }) => {
            refs.set(ref.replace(/^refs\//u, ""), sha);
            return Promise.resolve({ data: {} });
          },
        ),
      },
      pulls: {
        list: () => Promise.resolve({ data: [] }),
        create: created.pull.mockResolvedValue({
          data: { number: 123, html_url: "https://github.com/octo/repo/pull/123" },
        }),
      },
    },
  };
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
