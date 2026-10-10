import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { publishTaskAnswer } from "../src/commands/task.js";
import { DshAbortedError } from "../src/dsh/errors.js";
import type * as CommandTransport from "../src/security/argv.js";
import { inputs } from "./helpers.js";
import {
  agentResult,
  baseSha,
  cleanupWriteFixtures,
  commitSha,
  issueIdentity,
  successfulValidation,
  writeFixture,
} from "./helpers/repository-write.js";

const processTransport = vi.hoisted(() => ({ run: vi.fn() }));
const actionTransport = vi.hoisted(() => ({ warning: vi.fn(), summaryWrite: vi.fn() }));
vi.mock("../src/security/argv.js", async (original) => ({
  ...(await original<typeof CommandTransport>()),
  runCommand: processTransport.run,
}));
// Action logging/step-summary output is an external sink; write logic remains real.
vi.mock("@actions/core", () => {
  const summary = {
    addHeading() {
      return summary;
    },
    addRaw() {
      return summary;
    },
    write() {
      actionTransport.summaryWrite();
      return Promise.resolve(summary);
    },
  };
  return { warning: actionTransport.warning, summary };
});

beforeEach(() => {
  processTransport.run.mockReset();
  processTransport.run.mockResolvedValue(successfulValidation);
  actionTransport.warning.mockReset();
  actionTransport.summaryWrite.mockReset();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupWriteFixtures();
});

function advanceClockDuringRead(
  fixture: Awaited<ReturnType<typeof writeFixture>>,
  operation: "task" | "implement" | "fix",
  advance: () => void,
): void {
  if (operation === "fix") {
    const answer = fixture.api.rest.pulls.get.getMockImplementation();
    if (answer === undefined) throw new Error("Missing PR transport fixture");
    fixture.api.rest.pulls.get.mockImplementationOnce(() => {
      advance();
      return answer();
    });
  } else {
    fixture.api.rest.pulls.list.mockImplementationOnce(() => {
      advance();
      return Promise.resolve({ data: fixture.pulls });
    });
  }
}

