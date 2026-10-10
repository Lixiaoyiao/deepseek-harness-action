import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { vi } from "vitest";

import { finishFix, type FinishFixInput } from "../../src/commands/fix.js";
import {
  finishImplementation,
  type FinishImplementationInput,
} from "../../src/commands/implement.js";
import { finishAutomationTask, type FinishAutomationTaskInput } from "../../src/commands/task.js";
import type { DshRunResult } from "../../src/dsh/runner.js";
import { PolicyDeniedError } from "../../src/errors.js";
import type { GitHubClient } from "../../src/github/client.js";
import { issueContentFingerprint } from "../../src/github/issue-identity.js";
import type { CommandResult } from "../../src/security/argv.js";
import { createWorkspaceSnapshot } from "../../src/write/workspace.js";
import { inputs } from "../helpers.js";

export const baseSha = "a".repeat(40);
export const commitSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const roots: string[] = [];
export const successfulValidation: CommandResult = {
  exitCode: 0,
  stdout: "passed",
  stderr: "",
  timedOut: false,
  outputTruncated: false,
};
const issue = {
  number: 7,
  title: "Add a parser",
  body: "Keep existing behavior",
  state: "open",
  user: { id: 101 },
};
export const issueIdentity = {
  state: "open",
  updatedAt: "2026-10-10T00:00:00Z",
  contentFingerprint: issueContentFingerprint({ ...issue, authorId: issue.user.id }),
};

