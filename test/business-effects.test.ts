import { z } from "zod";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

const moduleUrl = new URL("../.github/e2e/assert-business-effects.mjs", import.meta.url).href;
const oldHead = "a".repeat(40);
const base = "b".repeat(40);
const head = "c".repeat(40);
const blobSha = "d".repeat(40);
const candidate = "e".repeat(40);
const path = ".github/dsh-e2e-fixtures/checks-10-1.txt";
const key = createHash("sha256")
  .update(["lixiaoyiao", "deepseek-harness-action", "20", "10"].join("\0"))
  .digest("hex")
  .slice(0, 24);
const snapshot = "f".repeat(24);
const implementationBranch = `dsh-e2e/implement-20-${key}`;
const environment = {
  REPOSITORY: "Lixiaoyiao/deepseek-harness-action",
  GITHUB_RUN_ID: "10",
  GITHUB_RUN_ATTEMPT: "1",
  ISSUE_NUMBER: "20",
  CHECKS_PR: "30",
  CHECKS_PR_ID: "300",
  CHECKS_HEAD: oldHead,
  CHECKS_BASE_SHA: base,
  CANDIDATE_SHA: candidate,
  FIXED_HEAD: head,
  CHECKS_BASE_BRANCH: "dsh-e2e/checks-base-10-1",
  FIXTURE_PATH: path,
};
const repo = { id: 1, full_name: environment.REPOSITORY };
const pull = {
  number: 30,
  id: 300,
  user: { id: 41898282 },
  state: "open",
  draft: true,
  head: { repo, ref: "dsh-e2e/checks-10-1", sha: head },
  base: { repo, ref: environment.CHECKS_BASE_BRANCH, sha: base },
  body: `<!-- dsh-e2e:github-integration:v1 run=10 attempt=1 candidate=${candidate} -->`,
};
const implementationPull = {
  ...pull,
  number: 40,
  id: 400,
  draft: false,
  head: { repo, ref: implementationBranch, sha: head },
  body: `<!-- dsh-action:implement:v1 operation=${key} snapshot=${snapshot} -->\nCloses #20`,
};
const ref = { ref: `refs/heads/${implementationBranch}`, object: { type: "commit", sha: head } };
const commit = {
  sha: head,
  parents: [{ sha: base }],
  message: `feat: implement #20\n\nDSH-Operation-Key: ${key}\nDSH-Issue-Snapshot: ${snapshot}`,
};
interface Reply {
  status: number;
  value?: unknown;
}
const ok = (value: unknown): Reply => ({ status: 200, value });
const fileReplies = (parent: string, filename: string, status: string, content: string) => [
  ok({
    total_commits: 1,
    base_commit: { sha: parent },
    files: [{ filename, status, sha: blobSha }],
  }),
  ok({ sha: blobSha, encoding: "base64", content: Buffer.from(content).toString("base64") }),
];
const implementationReplies = () => [
  ok(ref),
  ok([implementationPull]),
  ok(commit),
  ok(commit),
  ...fileReplies(base, "dsh-e2e-implementation-10-1.txt", "added", "DSH E2E implemented 10/1\n"),
];

