import type * as FsPromises from "node:fs/promises";
import type * as WriteGitModule from "../src/write/git.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  readdir: vi.fn(),
  requireGitSuccess: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  lstat: mocks.lstat,
  readdir: mocks.readdir,
}));

vi.mock("../src/write/git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof WriteGitModule>()),
  requireGitSuccess: mocks.requireGitSuccess,
}));

import { createWorkspaceSnapshot } from "../src/write/workspace.js";

const roots: string[] = [];

beforeEach(() => {
  vi.resetAllMocks();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryWorker(): Promise<{ readonly source: string; readonly worker: string }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-workspace-limit-"));
  roots.push(root);
  return { source: join(root, "source"), worker: join(root, "worker") };
}

describe("workspace source limits", () => {
  it("rejects an unknown source kind without consulting Git or the filesystem walker", async () => {
    const { source, worker } = await temporaryWorker();

    await expect(
      createWorkspaceSnapshot({ kind: "filesystem", root: source } as never, worker),
    ).rejects.toThrow("Unsupported workspace source kind: filesystem");
    expect(mocks.requireGitSuccess).not.toHaveBeenCalled();
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it("propagates Git failures without consulting the filesystem walker", async () => {
    const failure = new Error("git index is corrupt");
    mocks.requireGitSuccess.mockRejectedValue(failure);
    const { source, worker } = await temporaryWorker();

    await expect(
      createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker),
    ).rejects.toBe(failure);
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it("rejects truncated tracked-path output before copying repository files", async () => {
    mocks.requireGitSuccess.mockResolvedValue({
      exitCode: 0,
      stdout: "tracked.txt\0",
      stderr: "",
      timedOut: false,
      outputTruncated: true,
    });
    const { source, worker } = await temporaryWorker();

    await expect(
      createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker),
    ).rejects.toThrow("snapshot capture limit");
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it("enforces the tracked checkout file limit without falling back", async () => {
    mocks.requireGitSuccess.mockResolvedValue({
      exitCode: 0,
      stdout: `${Array.from({ length: 50_001 }, (_, index) => `file-${String(index)}`).join("\0")}\0`,
      stderr: "",
      timedOut: false,
      outputTruncated: false,
    });
    const { source, worker } = await temporaryWorker();

    await expect(
      createWorkspaceSnapshot({ kind: "git-checkout", root: source }, worker),
    ).rejects.toThrow("Repository exceeds snapshot file limit");
    expect(mocks.readdir).not.toHaveBeenCalled();
  });

  it("enforces the same file limit while walking a materialized tree", async () => {
    mocks.readdir.mockResolvedValue(
      Array.from({ length: 50_001 }, (_, index) => ({
        name: `file-${String(index)}`,
        isDirectory: () => false,
        isFile: () => true,
        isSymbolicLink: () => false,
      })),
    );
    const { source, worker } = await temporaryWorker();

    await expect(
      createWorkspaceSnapshot({ kind: "materialized-tree", root: source }, worker),
    ).rejects.toThrow("Repository exceeds snapshot file limit");
    expect(mocks.requireGitSuccess).not.toHaveBeenCalled();
  });

  it.each(["git-checkout", "materialized-tree"] as const)(
    "enforces the snapshot byte limit for a %s source",
    async (kind) => {
      const { source, worker } = await temporaryWorker();
      await mkdir(source);
      await writeFile(join(source, "huge.bin"), "bounded fixture");
      mocks.lstat.mockResolvedValue({
        isSymbolicLink: () => false,
        size: 1024 * 1024 * 1024 + 1,
      });
      if (kind === "git-checkout") {
        mocks.requireGitSuccess.mockResolvedValue({
          exitCode: 0,
          stdout: "huge.bin\0",
          stderr: "",
          timedOut: false,
          outputTruncated: false,
        });
      } else {
        mocks.readdir.mockResolvedValue([
          {
            name: "huge.bin",
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => false,
          },
        ]);
      }

      await expect(createWorkspaceSnapshot({ kind, root: source }, worker)).rejects.toThrow(
        "Repository exceeds snapshot byte limit",
      );
      if (kind === "git-checkout") expect(mocks.readdir).not.toHaveBeenCalled();
      else expect(mocks.requireGitSuccess).not.toHaveBeenCalled();
    },
  );
});
