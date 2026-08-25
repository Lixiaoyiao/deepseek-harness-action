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
    expect(result.triggerPhrase).toBe("@dsh");
    expect(result.labelTrigger).toBe("");
    expect(result.assigneeTrigger).toBe("");
    expect(result.allowedActors).toEqual(["*"]);
    expect(result.allowedBots).toEqual([]);
    expect(result.includeCommentsByActor).toEqual([]);
    expect(result.excludeCommentsByActor).toEqual([]);
    expect(result.baseBranch).toBe("");
    expect(result.branchPrefix).toBe("dsh/");
    expect(result.branchNameTemplate).toBe("");
    expect(result.taskAccess).toBe("read");
    expect(result.maxTurns).toBe(3);
    expect(result.dshMode).toBe("controlled");
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
    expect(result.taskOutputSchema).toBeUndefined();
  });

  it("validates base branch and deterministic branch naming configuration", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "deepseek-key",
        "github-token": "github-token",
        "base-branch": " release/next ",
        "branch-prefix": "automation/",
        "branch-name-template": "{{prefix}}{{entityType}}-{{entityNumber}}-{{operation}}-{{key}}",
      }),
    );
    expect(result).toMatchObject({
      baseBranch: "release/next",
      branchPrefix: "automation/",
      branchNameTemplate: "{{prefix}}{{entityType}}-{{entityNumber}}-{{operation}}-{{key}}",
    });
  });

  it("parses bounded maintainer-owned routing and actor filters", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "deepseek-key",
        "github-token": "github-token",
        "trigger-phrase": "  /deepseek  ",
        "label-trigger": "agent-ready",
        "assignee-trigger": "@deepseek-bot",
        "allowed-actors": "Alice, @BOB, alice",
        "allowed-bots": "dependabot[bot]",
        "include-comments-by-actor": "maintainer, *[bot]",
        "exclude-comments-by-actor": "renovate[bot]",
      }),
    );
    expect(result).toMatchObject({
      triggerPhrase: "/deepseek",
      labelTrigger: "agent-ready",
      assigneeTrigger: "@deepseek-bot",
      allowedActors: ["Alice", "BOB"],
      allowedBots: ["dependabot[bot]"],
      includeCommentsByActor: ["maintainer", "*[bot]"],
      excludeCommentsByActor: ["renovate[bot]"],
    });
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

  it("accepts definition-only native MCP, Bundle, and direct Plugin admission", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "deepseek-key",
        "github-token": "github-token",
        "dsh-mode": "native",
        "permission-profile": "standard",
        "allow-plugin-install": "true",
        "mcp-config": JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "docs",
              transport: "streamable-http",
              url: "https://mcp.example.test/rpc",
              credentialHeaders: { "X-Service": "extension-owned-token" },
              toolCallTimeoutMs: 12_000,
            },
          ],
        }),
        "plugin-config": JSON.stringify({
          schemaVersion: 1,
          bundles: [{ id: "audit", package: "dsh-audit-bundle", source: "1.2.3" }],
          plugins: [
            {
              id: "lint",
              package: "dsh-lint-plugin",
              source: "2.3.4",
              credentialConfig: { connection: "plugin-owned-token" },
            },
          ],
        }),
      }),
    );

    expect(result.mcpConfig.servers[0]).toMatchObject({
      id: "docs",
      network: true,
      workspaceWrite: false,
      toolCallTimeoutMs: 12_000,
      credentialHeaders: { "X-Service": "extension-owned-token" },
    });
    expect(result.pluginConfig).toMatchObject({
      bundles: [{ id: "audit", source: "1.2.3", workspaceWrite: false }],
      plugins: [
        {
          id: "lint",
          source: "2.3.4",
          workspaceWrite: false,
          credentialConfig: { connection: "plugin-owned-token" },
        },
      ],
    });
    expect(JSON.stringify(result.mcpConfig)).not.toContain('"tools"');
    expect(JSON.stringify(result.pluginConfig)).not.toContain('"tools"');
  });

  it.each([
    ["allow-write", "yes"],
    ["progress-comment", "yes"],
    ["timeout-minutes", "0"],
    ["max-findings", "101"],
    ["test-commands", '["npm test"]'],
    ["base-url", "not a url"],
    ["max-turns", "11"],
    ["dsh-mode", "unsafe"],
    ["permission-profile", "superuser"],
    ["allowed-tools", '["native.terminal"]'],
    ["disallowed-tools", '["native.terminal"]'],
    ["allowed-tools", '["command.missing"]'],
    ["disallowed-tools", '["command.missing"]'],
    ["allowed-tools", '["mcp.docs.lookup"]'],
    ["disallowed-tools", '["plugin.lint.scan"]'],
    ["trigger-phrase", "bad\nphrase"],
    ["label-trigger", "bad\u0000label"],
    ["allowed-actors", "alice,not an actor"],
    ["allowed-bots", "alice/../../admin"],
    ["task-output-schema", '{"type":"object","$ref":"https://example.test/schema"}'],
    ["task-output-schema", '{"type":"object","oneOf":[{"type":"object"}]}'],
    ["base-branch", "refs/heads/main"],
    ["branch-prefix", "-unsafe/"],
    ["branch-name-template", "{{prefix}}{{operation}}"],
    ["branch-name-template", "{{prefix}}{{key}}-{{timestamp}}"],
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

  it("selects native without reinterpreting permission-profile or Controller command tools", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "deepseek-key",
        "github-token": "github-token",
        "dsh-mode": "native",
        "permission-profile": "standard",
        "allowed-tools": '["command.check"]',
        "tool-config": JSON.stringify({
          schemaVersion: 1,
          commands: [{ name: "check", description: "Run the fixed check", argv: ["npm", "test"] }],
        }),
      }),
    );

    expect(result).toMatchObject({
      dshMode: "native",
      isolation: "docker",
      permissionProfile: "standard",
      allowedTools: ["command.check"],
    });
    expect(result.toolConfig.commands[0]).toMatchObject({
      name: "check",
      argv: ["npm", "test"],
    });
  });

  it.each([
    ["host isolation", "isolation", "none"],
    ["host executable", "dsh-executable", "/opt/dsh/bin.js"],
  ])("fails closed for native with %s", (_label, name, value) => {
    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "deepseek-key",
          "github-token": "github-token",
          "dsh-mode": "native",
          [name]: value,
        }),
      ),
    ).toThrow(/dsh-mode native requires Docker isolation and does not accept dsh-executable/u);
  });

  it.each([
    {
      label: "MCP",
      name: "mcp-config",
      value: JSON.stringify({
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
      }),
    },
    {
      label: "Bundle",
      name: "plugin-config",
      value: JSON.stringify({
        schemaVersion: 1,
        bundles: [
          {
            id: "audit",
            package: "dsh-audit-bundle",
            source: "1.2.3",
            tools: [
              {
                id: "scan",
                name: "plugin__audit__scan",
                description: "Scan the repository",
                permissions: ["read"],
              },
            ],
          },
        ],
        plugins: [],
      }),
    },
    {
      label: "Plugin",
      name: "plugin-config",
      value: JSON.stringify({
        schemaVersion: 1,
        bundles: [],
        plugins: [
          {
            id: "audit",
            package: "dsh-audit-plugin",
            source: "1.2.3",
            config: {},
            tools: [
              {
                id: "scan",
                name: "plugin__audit__scan",
                description: "Scan the repository",
                permissions: ["read"],
              },
            ],
          },
        ],
      }),
    },
  ])(
    "rejects controlled-shaped per-tool metadata in native $label configuration",
    ({ name, value }) => {
      expect(() =>
        loadInputs(
          reader({
            "deepseek-api-key": "deepseek-key",
            "github-token": "github-token",
            "dsh-mode": "native",
            [name]: value,
          }),
        ),
      ).toThrow(/Invalid native .*Unrecognized key: "tools"/u);
    },
  );

  it("rejects native extension IDs in allowed-tools because they are not grants", () => {
    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "deepseek-key",
          "github-token": "github-token",
          "dsh-mode": "native",
          "permission-profile": "custom",
          "allowed-tools": '["mcp.docs.lookup"]',
        }),
      ),
    ).toThrow(/DSH owns native extension discovery and inventory/u);
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

  it("loads a bounded trusted task output schema and rejects credentials embedded in it", () => {
    const result = loadInputs(
      reader({
        "deepseek-api-key": "sk-deepseek-secret-value",
        "github-token": "ghs_controller-secret-value",
        "task-output-schema": JSON.stringify({
          type: "object",
          properties: { status: { type: "string", enum: ["ready", "blocked"] } },
          required: ["status"],
          additionalProperties: false,
        }),
      }),
    );
    expect(result.taskOutputSchema).toEqual({
      type: "object",
      properties: { status: { type: "string", enum: ["ready", "blocked"] } },
      required: ["status"],
      additionalProperties: false,
    });

    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "sk-deepseek-secret-value",
          "github-token": "ghs_controller-secret-value",
          "task-output-schema": JSON.stringify({
            type: "object",
            description: "ghs_controller-secret-value",
          }),
        }),
      ),
    ).toThrow(/credentials must not appear/u);

    expect(() =>
      loadInputs(
        reader({
          "deepseek-api-key": "sk-deepseek-secret-value",
          "github-token": "ghs_controller-secret-value",
          command: "review",
          "task-output-schema": JSON.stringify({ type: "object" }),
        }),
      ),
    ).toThrow(/supported only for command task or auto/u);
  });

  it("rejects controller credentials embedded in public branch configuration", () => {
    const deepseekKey = "sk-deepseek-secret-value";
    const githubToken = "ghs_controller-secret-value";
    for (const values of [
      { "base-branch": githubToken },
      { "branch-prefix": `${deepseekKey}/` },
      {
        "branch-name-template": `{{prefix}}{{operation}}-${githubToken}-{{key}}`,
      },
      { "branch-name-template": `{{prefix}}{{key}}-{{${githubToken}}}` },
    ]) {
      expect(() =>
        loadInputs(
          reader({
            "deepseek-api-key": deepseekKey,
            "github-token": githubToken,
            ...values,
          }),
        ),
      ).toThrow(/credentials must not appear/u);
    }
  });
});
