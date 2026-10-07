import { describe, expect, it } from "vitest";

import { checkConfiguration } from "../src/configuration-check.js";
import { loadInputs } from "../src/inputs.js";

const credentials = {
  "deepseek-api-key": "test-deepseek-secret",
  "github-token": "test-github-secret",
};
function configured(values: Record<string, string> = {}) {
  const all: Record<string, string> = { ...credentials, ...values };
  return loadInputs((name) => all[name] ?? "");
}

describe("explicit Session configuration", () => {
  it("keeps existing workflows opted out", () => {
    expect(configured()).toMatchObject({
      sessionMode: "off",
      sessionKey: "",
      sessionSourceRunId: "",
      sessionRetentionDays: 3,
    });
  });
  it.each(["controlled", "native"])("accepts a Docker %s save and explicit resume", (mode) => {
    const common = { "session-key": "maintainer-selected.task", "dsh-mode": mode };
    expect(configured({ ...common, "session-mode": "save" }).sessionMode).toBe("save");
    expect(configured({ ...common, "session-mode": "auto" }).sessionMode).toBe("auto");
    expect(
      configured({ ...common, "session-mode": "resume", "session-source-run-id": "123456789" })
        .sessionSourceRunId,
    ).toBe("123456789");
  });
  it.each([
    { "session-key": "silent-opt-in" },
    { "session-mode": "save" },
    { "session-mode": "save", "session-key": "task", isolation: "none" },
    { "session-mode": "save", "session-key": "../runner-path" },
    { "session-mode": "resume", "session-key": "task" },
    { "session-mode": "save", "session-key": "task", "session-source-run-id": "123" },
    { "session-mode": "auto", "session-key": "task", "session-source-run-id": "123" },
    {
      "session-mode": "resume",
      "session-key": "task",
      "session-source-run-id": "9007199254740993",
    },
    { "session-mode": "save", "session-key": "task", "session-retention-days": "0" },
    { "session-mode": "save", "session-key": "task", "session-retention-days": "8" },
  ])("rejects contradictory, unsafe or unbounded configuration %j", (values) => {
    expect(() => configured(values)).toThrow();
  });
  it("does not claim offline provenance validation", () => {
    const checked = checkConfiguration({
      schemaVersion: 1,
      inputs: { ...credentials, "session-mode": "save", "session-key": "task" },
    });
    expect(checked.ok).toBe(true);
    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({ id: "session_provenance", status: "not_checked" }),
    );
  });
});