export async function cleanupWriteFixtures(): Promise<void> {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

export function agentResult(
  operation: "task" | "fix" | "implement",
  summary = "Implemented safely",
): DshRunResult {
  return {
    output: {
      protocolVersion: 1,
      operation,
      state: "final",
      summary,
      findings: [],
    },
    durationMs: 1,
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
}

/** Real finalizers and local snapshots; only the Octokit transport is simulated. */
export async function writeFixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-transaction-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await writeFile(join(source, "parser.ts"), "export const value = 1;\n");
  const snapshot = await createWorkspaceSnapshot(
    { kind: "materialized-tree", root: source },
    join(root, "worker"),
  );
  await writeFile(join(snapshot.workerRoot, "parser.ts"), "export const value = 2;\n");
  const effects: string[] = [];
  const comments: string[] = [];
  const refs = new Map([
    ["main", baseSha],
    ["feature", baseSha],
  ]);
  const commits = new Map([
    [
      baseSha,
      {
        sha: baseSha,
        parents: [] as { sha: string }[],
        message: "base",
        tree: { sha: "b".repeat(40) },
      },
    ],
  ]);
  const pulls: {
    number: number;
    html_url: string;
    state: string;
    title: string;
    body: string;
    head: { ref: string; sha: string; repo: { id: number; full_name: string } };
    base: { ref: string; repo: { id: number; full_name: string } };
  }[] = [];
  let permission: "write" | "read" = "write";
  const revalidateAuthority = vi.fn(() => {
    if (permission !== "write")
      throw new PolicyDeniedError("Current actor no longer has write authority");
    return Promise.resolve();
  });
  const onValidationPassed = vi.fn();
  const api = {
    paginate: vi.fn(() => Promise.resolve([])),
    rest: {
      issues: {
        get: vi.fn(() => Promise.resolve({ data: issue })),
        listComments: vi.fn(() => Promise.resolve({ data: [] })),
        createComment: vi.fn(({ body }: { body: string }) => {
          effects.push("comment");
          comments.push(body);
          return Promise.resolve({ data: { id: 8 } });
        }),
      },
      pulls: {
        get: vi.fn(() =>
          Promise.resolve({
            data: {
              number: 7,
              state: "open",
              head: { ref: "feature", sha: refs.get("feature"), repo: { id: 1 } },
              base: { repo: { id: 1 } },
            },
          }),
        ),
        list: vi.fn(() => Promise.resolve({ data: pulls })),
        create: vi.fn((request: { head: string; base: string; title: string; body: string }) => {
          effects.push("pull_request");
          const pull = {
            number: 9,
            html_url: "https://github.com/o/r/pull/9",
            state: "open",
            title: request.title,
            body: request.body,
            head: {
              ref: request.head,
              sha: refs.get(request.head) ?? "",
              repo: { id: 1, full_name: "o/r" },
            },
            base: { ref: request.base, repo: { id: 1, full_name: "o/r" } },
          };
          pulls.push(pull);
          return Promise.resolve({ data: pull });
        }),
      },
      git: {
        getRef: vi.fn(({ ref }: { ref: string }) => {
          const sha = refs.get(ref.replace(/^heads\//u, ""));
          if (sha === undefined) throw Object.assign(new Error("Not found"), { status: 404 });
          return Promise.resolve({ data: { object: { sha } } });
        }),
        getCommit: vi.fn(({ commit_sha }: { commit_sha: string }) => {
          const commit = commits.get(commit_sha);
          if (commit === undefined) throw new Error("Unknown commit");
          return Promise.resolve({ data: commit });
        }),
        createBlob: vi.fn(() => {
          effects.push("blob");
          return Promise.resolve({ data: { sha: "e".repeat(40) } });
        }),
        createTree: vi.fn(() => {
          effects.push("tree");
          return Promise.resolve({ data: { sha: treeSha } });
        }),
        createCommit: vi.fn((request: { message: string; tree: string; parents: string[] }) => {
          effects.push("commit");
          commits.set(commitSha, {
            sha: commitSha,
            parents: request.parents.map((sha) => ({ sha })),
            message: request.message,
            tree: { sha: request.tree },
          });
          return Promise.resolve({ data: { sha: commitSha } });
        }),
        createRef: vi.fn((request: { ref: string; sha: string }) => {
          effects.push("create_ref");
          refs.set(request.ref.replace(/^refs\/heads\//u, ""), request.sha);
          return Promise.resolve({ data: {} });
        }),
        updateRef: vi.fn((request: { ref: string; sha: string }) => {
          effects.push("update_ref");
          refs.set(request.ref.replace(/^heads\//u, ""), request.sha);
          return Promise.resolve({ data: {} });
        }),
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- This Octokit boundary adapter implements only the REST routes exercised by the public write finalizers.
  const client = api as unknown as GitHubClient;
  const common = {
    client,
    owner: "o",
    repo: "r",
    baseBranch: "main",
    boundHeadSha: baseSha,
    snapshot,
    revalidateAuthority,
    onValidationPassed,
    validationDeadlineMs: Date.now() + 30_000,
  };
  return {
    api,
    client,
    snapshot,
    effects,
    comments,
    refs,
    pulls,
    commits,
    revalidateAuthority,
    onValidationPassed,
    revoke: () => {
      permission = "read";
    },
    task: (overrides: Partial<FinishAutomationTaskInput> = {}) =>
      finishAutomationTask({
        ...common,
        runIdentity: "10",
        taskIdentity: "task-identity",
        result: agentResult("task"),
        runUrl: "https://github.com/o/r/actions/runs/10",
        runTests: true,
        testCommands: [["npm", "test"]],
        containerImage: inputs().containerImage,
        ...overrides,
      }),
    implement: (overrides: Partial<FinishImplementationInput> = {}) =>
      finishImplementation({
        ...common,
        issueNumber: 7,
        issueTitle: issue.title,
        issueIdentity,
        operationKey: "10",
        result: agentResult("implement"),
        inputs: inputs({ testCommands: [["npm", "test"]] }),
        ...overrides,
      }),
    fix: (overrides: Partial<FinishFixInput> = {}) =>
      finishFix({
        ...common,
        target: { owner: "o", repo: "r", issueNumber: 7 },
        expectedAuthorId: 41898282,
        identity: {
          headSha: baseSha,
          headRef: "feature",
          headRepositoryId: 1,
          baseRepositoryId: 1,
        },
        result: agentResult("fix"),
        inputs: inputs({ testCommands: [["npm", "test"]] }),
        runUrl: "https://github.com/o/r/actions/runs/10",
        ...overrides,
      }),
  };
}
