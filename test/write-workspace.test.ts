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
    await writeFile(join(source, "untracked.txt"), "must not enter worker\n");
    const worker = join(source, "..", `worker-${String(Date.now())}`);
    roots.push(worker);
    const snapshot = await createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker);
    await expect(readFile(join(worker, ".git", "config"))).rejects.toThrow();
    await expect(readFile(join(worker, "untracked.txt"))).rejects.toThrow();
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
    const snapshot = await createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker);
    await mkdir(join(worker, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worker, "node_modules", "pkg", "index.js"), "generated");
    expect((await inspectWorkspaceChanges(snapshot)).all).toEqual([]);
  });

  it("copies an explicitly identified Controller-materialized tree without Git metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-materialized-tree-"));
    roots.push(root);
    const source = join(root, "source");
    const worker = join(root, "worker");
    await mkdir(join(source, "nested"), { recursive: true });
    await writeFile(join(source, "nested", "tracked.txt"), "materialized\n");

    const snapshot = await createWorkspaceSnapshot(
      { kind: "materialized-tree", root: source },
      worker,
    );

    expect(await readFile(join(worker, "nested", "tracked.txt"), "utf8")).toBe("materialized\n");
    expect([...snapshot.baseline.keys()]).toEqual(["nested/tracked.txt"]);
  });

  it("fails closed when a non-Git tree is declared as a Git checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-non-git-source-"));
    roots.push(root);
    const source = join(root, "source");
    const worker = join(root, "worker");
    await mkdir(source);
    await writeFile(join(source, "untracked.txt"), "must not enter worker\n");

    await expect(
      createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker),
    ).rejects.toThrow("git ls-files failed");
    await expect(readFile(join(worker, "untracked.txt"))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "rejects tracked Git symlinks before they enter a DSH workspace",
    async () => {
      const source = await repository();
      const worker = join(source, "..", `worker-symlink-${String(Date.now())}`);
      roots.push(worker);
      await symlink("tracked.txt", join(source, "tracked-link"));
      await requireGitSuccess(["add", "--", "tracked-link"], { cwd: source });

      await expect(
        createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker),
      ).rejects.toThrow("Symbolic links");
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects repository symlinks before they enter a DSH workspace",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "dsh-workspace-symlink-"));
      roots.push(root);
      const worker = join(root, "worker");
      await writeFile(join(root, "target"), "secret");
      await symlink("target", join(root, "link"));
      await expect(
        createWorkspaceSnapshot({ kind: "materialized-tree", root }, worker),
      ).rejects.toThrow("Symbolic links");
    },
  );
});