function invoke(mode: string, replies: Reply[], env: Record<string, string> = environment) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from "node:fs";
    const { assertBusinessEffects } = await import(process.argv[1]);
    const input = JSON.parse(readFileSync(0,"utf8"));
    const requests = []; let result; let error;
    try { result = await assertBusinessEffects(input.mode,input.environment,async(method,path,body) => {
      requests.push({method,path,body});
      const response = input.replies.shift();
      if (!response) throw new Error("Unscripted request");
      return response;
    }); } catch (failure) { error = failure.message; }
    process.stdout.write(JSON.stringify({result,error,requests,remaining:input.replies.length}));
  `,
      moduleUrl,
    ],
    { input: JSON.stringify({ mode, replies, environment: env }), encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return z
    .looseObject({
      result: z
        .looseObject({
          mode: z.string(),
          head: z.string().optional(),
          pull: z.number().optional(),
          absent: z.boolean().optional(),
        })
        .optional(),
      error: z.string().optional(),
      requests: z.array(
        z.looseObject({ method: z.string(), path: z.string(), body: z.unknown().optional() }),
      ),
      remaining: z.number(),
    })
    .parse(JSON.parse(result.stdout));
}

describe("trusted business effect and cleanup assertions", () => {
  it("proves a fix from exact PR identity, one child commit and remote bytes", () => {
    const result = invoke("fix", [
      ok(pull),
      ok({ sha: head, parents: [{ sha: oldHead }], message: "fix: apply DeepSeek Harness fix" }),
      ...fileReplies(oldHead, path, "modified", "DSH E2E fixed 10/1\n"),
    ]);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ mode: "fix", head, pull: 30 });
    expect(result.requests.every((request) => request.method === "GET")).toBe(true);
    expect(result.remaining).toBe(0);
  });

  it("proves Issue -> PR with matching branch, base, trailers, marker and file", () => {
    const result = invoke("implement", implementationReplies());
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ mode: "implement", head, pull: 40 });
    expect(result.remaining).toBe(0);
  });

  it("cleans a verified implementation PR and exact ref with one write per effect", () => {
    const result = invoke("cleanup-implement", [
      ...implementationReplies(),
      ok(implementationPull),
      ok({}),
      ok({ ...implementationPull, state: "closed" }),
      ok(ref),
      { status: 204 },
      { status: 404 },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.requests.filter((request) => request.method !== "GET")).toEqual([
      { method: "PATCH", path: "pulls/40", body: { state: "closed" } },
      { method: "DELETE", path: `git/refs/heads/${implementationBranch}` },
    ]);
    expect(result.remaining).toBe(0);
  });

  it("cleans an owned orphan branch after a partial PR-creation failure", () => {
    const responses = implementationReplies();
    responses[1] = ok([]);
    const result = invoke("cleanup-implement", [
      ...responses,
      ok(ref),
      { status: 204 },
      { status: 404 },
    ]);
    expect(result.error).toBeUndefined();
    expect(result.requests.filter((request) => request.method !== "GET")).toEqual([
      { method: "DELETE", path: `git/refs/heads/${implementationBranch}` },
    ]);
  });

  it.each(["repository", "parent", "marker", "files", "bytes"])(
    "rejects changed %s before cleanup writes",
    (field) => {
      const responses = implementationReplies();
      if (field === "repository")
        responses[1] = ok([
          {
            ...implementationPull,
            head: { ...implementationPull.head, repo: { ...repo, full_name: "other/repo" } },
          },
        ]);
      if (field === "parent") responses[3] = ok({ ...commit, parents: [{ sha: candidate }] });
      if (field === "marker")
        responses[1] = ok([{ ...implementationPull, body: "unowned pull request" }]);
      if (field === "files")
        responses[4] = ok({ total_commits: 1, base_commit: { sha: base }, files: [] });
      if (field === "bytes")
        responses[5] = ok({
          sha: blobSha,
          encoding: "base64",
          content: Buffer.from("different").toString("base64"),
        });
      const result = invoke("cleanup-implement", responses);
      expect(result.error).toBeTruthy();
      expect(result.requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it("never deletes a ref that moves after the PR was closed", () => {
    const result = invoke("cleanup-implement", [
      ...implementationReplies(),
      ok(implementationPull),
      ok({}),
      ok({ ...implementationPull, state: "closed" }),
      ok({ ...ref, object: { ...ref.object, sha: candidate } }),
    ]);
    expect(result.error).toBeTruthy();
    expect(result.requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it.each(["head", "base", "id", "marker"])(
    "revalidates the implementation PR %s immediately before closing",
    (field) => {
      const changed = {
        ...implementationPull,
        ...(field === "head" ? { head: { ...implementationPull.head, sha: candidate } } : {}),
        ...(field === "base" ? { base: { ...implementationPull.base, ref: "main" } } : {}),
        ...(field === "id" ? { id: 999 } : {}),
        ...(field === "marker" ? { body: "unrelated content" } : {}),
      };
      const result = invoke("cleanup-implement", [...implementationReplies(), ok(changed)]);
      expect(result.error).toBeTruthy();
      expect(result.requests.every((request) => request.method === "GET")).toBe(true);
    },
  );

  it("does not reinterpret authentication failure as absence or retry a refused delete", () => {
    const absent = invoke("cleanup-implement", [{ status: 403 }]);
    expect(absent.error).toBeTruthy();
    expect(absent.requests).toHaveLength(1);
    const refused = invoke("cleanup-implement", [
      ...implementationReplies(),
      ok(implementationPull),
      ok({}),
      ok({ ...implementationPull, state: "closed" }),
      ok(ref),
      { status: 403 },
    ]);
    expect(refused.error).toBeTruthy();
    expect(refused.requests.filter((request) => request.method === "DELETE")).toHaveLength(1);
  });

  it("rejects main or unrelated branch cleanup before any API request", () => {
    const result = invoke("cleanup-implement", [], {
      ...environment,
      IMPLEMENTATION_BRANCH: "main",
    });
    expect(result.error).toBeTruthy();
    expect(result.requests).toEqual([]);
    expect(invoke("cleanup-implement", [{ status: 404 }, ok([])]).result).toEqual({
      mode: "cleanup-implement",
      absent: true,
    });
  });
});
