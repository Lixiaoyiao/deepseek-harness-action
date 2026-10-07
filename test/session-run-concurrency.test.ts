import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

let inspect: (
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  relation: string,
) => Record<string, unknown>;
beforeAll(async () => {
  inspect = (await import(pathToFileURL(resolve("scripts/probe-session-run-concurrency.mjs")).href))
    .inspectSessionRunConcurrency;
});

const first = {
  repository: "octo/repo",
  id: 10,
  title: "dsh-session-task-one",
  headSha: "a".repeat(40),
  conclusion: "success",
  startedAt: "2026-10-07T01:00:00Z",
  completedAt: "2026-10-07T01:02:00Z",
};
describe("live Session producer concurrency evidence", () => {
  it("proves same-key serialization from producer intervals, including case variants", () => {
    expect(
      inspect(
        first,
        {
          ...first,
          id: 11,
          title: "dsh-session-TASK-one",
          startedAt: "2026-10-07T01:02:01Z",
          completedAt: "2026-10-07T01:04:00Z",
        },
        "same-key",
      ).qualified,
    ).toBe(true);
    expect(() =>
      inspect(first, { ...first, id: 11, startedAt: "2026-10-07T01:01:00Z" }, "same-key"),
    ).toThrow("overlapped");
  });
  it("requires actual overlap for different keys and refuses successful-looking queued runs", () => {
    const second = {
      ...first,
      id: 11,
      title: "dsh-session-task-two",
      startedAt: "2026-10-07T01:01:00Z",
      completedAt: "2026-10-07T01:03:00Z",
    };
    expect(inspect(first, second, "different-key").overlapMilliseconds).toBe(60_000);
    expect(() =>
      inspect(first, { ...second, startedAt: "2026-10-07T01:02:01Z" }, "different-key"),
    ).toThrow("did not overlap");
    expect(() => inspect(first, { ...second, conclusion: "failure" }, "different-key")).toThrow(
      "finish successfully",
    );
    expect(() => inspect(first, second, "same-key")).toThrow("requested key relation");
  });
});
