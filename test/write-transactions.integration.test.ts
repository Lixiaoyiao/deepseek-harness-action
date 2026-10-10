import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CommandTransport from "../src/security/argv.js";
import {
  baseSha,
  commitSha,
  cleanupWriteFixtures,
  successfulValidation as success,
  writeFixture,
} from "./helpers/repository-write.js";

const processTransport = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof CommandTransport>()),
  runCommand: processTransport.run,
}));

beforeEach(() => {
  processTransport.run.mockReset();
  processTransport.run.mockResolvedValue(success);
});
afterEach(cleanupWriteFixtures);

describe("complete Controller write transactions", () => {
  it("creates no task effects when the actor loses authority during validation", async () => {
    const fixture = await writeFixture();
    processTransport.run.mockImplementation(() => {
      fixture.revoke();
      return Promise.resolve(success);
    });
    await expect(fixture.task()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(fixture.effects).toEqual([]);
  });
  it("creates no implementation effects when the actor loses authority during validation", async () => {
    const fixture = await writeFixture();
    processTransport.run.mockImplementation(() => {
      fixture.revoke();
      return Promise.resolve(success);
    });
    await expect(fixture.implement()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(fixture.effects).toEqual([]);
  });
  it("does not advance the PR head when the actor loses authority during validation", async () => {
    const fixture = await writeFixture();
    processTransport.run.mockImplementation(() => {
      fixture.revoke();
      return Promise.resolve(success);
    });
    await expect(fixture.fix()).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(fixture.effects).toEqual([]);
    expect(fixture.refs.get("feature")).toBe(baseSha);
  });
  it.each(["task", "implement"] as const)(
    "publishes one owned %s PR and recognizes its completed operation",
    async (operation) => {
      const fixture = await writeFixture();
      const first = await fixture[operation]();
      expect(first.pullNumber).toBe(9);
      expect(fixture.refs.get("main")).toBe(baseSha);
      expect(fixture.refs.get(first.branch)).toBe(commitSha);
      expect(fixture.pulls[0]?.body).toContain(
        operation === "implement" ? "Closes #7" : "Validation: configured commands passed.",
      );
      const effects = [...fixture.effects];
      expect(effects).toEqual(["blob", "tree", "commit", "create_ref", "pull_request"]);
      await expect(fixture[operation]()).resolves.toEqual(first);
      expect(fixture.effects).toEqual(effects);
      expect(fixture.onValidationPassed).toHaveBeenCalledTimes(2);
    },
  );
  it("updates only the bound PR head without creating a new branch or pull request", async () => {
    const fixture = await writeFixture();
    await expect(fixture.fix()).resolves.toMatchObject({ commitSha, status: "success" });
    expect(fixture.refs.get("feature")).toBe(commitSha);
    expect(fixture.refs.get("main")).toBe(baseSha);
    expect(fixture.effects).toEqual(["blob", "tree", "commit", "update_ref", "comment"]);
    expect(fixture.pulls).toEqual([]);
  });
  it.each(["task", "implement", "fix"] as const)(
    "leaves GitHub untouched after real %s validation fails",
    async (operation) => {
      const fixture = await writeFixture();
      processTransport.run.mockResolvedValue({ ...success, exitCode: 1, stderr: "test failed" });
      await expect(fixture[operation]()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect(fixture.effects).toEqual([]);
      expect(fixture.revalidateAuthority).not.toHaveBeenCalled();
    },
  );
  it.each(["task", "implement"] as const)(
    "reuses an owned %s orphan without repeating the branch mutation",
    async (operation) => {
      const fixture = await writeFixture();
      const first = await fixture[operation]();
      fixture.pulls.splice(0);
      const effects = fixture.effects.length;
      await expect(fixture[operation]()).resolves.toEqual(first);
      expect(fixture.effects.slice(effects)).toEqual(["blob", "tree", "commit", "pull_request"]);
      expect(fixture.refs.get(first.branch)).toBe(commitSha);
    },
  );
  it.each(["task", "implement"] as const)(
    "rejects a different %s orphan tree before any ref or PR mutation",
    async (operation) => {
      const fixture = await writeFixture();
      const first = await fixture[operation]();
      fixture.pulls.splice(0);
      const owned = fixture.commits.get(commitSha);
      if (owned === undefined) throw new Error("Fixture did not publish its owned commit");
      const orphanSha = "f".repeat(40);
      fixture.commits.set(orphanSha, { ...owned, sha: orphanSha, tree: { sha: "0".repeat(40) } });
      fixture.refs.set(first.branch, orphanSha);
      const effects = fixture.effects.length;
      await expect(fixture[operation]()).rejects.toMatchObject({ code: "ENTITY_BINDING_CHANGED" });
      expect(fixture.refs.get(first.branch)).toBe(orphanSha);
      expect(fixture.effects.slice(effects)).toEqual(["blob", "tree", "commit"]);
      expect(fixture.pulls).toEqual([]);
    },
  );
  it.each(["task", "implement"] as const)(
    "rejects a forged completed %s ownership marker before validation or effects",
    async (operation) => {
      const fixture = await writeFixture();
      await fixture[operation]();
      const owned = fixture.commits.get(commitSha);
      if (owned === undefined) throw new Error("Fixture did not publish its owned commit");
      fixture.commits.set(commitSha, { ...owned, message: "Unowned commit" });
      const effects = [...fixture.effects];
      processTransport.run.mockClear();
      await expect(fixture[operation]()).rejects.toMatchObject({ code: "ENTITY_BINDING_CHANGED" });
      expect(fixture.effects).toEqual(effects);
      expect(processTransport.run).not.toHaveBeenCalled();
    },
  );
  it.each(["task", "implement"] as const)(
    "reconciles lost %s branch and PR responses without repeating either mutation",
    async (operation) => {
      const fixture = await writeFixture();
      const createRef = fixture.api.rest.git.createRef.getMockImplementation();
      const createPull = fixture.api.rest.pulls.create.getMockImplementation();
      if (createRef === undefined || createPull === undefined)
        throw new Error("Missing GitHub write transport fixture");
      fixture.api.rest.git.createRef.mockImplementationOnce(async (request) => {
        await createRef(request);
        throw new Error("Branch response lost");
      });
      fixture.api.rest.pulls.create.mockImplementationOnce(async (request) => {
        await createPull(request);
        throw new Error("PR response lost");
      });
      const finished = await fixture[operation]();
      expect(finished.pullNumber).toBe(9);
      expect(fixture.refs.get(finished.branch)).toBe(commitSha);
      expect(fixture.api.rest.git.createRef).toHaveBeenCalledOnce();
      expect(fixture.api.rest.pulls.create).toHaveBeenCalledOnce();
    },
  );
  it("finishes exact PR-head reconciliation when cancellation races an accepted update", async () => {
    const fixture = await writeFixture();
    const controller = new AbortController();
    const updateRef = fixture.api.rest.git.updateRef.getMockImplementation();
    if (updateRef === undefined) throw new Error("Missing GitHub update transport fixture");
    fixture.api.rest.git.updateRef.mockImplementationOnce(async (request) => {
      await updateRef(request);
      controller.abort(new Error("Run cancelled after GitHub accepted the write"));
      throw new Error("Update response lost");
    });
    await expect(fixture.fix({ signal: controller.signal })).resolves.toMatchObject({
      commitSha,
      status: "success",
    });
    expect(fixture.refs.get("feature")).toBe(commitSha);
    expect(fixture.api.rest.git.updateRef).toHaveBeenCalledOnce();
  });
  it("rejects a raced stable-branch collision as a nonretryable binding change", async () => {
    const fixture = await writeFixture();
    const collision = new Error("Branch create response rejected");
    const otherSha = "f".repeat(40);
    fixture.api.rest.git.createRef.mockImplementationOnce((request) => {
      fixture.refs.set(request.ref.replace(/^refs\/heads\//u, ""), otherSha);
      return Promise.reject(collision);
    });
    await expect(fixture.task()).rejects.toMatchObject({
      code: "ENTITY_BINDING_CHANGED",
      category: "domain",
      retryable: false,
      cause: collision,
    });
    expect(fixture.api.rest.git.createRef).toHaveBeenCalledOnce();
    expect(fixture.pulls).toEqual([]);
  });
});
