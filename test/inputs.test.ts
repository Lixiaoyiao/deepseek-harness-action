import { describe, expect, it } from "vitest";
import { loadInputs } from "../src/inputs.js";

function reader(values: Readonly<Record<string, string>>) {
  return (name: string): string => values[name] ?? "";
}

describe("loadInputs", () => {
  it("applies defaults and decodes argv without shell parsing", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "key",
        "github-token": "gh",
        "test-commands": '[["npm","test"],["node","script with spaces.js"]]',
      }),
    );
    expect(result.allowWrite).toBe(false);
    expect(result.timeoutMinutes).toBe(20);
    expect(result.containerImage).toBe(
      "docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059",
    );
    expect(result.testCommands).toEqual([
      ["npm", "test"],
      ["node", "script with spaces.js"],
    ]);
  });

  it.each([
    ["allow-write", "yes"],
    ["timeout-minutes", "0"],
    ["max-findings", "101"],
    ["test-commands", '["npm test"]'],
    ["base-url", "not a url"],
  ])("rejects invalid %s", (name, value) => {
    expect(() =>
      loadInputs(reader({ "deepseek-api-key": "key", "github-token": "gh", [name]: value })),
    ).toThrow(/Invalid action inputs/u);
  });
});
