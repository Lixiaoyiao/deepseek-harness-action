import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { resolveExtensionPlan } from "../src/extensions/plan.js";
import { parseMcpConfiguration, parsePluginConfiguration } from "../src/extensions/schema.js";
import { buildActionOutputs, formatStepSummary, type RunOutcome } from "../src/result.js";
import { buildAuthorityAudit } from "../src/security/authority.js";
import type { SecurityPolicy } from "../src/security/policy.js";

const secrets = [
  "http-header-secret",
  "http-query-secret",
  "stdio-argument-secret",
  "stdio-environment-secret",
  "plugin-primary-secret",
  "plugin-secondary-secret",
  "unused-mcp-secret",
  "unused-plugin-secret",
] as const;

const trustedReadPolicy: SecurityPolicy = {
  trust: "trusted-read",
  allowed: true,
  reason: "authority audit test",
  capabilities: {
    readRepository: true,
    readCi: false,
    publishComments: true,
    executeRepositoryCode: false,
    loadExtensions: true,
    accessNetwork: true,
    modifyWorkspace: false,
    commit: false,
    push: false,
    createPullRequest: false,
    manageIssueLabels: false,
    manageIssueAssignees: false,
    updateIssueState: false,
    updatePullRequestMetadata: false,
  },
};

function effectivePlan(reverse = false) {
  const mcpServers = [
    {
      id: "z-http",
      transport: "streamable-http",
      url: "https://mcp.example.test/rpc/path-secret?token=http-query-secret",
      headers: { Authorization: "Bearer http-header-secret" },
      tools: [
        {
          id: "search",
          name: "search",
          description: "Search remotely",
          permissions: ["read", "network"],
        },
      ],
    },
    {
      id: "a-stdio",
      transport: "stdio",
      command: "repository-index-mcp",
      args: ["--api-token", "stdio-argument-secret"],
      env: { SERVICE_TOKEN: "stdio-environment-secret" },
      network: true,
      tools: [
        {
          id: "lookup",
          name: "lookup",
          description: "Look up an index entry",
          permissions: ["read", "network"],
        },
      ],
    },
    {
      id: "unused-mcp",
      transport: "stdio",
      command: "unused-mcp",
      env: { UNUSED_TOKEN: "unused-mcp-secret" },
      network: true,
      tools: [
        {
          id: "read",
          name: "read",
          description: "Unused read",
          permissions: ["read", "network"],
        },
      ],
    },
  ];
  const plugins = [
    {
      id: "plain",
      package: "@acme/plain-plugin",
      source: "1.2.3",
      network: true,
      tools: [
        {
          id: "inspect",
          name: "plugin__plain__inspect",
          description: "Inspect with ordinary configuration",
          permissions: ["read", "network"],
        },
      ],
      config: { mode: "safe-json" },
    },
    {
      id: "unused-plugin",
      package: "@acme/unused-plugin",
      source: "1.2.3",
      network: true,
      tools: [
        {
          id: "scan",
          name: "plugin__unused-plugin__scan",
          description: "Unused scan",
          permissions: ["read", "network"],
        },
      ],
      config: { token: "unused-plugin-secret" },
    },
    {
      id: "middle",
      package: "@acme/middle-plugin",
      source: "1.2.3",
      network: true,
      tools: [
        {
          id: "scan",
          name: "plugin__middle__scan",
          description: "Scan remotely",
          permissions: ["read", "network"],
        },
      ],
      config: {
        authentication: {
          apiKey: "plugin-primary-secret",
          secondaryToken: "plugin-secondary-secret",
        },
      },
    },
  ];
  return resolveExtensionPlan({
    allowedTools: [
      "mcp.z-http.search",
      "mcp.a-stdio.lookup",
      "plugin.middle.scan",
      "plugin.plain.inspect",
    ],
    mcp: parseMcpConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        servers: reverse ? mcpServers.toReversed() : mcpServers,
      }),
    ),
    plugins: parsePluginConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        plugins: reverse ? plugins.toReversed() : plugins,
      }),
    ),
    allowPluginInstall: true,
    policy: trustedReadPolicy,
  });
}

describe("known authority sources", () => {
  it("distinguishes withheld Controller credentials from effective worker extension credentials", () => {
    const audit = buildAuthorityAudit(effectivePlan());

    expect(audit).toEqual({
      schemaVersion: 1,
      scope: "action-known-sources",
      knownSources: [
        {
          kind: "controller-credential",
          service: "github",
          holder: "controller",
          credentialExposure: "not-exposed-to-worker",
        },
        {
          kind: "controller-credential",
          service: "deepseek",
          holder: "controller",
          credentialExposure: "not-exposed-to-worker",
          mediation: "run-scoped-proxy",
        },
        {
          kind: "extension-credential",
          extensionKind: "mcp",
          extensionId: "a-stdio",
          provisionedBy: "workflow",
          configuredFor: "worker-extension",
        },
        {
          kind: "extension-credential",
          extensionKind: "mcp",
          extensionId: "z-http",
          provisionedBy: "workflow",
          configuredFor: "worker-extension",
        },
        {
          kind: "extension-credential",
          extensionKind: "plugin",
          extensionId: "middle",
          provisionedBy: "workflow",
          configuredFor: "worker-extension",
        },
      ],
    });
  });

  it("reports one entry per effective owner and never serializes secret bytes or hashes", () => {
    const authority = buildAuthorityAudit(effectivePlan());
    const outcome = {
      schemaVersion: 1,
      conclusion: "success",
      operation: "task",
      summary: "Authority audit complete",
      findingsCount: 0,
      durationMs: 10,
      authority,
    } satisfies RunOutcome;
    const outputs = buildActionOutputs(outcome);
    const serialized = JSON.stringify(authority);
    const publicSurfaces = [serialized, String(outputs["result-json"]), formatStepSummary(outcome)];

    expect(serialized).not.toContain("unused-mcp");
    expect(serialized).not.toContain("unused-plugin");
    expect(serialized).not.toContain('"extensionId":"plain"');
    expect(serialized.match(/"extensionId":"a-stdio"/gu)).toHaveLength(1);
    expect(serialized.match(/"extensionId":"middle"/gu)).toHaveLength(1);
    for (const secret of secrets) {
      const hash = createHash("sha256").update(secret).digest("hex");
      for (const surface of publicSurfaces) {
        expect(surface).not.toContain(secret);
        expect(surface).not.toContain(hash);
      }
    }
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("path-secret");
    expect(serialized).not.toContain("api-token");
    expect(serialized).not.toContain("SERVICE_TOKEN");
  });

  it("uses stable ordering and serialization independent of workflow configuration order", () => {
    expect(JSON.stringify(buildAuthorityAudit(effectivePlan(true)))).toBe(
      JSON.stringify(buildAuthorityAudit(effectivePlan(false))),
    );
  });
});
