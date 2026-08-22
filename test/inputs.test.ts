import { readFileSync } from "node:fs";

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
    expect(result.permissionProfile).toBe("strict");
    expect(result.allowedTools).toEqual([]);
    expect(result.disallowedTools).toEqual([]);
    expect(result.validationIntegrity).toBe("warn");
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

  it("keeps the action manifest allow and deny defaults empty", () => {
    const manifest = readFileSync(new URL("../action.yml", import.meta.url), "utf8");
    expect(manifest).toMatch(
      /^ {2}allowed-tools:\r?\n {4}description:.*\r?\n {4}required: false\r?\n {4}default: "\[\]"$/mu,
    );
    expect(manifest).toMatch(
      /^ {2}disallowed-tools:\r?\n {4}description:.*\r?\n {4}required: false\r?\n {4}default: "\[\]"$/mu,
    );
  });

  it.each([
    ["allow-write", "yes"],
    ["progress-comment", "yes"],
    ["timeout-minutes", "0"],
    ["max-findings", "101"],
    ["test-commands", '["npm test"]'],
    ["base-url", "not a url"],
    ["max-turns", "11"],
    ["permission-profile", "superuser"],
    ["allowed-tools", '["native.terminal"]'],
    ["disallowed-tools", '["native.terminal"]'],
    ["allowed-tools", '["command.missing"]'],
    ["disallowed-tools", '["command.missing"]'],
    ["allowed-tools", '["mcp.docs.lookup"]'],
    ["disallowed-tools", '["plugin.lint.scan"]'],
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

  it("enforces strict autonomy and reserves configured extensions for custom or v0.4 strict", () => {
    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "deepseek-key",
          "github-token": "github-token",
          "allowed-tools": '["native.bash"]',
        }),
      ),
    ).toThrow(/permission-profile strict does not expose native\.bash/u);

    const mcpConfig = JSON.stringify({
      schemaVersion: 1,
      servers: [
        {
          id: "docs",
          transport: "streamable-http",
          url: "https://mcp.example.test/rpc",
          tools: [
            {
              id: "lookup",
              name: "lookup",
              description: "Look up documentation",
              permissions: ["read", "network"],
            },
          ],
        },
      ],
    });
    const extensionInputs = {
      "deepseek-api-key": "deepseek-key",
      "github-token": "github-token",
      "allowed-tools": '["mcp.docs.lookup"]',
      "mcp-config": mcpConfig,
    };

    const strict = loadInputs(reader(extensionInputs));
    expect(strict).toMatchObject({
      permissionProfile: "strict",
      allowedTools: ["mcp.docs.lookup"],
    });
    expect(() =>
      loadInputs(reader({ ...extensionInputs, "permission-profile": "standard" })),
    ).toThrow(/requires permission-profile custom/u);
    const custom = loadInputs(reader({ ...extensionInputs, "permission-profile": "custom" }));
    expect(custom).toMatchObject({
      permissionProfile: "custom",
      allowedTools: ["mcp.docs.lookup"],
    });
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

  it("rejects controller credentials embedded in the task prompt", () => {
    const deepseekKey = "sk-deepseek-secret-value";
    const githubToken = "ghs_controller-secret-value";

    for (const secret of [deepseekKey, githubToken]) {
      expect(() =>
        loadInputs(
          reader({
            "deepseek-api-key": deepseekKey,
            "github-token": githubToken,
            command: "task",
            prompt: `Use ${secret} to finish the task`,
          }),
        ),
      ).toThrow(/credentials must not appear/u);
    }
  });
});
