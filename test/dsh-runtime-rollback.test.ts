import { join } from "node:path";
import type * as FsPromises from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  mkdir: filesystem.mkdir,
  mkdtemp: filesystem.mkdtemp,
  rm: filesystem.rm,
}));

import { createDshRuntime } from "../src/dsh/runtime.js";

describe("DSH runtime creation rollback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("removes a partially initialized root after a directory creation failure", async () => {
    const temporaryDirectory = join("C:\\", "runner-temp");
    const root = join(temporaryDirectory, "dsh-action-partial");
    const failure = new Error("mkdir failed");
    filesystem.mkdtemp.mockResolvedValue(root);
    filesystem.mkdir.mockImplementation((path: string) =>
      path.endsWith("npm-cache") ? Promise.reject(failure) : Promise.resolve(undefined),
    );
    filesystem.rm.mockResolvedValue(undefined);

    await expect(createDshRuntime(temporaryDirectory)).rejects.toBe(failure);
    expect(filesystem.mkdir).toHaveBeenCalledTimes(5);
    expect(filesystem.rm).toHaveBeenCalledWith(root, { force: true, recursive: true });
  });
});
