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
    expect(result.containerImage).toBe("node:24-bookworm");
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
