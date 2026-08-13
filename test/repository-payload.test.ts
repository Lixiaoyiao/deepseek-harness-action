import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GitHubClient } from "../src/github/client.js";
import { isFailedWorkflowRun, readEventPayload } from "../src/github/payload.js";
import { materializeRepositoryAtSha } from "../src/github/repository.js";

const roots: string[] = [];
const commitSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const blobSha = "c".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function api(entries: unknown[], content = "content\n") {
  return {
    rest: {
      git: {
        getCommit: vi.fn().mockResolvedValue({ data: { sha: commitSha, tree: { sha: treeSha } } }),
        getTree: vi
          .fn()
          .mockResolvedValue({ data: { sha: treeSha, truncated: false, tree: entries } }),
        getBlob: vi.fn().mockResolvedValue({
          data: {
            sha: blobSha,
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          },
        }),
      },
    },
  } as unknown as GitHubClient;
}

describe("immutable repository materialization", () => {
  it("writes only validated regular blobs and preserves executable mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-materialize-"));
    roots.push(root);
    const output = join(root, "repository");
    const client = api([
      { path: "bin", type: "tree", mode: "040000", sha: "d".repeat(40) },
      { path: "bin/run.js", type: "blob", mode: "100755", sha: blobSha, size: 8 },
    ]);
    const result = await materializeRepositoryAtSha(client, "o", "r", commitSha, output);
    expect(result).toEqual({ root: output, sha: commitSha, files: 1, bytes: 8 });
    expect(await readFile(join(output, "bin", "run.js"), "utf8")).toBe("content\n");
    if (process.platform !== "win32") {
      expect((await stat(join(output, "bin", "run.js"))).mode & 0o111).not.toBe(0);
    }
  });

  it.each([
    ["path escape", { path: "../secret", type: "blob", mode: "100644", sha: blobSha, size: 8 }],
    ["symlink mode", { path: "link", type: "blob", mode: "120000", sha: blobSha, size: 8 }],
    ["submodule", { path: "vendor", type: "commit", mode: "160000", sha: blobSha }],
  ])("rejects %s entries", async (_label, entry) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-materialize-bad-"));
    roots.push(root);
    await expect(
      materializeRepositoryAtSha(api([entry]), "o", "r", commitSha, join(root, "repository")),
    ).rejects.toThrow();
  });

  it("rejects duplicate and file/child path conflicts before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-materialize-conflict-"));
    roots.push(root);
    const duplicate = { path: "a", type: "blob", mode: "100644", sha: blobSha, size: 8 };
    await expect(
      materializeRepositoryAtSha(
        api([duplicate, duplicate]),
        "o",
        "r",
        commitSha,
        join(root, "duplicate"),
      ),
    ).rejects.toThrow("Duplicate");
    await expect(
      materializeRepositoryAtSha(
        api([duplicate, { ...duplicate, path: "a/child" }]),
        "o",
        "r",
        commitSha,
        join(root, "conflict"),
      ),
    ).rejects.toThrow("parent file");
  });

  it("rejects API identity drift, truncation, and malformed blob data", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-materialize-identity-"));
    roots.push(root);
    const entry = { path: "file", type: "blob", mode: "100644", sha: blobSha, size: 8 };
    const wrongCommit = api([entry]);
    vi.mocked(wrongCommit.rest.git.getCommit).mockResolvedValueOnce({
      data: { sha: "f".repeat(40), tree: { sha: treeSha } },
    } as never);
    await expect(
      materializeRepositoryAtSha(wrongCommit, "o", "r", commitSha, join(root, "wrong")),
    ).rejects.toThrow("different commit");

    const truncated = api([entry]);
    vi.mocked(truncated.rest.git.getTree).mockResolvedValueOnce({
      data: { sha: treeSha, truncated: true, tree: [entry] },
    } as never);
    await expect(
      materializeRepositoryAtSha(truncated, "o", "r", commitSha, join(root, "truncated")),
    ).rejects.toThrow("truncated");

    const malformed = api([entry]);
    vi.mocked(malformed.rest.git.getBlob).mockResolvedValueOnce({
      data: { sha: blobSha, encoding: "base64", content: "***=" },
    } as never);
    await expect(
      materializeRepositoryAtSha(malformed, "o", "r", commitSha, join(root, "malformed")),
    ).rejects.toThrow("valid base64");
  });
});

describe("event payload boundary", () => {
  it("reads bounded UTF-8 JSON and classifies only actionable failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-payload-"));
    roots.push(root);
    const path = join(root, "event.json");
    await writeFile(path, JSON.stringify({ workflow_run: { conclusion: "timed_out" } }));
    const payload = await readEventPayload(path);
    expect(isFailedWorkflowRun(payload)).toBe(true);
    expect(isFailedWorkflowRun({ workflow_run: { conclusion: "failure" } })).toBe(true);
    expect(isFailedWorkflowRun({ workflow_run: { conclusion: "success" } })).toBe(false);
    expect(isFailedWorkflowRun({})).toBe(false);
  });

  it("rejects missing, invalid JSON, invalid UTF-8, directories, and oversized files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-payload-bad-"));
    roots.push(root);
    await expect(readEventPayload(undefined)).rejects.toThrow("missing");
    await expect(readEventPayload(root)).rejects.toThrow("regular file");
    const invalid = join(root, "invalid.json");
    await writeFile(invalid, "{");
    await expect(readEventPayload(invalid)).rejects.toThrow("valid JSON");
    const utf8 = join(root, "utf8.json");
    await writeFile(utf8, Buffer.from([0xff, 0xfe]));
    await expect(readEventPayload(utf8)).rejects.toThrow("valid UTF-8");
    const huge = join(root, "huge.json");
    await writeFile(huge, Buffer.alloc(10 * 1024 * 1024 + 1, 0x20));
    await expect(readEventPayload(huge)).rejects.toThrow("exceeds 10 MiB");
  });
});
