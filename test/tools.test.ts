import { describe, expect, it, vi } from "vitest";

import type { AgentToolCall, AgentToolManifest, ToolProvider } from "../src/agent/contracts.js";
import {
  buildControllerToolPolicyAudit,
  buildPermissionAudit,
} from "../src/permissions/profile.js";
import type { SecurityPolicy } from "../src/security/policy.js";
import { executeCommandTool, type CommandToolProcessRunner } from "../src/tools/executor.js";
import { CommandToolProvider, resolveEffectiveTools } from "../src/tools/registry.js";
import { ToolRouter } from "../src/tools/router.js";
import {
  parseAllowedTools,
  parseDisallowedTools,
  parseToolConfiguration,
  validateAllowedToolReferences,
} from "../src/tools/schema.js";

const PINNED_IMAGE = `docker.io/library/node@sha256:${"a".repeat(64)}`;

function policy(
  overrides: Partial<SecurityPolicy["capabilities"]> = {},
  trust: SecurityPolicy["trust"] = "trusted-write",
): SecurityPolicy {
  return {
    trust,
    allowed: true,
    reason: "test",
    capabilities: {
      readRepository: true,
      readCi: false,
      publishComments: true,
      executeRepositoryCode: true,
      loadExtensions: true,
      accessNetwork: true,
      modifyWorkspace: true,
      commit: true,
      push: true,
      createPullRequest: false,
      manageIssueLabels: trust === "trusted-write",
      manageIssueAssignees: trust === "trusted-write",
      updateIssueState: trust === "trusted-write",
      updatePullRequestMetadata: trust === "trusted-write",
      ...overrides,
    },
  };
}