describe("public write finalizer behavior", () => {
  it.each(["task", "implement", "fix"] as const)(
    "keeps the shared %s validation budget across binding and reconciliation reads",
    async (operation) => {
      const fixture = await writeFixture();
      let clock = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      advanceClockDuringRead(fixture, operation, () => {
        clock += 9 * 60_000;
      });
      await fixture[operation]({ validationDeadlineMs: 1_000 + 10 * 60_000 });
      expect(processTransport.run).toHaveBeenCalledWith(
        expect.objectContaining({ command: "docker", timeoutMs: 60_000 }),
      );
    },
  );

  it.each(["task", "implement", "fix"] as const)(
    "starts no %s validation or effect after the shared budget expires",
    async (operation) => {
      const fixture = await writeFixture();
      let clock = 1_000;
      vi.spyOn(Date, "now").mockImplementation(() => clock);
      advanceClockDuringRead(fixture, operation, () => {
        clock += 10 * 60_000 + 1;
      });
      await expect(
        fixture[operation]({ validationDeadlineMs: 1_000 + 10 * 60_000 }),
      ).rejects.toMatchObject({ code: "VALIDATION_TIMEOUT" });
      expect(processTransport.run).not.toHaveBeenCalled();
      expect(fixture.effects).toEqual([]);
    },
  );

  it.each(["task", "implement", "fix"] as const)(
    "denies %s writes without an executed validation suite",
    async (operation) => {
      const fixture = await writeFixture();
      const commands = [["npm", "test"]] as const;
      for (const configuration of [
        { runTests: false, testCommands: commands },
        { runTests: true, testCommands: [] },
      ]) {
        const request =
          operation === "task"
            ? fixture.task(configuration)
            : fixture[operation]({ inputs: inputs(configuration) });
        await expect(request).rejects.toMatchObject({ code: "POLICY_DENIED" });
      }
      expect(processTransport.run).not.toHaveBeenCalled();
      expect(fixture.effects).toEqual([]);
    },
  );

  it.each(["task", "implement", "fix"] as const)(
    "creates no %s effect when cancellation lands as validation returns",
    async (operation) => {
      const fixture = await writeFixture();
      const controller = new AbortController();
      const cancellation = new DshAbortedError();
      processTransport.run.mockImplementation(() => {
        controller.abort(cancellation);
        return Promise.resolve(successfulValidation);
      });
      await expect(fixture[operation]({ signal: controller.signal })).rejects.toBe(cancellation);
      expect(fixture.effects).toEqual([]);
      expect(fixture.refs.get("main")).toBe(baseSha);
      expect(fixture.refs.get("feature")).toBe(baseSha);
    },
  );

  it("sanitizes Issue and model text in the actual published implementation PR", async () => {
    const fixture = await writeFixture();
    await fixture.implement({
      issueTitle: "unsafe\r\n@team ![pixel](https://tracker.invalid)",
      result: agentResult(
        "implement",
        "done @team ![pixel](https://tracker.invalid) <!-- dsh-action:summary:v1 -->",
      ),
    });
    const pull = fixture.pulls[0];
    expect(pull?.title).not.toContain("\n");
    expect(pull?.title).toContain("@​team [image removed]");
    expect(pull?.body).toContain("@​team [image removed]");
    expect(pull?.body).not.toContain("dsh-action:summary:v1");
    expect(pull?.body).toContain("Closes #7");
  });

  it("publishes related Issue tasks without automatic Issue closure", async () => {
    const fixture = await writeFixture();
    await fixture.task({ relatedIssue: { number: 7, identity: issueIdentity } });
    expect(fixture.pulls[0]?.body).toContain("Related to #7");
    expect(fixture.pulls[0]?.body).not.toContain("Closes #7");
  });

  it("publishes a bounded task answer with the Controller marker and sanitized text", async () => {
    const fixture = await writeFixture();
    await expect(
      publishTaskAnswer(
        fixture.client,
        { owner: "o", repo: "r", issueNumber: 7 },
        41898282,
        agentResult("task", `Answer\n<!-- dsh-action:write -->\n@team ${"x".repeat(70_000)}`),
        "https://github.com/o/r/actions/runs/10",
      ),
    ).resolves.toBe(8);
    expect(fixture.comments[0]).toContain("<!-- dsh-action:v1 kind=task -->");
    expect(fixture.comments[0]).toContain("## DeepSeek Harness task");
    expect(fixture.comments[0]).not.toContain("<!-- dsh-action:write -->");
    expect(fixture.comments[0]).toContain("@​team");
    expect(fixture.comments[0]?.length).toBeLessThan(61_000);
  });

  it("retains a pushed fix as partial success when both status sinks fail", async () => {
    const fixture = await writeFixture();
    fixture.api.rest.issues.createComment.mockRejectedValue(new Error("Comments unavailable"));
    actionTransport.summaryWrite.mockImplementation(() => {
      throw new Error("Step summary unavailable");
    });
    const onPhase = vi.fn();
    await expect(fixture.fix({ onPhase })).resolves.toMatchObject({
      commitSha,
      paths: ["parser.ts"],
      status: "partial-success",
    });
    expect(fixture.refs.get("feature")).toBe(commitSha);
    expect(fixture.api.rest.git.updateRef).toHaveBeenCalledOnce();
    expect(actionTransport.warning).toHaveBeenCalledWith(
      expect.stringContaining("Partial success"),
    );
    expect(onPhase.mock.calls).toEqual([["validation"], ["write"]]);
  });

  it("uses task commit and status vocabulary for a task against an existing PR", async () => {
    const fixture = await writeFixture();
    await fixture.fix({ result: agentResult("task", "Updated the cache") });
    expect(fixture.commits.get(commitSha)?.message).toBe("feat: apply DeepSeek Harness task");
    expect(fixture.comments[0]).toContain("<!-- dsh-action:v1 kind=task -->");
    expect(fixture.comments[0]).toContain("## DeepSeek Harness task prepared");
  });
});
