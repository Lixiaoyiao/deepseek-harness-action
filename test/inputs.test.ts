import { describe, expect, it } from "vitest";
import { loadInputs } from "../src/inputs.js";

function reader(values: Readonly<Record<string, string>>) {
  return (name: string): string => values[name] ?? "";
}

describe("loadInputs", () => {
  it("applies defaults and decodes argv without shell parsing", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "deepseek-key",
        "github-token": "github-token",
        "test-commands": '[["npm","test"],["node","script with spaces.js"]]',
      }),
    );
    expect(result.allowWrite).toBe(false);
    expect(result.progressComment).toBe(true);
    expect(result.taskAccess).toBe("read");
    expect(result.maxTurns).toBe(3);
    expect(result.allowedTools).toEqual(["workspace.read", "workspace.search", "workspace.edit"]);
    expect(result.toolConfig).toEqual({ schemaVersion: 1, commands: [] });
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
    ["progress-comment", "yes"],
    ["timeout-minutes", "0"],
    ["max-findings", "101"],
    ["test-commands", '["npm test"]'],
    ["base-url", "not a url"],
    ["max-turns", "11"],
    ["allowed-tools", '["command.missing"]'],
  ])("rejects invalid %s", (name, value) => {
    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "deepseek-key",
          "github-token": "github-token",
          [name]: value,
        }),
      ),
    ).toThrow(/Invalid action inputs/u);
  });

  it("requires an explicit prompt for command=task and cross-validates command tools", () => {
    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "deepseek-key",
          "github-token": "github-token",
          command: "task",
        }),
      ),
    ).toThrow(/prompt is required/u);
    const result = loadInputs(
      reader({
        "deepseek-api-key": "deepseek-key",
        "github-token": "github-token",
        command: "task",
        prompt: "run the checks",
        "task-access": "write",
        "allowed-tools": '["command.test"]',
        "tool-config": JSON.stringify({
          schemaVersion: 1,
          commands: [{ name: "test", description: "tests", argv: ["npm", "test"] }],
        }),
      }),
    );
    expect(result).toMatchObject({ taskAccess: "write", maxTurns: 3 });
    expect(result.toolConfig.commands[0]).toMatchObject({ name: "test", network: "none" });
  });

  it("rejects controller credentials embedded in validation or command-tool argv", () => {
    const deepseekKey = "sk-deepseek-secret-value";
    const githubToken = "ghs_controller-secret-value";
    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": deepseekKey,
          "github-token": githubToken,
          "test-commands": JSON.stringify([["node", "check.js", `--token=${githubToken}`]]),
        }),
      ),
    ).toThrow(/credentials must not appear/u);

    expect(() =>
      loadInputs(reader({ "deepseek-api-key": "short", "github-token": "also-short" })),
    ).toThrow(/at least 8 characters/u);

    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": deepseekKey,
          "github-token": githubToken,
          "allowed-tools": '["command.probe"]',
          "tool-config": JSON.stringify({
            schemaVersion: 1,
            commands: [
              {
                name: "probe",
                description: "probe",
                argv: ["node", "probe.js", deepseekKey],
              },
            ],
          }),
        }),
      ),
    ).toThrow(/credentials must not appear/u);
  });
});
