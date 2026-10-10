import { vi } from "vitest";

/** External REST/pagination transport only; every Controller consumer stays real. */
export function actionLifecycleGitHub(options: {
  base: string;
  tree: string;
  commit: string;
  permission: () => string;
}) {
  const { base, tree, commit, permission } = options;
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
  const refs = new Map([
    ["heads/main", base],
    ["heads/feature", base],
  ]);
  const pullRequest = () => ({
    ...issue,
    draft: false,
    head: { sha: refs.get("heads/feature"), ref: "feature", repo: repository },
    base: { sha: base, ref: "main", repo: repository },
  });
  const created = {
    blob: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({ data: { sha: "d".repeat(40) } }),
    ),
    commit: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({ data: { sha: commit } }),
    ),
    branch: vi.fn(({ ref, sha }: { ref: string; sha: string }) => {
      refs.set(ref.replace(/^refs\//u, ""), sha);
      return Promise.resolve({ data: {} });
    }),
    pull: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({ data: { number: 123, html_url: "https://github.com/octo/repo/pull/123" } }),
    ),
    updateBranch: vi.fn(({ ref, sha }: { ref: string; sha: string }) => {
      refs.set(ref, sha);
      return Promise.resolve({ data: {} });
    }),
  };
  const published = {
    inline: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({ data: { id: 501 } }),
    ),
    comment: vi.fn<(...args: unknown[]) => Promise<unknown>>(() =>
      Promise.resolve({ data: { id: 901 } }),
    ),
  };
  const transport = {
    rest: {
      users: { getByUsername: () => Promise.resolve({ data: { type: "User" } }) },
      repos: {
        getCollaboratorPermissionLevel: () =>
          Promise.resolve({ data: { permission: permission() } }),
      },
      git: {
        getRef: ({ ref }: { ref: string }) => {
          const sha = refs.get(ref);
          if (sha === undefined) throw Object.assign(new Error("not found"), { status: 404 });
          return Promise.resolve({ data: { object: { sha } } });
        },
        getCommit: () => Promise.resolve({ data: { sha: base, tree: { sha: tree } } }),
        getTree: () => Promise.resolve({ data: { sha: tree, truncated: false, tree: [] } }),
        getBlob: () =>
          Promise.resolve({
            data: {
              content: Buffer.from("const value = 1;\nnew();\n").toString("base64"),
              encoding: "base64",
            },
          }),
        createBlob: created.blob,
        createTree: () => Promise.resolve({ data: { sha: tree } }),
        createCommit: created.commit,
        createRef: created.branch,
        updateRef: created.updateBranch,
      },
      pulls: {
        get: () => Promise.resolve({ data: pullRequest() }),
        list: () => Promise.resolve({ data: [] }),
        listFiles: () =>
          Promise.resolve({
            data: [
              {
                filename: "src/value.ts",
                status: "modified",
                additions: 1,
                deletions: 1,
                changes: 2,
                sha: "d".repeat(40),
                patch: "@@ -1,2 +1,2 @@\n const value = 1;\n-old();\n+new();",
              },
            ],
          }),
        listReviewComments: () => Promise.resolve({ data: [] }),
        createReviewComment: published.inline,
        create: created.pull,
      },
      issues: {
        get: () => Promise.resolve({ data: issue }),
        listComments: () => Promise.resolve({ data: [], headers: {} }),
        createComment: published.comment,
      },
      actions: {
        listWorkflowRunsForRepo: () =>
          Promise.resolve({ data: { workflow_runs: [], total_count: 0 } }),
      },
      checks: {
        listForRef: () =>
          Promise.resolve({
            data: {
              total_count: 1,
              check_runs: [
                {
                  name: "Required validation",
                  head_sha: base,
                  status: "completed",
                  conclusion: "failure",
                  details_url: "https://github.com/octo/repo/actions/runs/88",
                  output: { summary: "FAILED_CHECK_MARKER" },
                },
              ],
            },
          }),
      },
    },
    paginate: () => Promise.resolve([]),
  };
  return { transport, created, published };
}
