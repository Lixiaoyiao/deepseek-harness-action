import { mkdtemp, mkdir } from "node:fs/promises";
import type * as FsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { lstatMock } = vi.hoisted(() => ({ lstatMock: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  lstat: lstatMock,
}));

import { assertPathWithin } from "../src/security/paths.js";

const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");

function filesystemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

describe("path containment filesystem errors", () => {
  beforeEach(() => {
    lstatMock.mockReset();
    lstatMock.mockImplementation(actualFs.lstat);
  });

  it.each(["ENOENT", "ENOTDIR"])("searches the existing ancestor after %s", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-path-missing-"));
    await mkdir(join(root, "src"));
    lstatMock.mockRejectedValueOnce(filesystemError(code));

    await expect(assertPathWithin(root, "src/new.ts")).resolves.toBe(join(root, "src", "new.ts"));
    expect(lstatMock).toHaveBeenCalledTimes(2);
  });

  it.each(["EACCES", "EPERM", "EIO"])("fails closed on lstat %s", async (code) => {
    const root = await mkdtemp(join(tmpdir(), "dsh-path-error-"));
    await mkdir(join(root, "src"));
    lstatMock.mockRejectedValueOnce(filesystemError(code));

    await expect(assertPathWithin(root, "src/new.ts")).rejects.toMatchObject({ code });
    expect(lstatMock).toHaveBeenCalledTimes(1);
  });
});
