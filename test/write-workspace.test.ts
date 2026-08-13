import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { requireGitSuccess } from "../src/write/git.js";
import {
  applyWorkspaceChanges,
  createWorkspaceSnapshot,
  inspectWorkspaceChanges,
} from "../src/write/workspace.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function repository(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-workspace-test-"));
  roots.push(root);
  await requireGitSuccess(["init", "-b", "main"], { cwd: root });
  await writeFile(join(root, "tracked.txt"), "old\n");
  await requireGitSuccess(["add", "--", "tracked.txt"], { cwd: root });
  return root;
}

describe("trusted write workspace", () => {
  it("copies tracked files without .git and reports exact actual changes", async () => {
    const source = await repository();
    const worker = join(source, "..", `worker-${String(Date.now())}`);
    roots.push(worker);
    const snapshot = await createWorkspaceSnapshot(source, worker);
    await expect(readFile(join(worker, ".git", "config"))).rejects.toThrow();
    await writeFile(join(worker, "tracked.txt"), "new\n");
    await writeFile(join(worker, "added.txt"), "added\n");
    const changes = await inspectWorkspaceChanges(snapshot);
    expect(changes).toMatchObject({ added: ["added.txt"], modified: ["tracked.txt"], deleted: [] });
    await applyWorkspaceChanges(snapshot, changes);
    expect(await readFile(join(source, "tracked.txt"), "utf8")).toBe("new\n");
    expect(await readFile(join(source, "added.txt"), "utf8")).toBe("added\n");
  });

  it("ignores generated node_modules from the worker output", async () => {
    const source = await repository();
    const worker = join(source, "..", `worker-${String(Date.now())}`);
    roots.push(worker);
    const snapshot = await createWorkspaceSnapshot(source, worker);
    await mkdir(join(worker, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worker, "node_modules", "pkg", "index.js"), "generated");
    expect((await inspectWorkspaceChanges(snapshot)).all).toEqual([]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects repository symlinks before they enter a DSH workspace",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dsh-workspace-symlink-"));
      roots.push(root);
      const worker = join(root, "worker");
      await writeFile(join(root, "target"), "secret");
      await symlink("target", join(root, "link"));
      await expect(createWorkspaceSnapshot(root, worker)).rejects.toThrow("Symbolic links");
    },
  );
});