describe("maintainer-defined command tools", () => {
  it("parses a strict versioned manifest and rejects shells or dangling IDs", () => {
    const configuration = parseToolConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        commands: [{ name: "test", description: "Run tests", argv: ["npm", "test"] }],
      }),
    );
    expect(configuration.commands[0]).toMatchObject({
      name: "test",
      argv: ["npm", "test"],
      network: "none",
      workspaceAccess: "read",
      maxCalls: 3,
    });
    expect(() =>
      parseToolConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          commands: [{ name: "bad", description: "bad", argv: ["bash", "-lc", "npm test"] }],
        }),
      ),
    ).toThrow(/shell interpreters/u);
    expect(() =>
      validateAllowedToolReferences(parseAllowedTools('["command.missing"]'), configuration),
    ).toThrow(/undefined command tool/u);
  });

  it("intersects each command's write and network grants with controller policy", () => {
    const configuration = parseToolConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        commands: [
          { name: "read", description: "read", argv: ["npm", "test"] },
          {
            name: "write",
            description: "write",
            argv: ["npm", "run", "format"],
            workspaceAccess: "write",
          },
          {
            name: "network",
            description: "network",
            argv: ["npm", "ci"],
            network: "bridge",
          },
        ],
      }),
    );
    const effective = resolveEffectiveTools(
      parseAllowedTools('["workspace.edit","command.read","command.write","command.network"]'),
      configuration,
      policy({ modifyWorkspace: false, accessNetwork: false }),
    );
    expect(effective.workspace).not.toContain("workspace.edit");
    expect(effective.commands.map(({ name }) => name)).toEqual(["read"]);
    expect(effective.permissionDenials).toEqual(
      expect.arrayContaining([
        {
          id: "workspace.edit",
          reasonCode: "CAPABILITY_NOT_GRANTED",
          reason: "Workspace editing requires trusted-write policy with Docker isolation",
        },
        {
          id: "command.write",
          reasonCode: "CAPABILITY_NOT_GRANTED",
          reason:
            "The Controller trust policy denied this command's execution, write, or network grant",
        },
        {
          id: "command.network",
          reasonCode: "CAPABILITY_NOT_GRANTED",
          reason:
            "The Controller trust policy denied this command's execution, write, or network grant",
        },
      ]),
    );
  });

  it("lets explicit deny remove a standard-profile tool before manifest creation", () => {
    const effective = resolveEffectiveTools(
      [],
      parseToolConfiguration('{"schemaVersion":1,"commands":[]}'),
      policy(),
      {
        permissionProfile: "standard",
        disallowedTools: parseDisallowedTools('["native.bash"]'),
      },
    );

    expect(effective.native).toEqual([
      "workspace.read",
      "workspace.search",
      "workspace.edit",
      "native.web-search",
      "native.subagent",
    ]);
    expect(effective.manifests.map(({ id }) => id)).not.toContain("native.bash");
    expect(effective.permissionDenials).toContainEqual({
      id: "native.bash",
      reasonCode: "EXPLICIT_DENY",
      reason: "Explicit disallowed-tools entry; deny always wins",
    });
  });

  it("downgrades standard through Controller policy and explains every removed capability", () => {
    const effective = resolveEffectiveTools(
      [],
      parseToolConfiguration('{"schemaVersion":1,"commands":[]}'),
      policy(
        {
          executeRepositoryCode: false,
          accessNetwork: false,
          modifyWorkspace: false,
          commit: false,
          push: false,
        },
        "trusted-read",
      ),
      { permissionProfile: "standard" },
    );

    expect(effective.native).toEqual(["workspace.read", "workspace.search"]);
    expect(effective.permissionDenials).toEqual(
      expect.arrayContaining([
        {
          id: "workspace.edit",
          reasonCode: "TRUST_REQUIRED",
          reason: "Workspace editing requires trusted-write policy with Docker isolation",
        },
        {
          id: "native.bash",
          reasonCode: "TRUST_REQUIRED",
          reason: "Bash requires trusted-write repository-code execution in Docker",
        },
        {
          id: "native.web-search",
          reasonCode: "CAPABILITY_NOT_GRANTED",
          reason: "Web search requires a trusted same-repository actor and Docker",
        },
        {
          id: "native.subagent",
          reasonCode: "TRUST_REQUIRED",
          reason: "Subagent delegation requires trusted-write policy in Docker",
        },
      ]),
    );
    const permission = buildPermissionAudit({
      resolution: effective.permission,
      manifests: effective.manifests,
      additionalDenials: effective.permissionDenials,
    });
    expect(permission.effectiveTools).toEqual(["workspace.read", "workspace.search"]);
    expect(buildControllerToolPolicyAudit(permission, "controller")).toMatchObject({
      policyOwner: "controller",
      requestedTools: [
        "native.bash",
        "native.subagent",
        "native.web-search",
        "workspace.edit",
        "workspace.read",
        "workspace.search",
      ],
      effectiveTools: ["workspace.read", "workspace.search"],
      deniedTools: [
        {
          id: "native.bash",
          reasonCode: "TRUST_REQUIRED",
          reason: "Bash requires trusted-write repository-code execution in Docker",
        },
        {
          id: "native.subagent",
          reasonCode: "TRUST_REQUIRED",
          reason: "Subagent delegation requires trusted-write policy in Docker",
        },
        {
          id: "native.web-search",
          reasonCode: "CAPABILITY_NOT_GRANTED",
          reason: "Web search requires a trusted same-repository actor and Docker",
        },
        {
          id: "workspace.edit",
          reasonCode: "TRUST_REQUIRED",
          reason: "Workspace editing requires trusted-write policy with Docker isolation",
        },
      ],
    });
  });

  it("applies trust, isolation, then capability denial precedence deterministically", () => {
    const configuration = parseToolConfiguration('{"schemaVersion":1,"commands":[]}');
    const untrustedAndUnisolated = resolveEffectiveTools(
      ["workspace.read"],
      configuration,
      policy({}, "untrusted"),
      { permissionProfile: "custom", isolation: "none" },
    );
    const isolatedOnly = resolveEffectiveTools(
      ["workspace.read"],
      configuration,
      policy({}, "trusted-read"),
      { permissionProfile: "custom", isolation: "none" },
    );
    const capabilityOnly = resolveEffectiveTools(
      ["workspace.edit"],
      configuration,
      policy({ modifyWorkspace: false }),
      { permissionProfile: "custom", isolation: "docker" },
    );

    expect(untrustedAndUnisolated.permissionDenials[0]?.reasonCode).toBe("TRUST_REQUIRED");
    expect(isolatedOnly.permissionDenials[0]?.reasonCode).toBe("ISOLATION_REQUIRED");
    expect(capabilityOnly.permissionDenials[0]?.reasonCode).toBe("CAPABILITY_NOT_GRANTED");
  });

  it("runs exact argv in a named read-only container and force-cleans timeouts", async () => {
    const definition = parseToolConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        commands: [{ name: "test", description: "test", argv: ["npm", "test"] }],
      }),
    ).commands[0];
    if (definition === undefined) throw new Error("missing fixture");
    const calls: Parameters<CommandToolProcessRunner>[0][] = [];
    const result = await executeCommandTool(
      {
        callId: "call-1",
        id: "command.test",
        definition,
        workspacePath: "C:/workspace",
        containerImage: PINNED_IMAGE,
        timeoutMs: 30_000,
      },
      (options) => {
        calls.push(options);
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "timeout",
          timedOut: calls.length === 1,
          outputTruncated: false,
        });
      },
    );
    expect(result).toMatchObject({ callId: "call-1", id: "command.test", ok: false });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toContain("--name");
    expect(calls[0]?.args).toContain("--pids-limit");
    expect(calls[0]?.args).toContain("--network");
    expect(calls[0]?.args).toContain("none");
    expect(calls[0]?.args.some((arg) => arg.includes("target=/workspace,readonly"))).toBe(true);
    expect(calls[0]?.args.slice(-2)).toEqual(["npm", "test"]);
    expect(calls[1]?.args.slice(0, 2)).toEqual(["rm", "--force"]);
    expect(Object.keys(calls[0]?.env ?? {})).toEqual(
      process.env.PATH === undefined ? [] : ["PATH"],
    );
  });

  it.each(["--privileged", "--network=host", " node:24", "node:24\n--privileged"])(
    "rejects a command-tool image argument before starting Docker: %s",
    async (containerImage) => {
      const definition = parseToolConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          commands: [{ name: "test", description: "test", argv: ["npm", "test"] }],
        }),
      ).commands[0];
      if (definition === undefined) throw new Error("missing fixture");
      const runner: CommandToolProcessRunner = vi.fn(() =>
        Promise.resolve({
          exitCode: 0,
          stdout: "",
          stderr: "",
          timedOut: false,
          outputTruncated: false,
        }),
      );
      await expect(
        executeCommandTool(
          {
            callId: "call-image",
            id: "command.test",
            definition,
            workspacePath: "C:/workspace",
            containerImage,
            timeoutMs: 30_000,
          },
          runner,
        ),
      ).rejects.toThrow(/containerImage/u);
      expect(runner).not.toHaveBeenCalled();
    },
  );

  it("rejects model argv, enforces maxCalls, redacts output, and routes exact IDs", async () => {
    const definition = parseToolConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        commands: [{ name: "test", description: "test", argv: ["npm", "test"], maxCalls: 1 }],
      }),
    ).commands[0];
    if (definition === undefined) throw new Error("missing fixture");
    const execute = vi.fn((execution: { callId: string; id: `command.${string}` }) =>
      Promise.resolve({
        callId: execution.callId,
        id: execution.id,
        ok: true,
        output: { exitCode: 0, stdout: "secret", stderr: "", timedOut: false, truncated: false },
      }),
    );
    const provider = new CommandToolProvider({
      definitions: [definition],
      workspacePath: "workspace",
      containerImage: PINNED_IMAGE,
      redact: (value) => value.replaceAll("secret", "[redacted]"),
      execute,
    });
    const router = new ToolRouter([provider]);
    const call: AgentToolCall = { callId: "call-1", id: "command.test", input: {} };
    await expect(
      router.invoke(call, { workspacePath: "workspace", timeoutMs: 1_000 }),
    ).resolves.toMatchObject({
      output: { stdout: "[redacted]" },
    });
    await expect(
      router.invoke(
        { ...call, callId: "call-2" },
        { workspacePath: "workspace", timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/maxCalls/u);
    await expect(
      provider.invoke(
        { ...call, callId: "call-3", input: { argv: ["rm", "-rf"] } },
        { workspacePath: "workspace", timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/no model-provided arguments/u);
    expect(() => new ToolRouter([provider, provider])).toThrow(/Duplicate agent tool id/u);
  });

  it("fails closed when a provider returns a mismatched call receipt", async () => {
    const provider: ToolProvider = {
      id: "command",
      manifest: () => [
        {
          id: "command.test",
          description: "test",
          provider: "command",
          permissions: ["execute"],
          inputSchema: { type: "object" },
        },
      ],
      invoke: () => Promise.resolve({ callId: "wrong", id: "command.test", ok: true, output: {} }),
    };
    await expect(
      new ToolRouter([provider]).invoke(
        { callId: "expected", id: "command.test", input: {} },
        { workspacePath: "workspace", timeoutMs: 1_000 },
      ),
    ).rejects.toThrow(/mismatched result/u);
  });

  it("enforces controller provider namespace ownership", () => {
    const manifest = {
      id: "command.test",
      description: "test",
      provider: "command" as const,
      permissions: ["execute" as const],
      inputSchema: { type: "object" },
    };
    const provider = (id: string, tool: AgentToolManifest = manifest): ToolProvider => ({
      id,
      manifest: () => [tool],
      invoke: (call) => Promise.resolve({ ...call, ok: true, output: {} }),
    });
    expect(() => new ToolRouter([provider("other")])).toThrow(/outside provider namespace/u);
    expect(
      () =>
        new ToolRouter([
          provider("builtin", { ...manifest, id: "builtin.read", provider: "builtin" }),
        ]),
    ).toThrow(/must run through the official DSH ToolRuntime/u);
    expect(
      () =>
        new ToolRouter([provider("mcp", { ...manifest, id: "mcp.docs.lookup", provider: "mcp" })]),
    ).toThrow(/must run through the official DSH ToolRuntime/u);
  });
});
