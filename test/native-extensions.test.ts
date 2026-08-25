import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  configuredMcpDefinitionSecrets,
  resolveNativeExtensionPlan,
  type ResolveNativeExtensionPlanOptions,
} from "../src/extensions/plan.js";
import {
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
} from "../src/extensions/schema.js";
import { buildAuthorityAudit } from "../src/security/authority.js";
import type { SecurityPolicy } from "../src/security/policy.js";

function policy(overrides: Partial<SecurityPolicy> = {}): SecurityPolicy {
  return {
    trust: "trusted-read",
    allowed: true,
    reason: "native extension test",
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
    ...overrides,
  };
}

function resolve(
  overrides: Partial<ResolveNativeExtensionPlanOptions> = {},
): ReturnType<typeof resolveNativeExtensionPlan> {
  return resolveNativeExtensionPlan({
    mcp: parseNativeMcpConfiguration('{"schemaVersion":1,"servers":[]}'),
    plugins: parseNativePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
    allowPluginInstall: false,
    policy: policy(),
    ...overrides,
  });
}

describe("native extension admission", () => {
  it("rejects unsafe executables, floating packages, and controlled-shaped tool declarations", () => {
    expect(() =>
      parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [{ id: "unsafe", transport: "stdio", command: "node" }],
        }),
      ),
    ).toThrow(/must not be an interpreter/u);
    expect(() =>
      parseNativePluginConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          bundles: [{ id: "floating", package: "native-bundle", source: "^1.2.3" }],
          plugins: [],
        }),
      ),
    ).toThrow(/exact semver/u);
    expect(() =>
      parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "controlled",
              transport: "stdio",
              command: "fixture-mcp",
              tools: [{ id: "echo" }],
            },
          ],
        }),
      ),
    ).toThrow(/Unrecognized key: "tools"/u);

    const encoded = parseNativeMcpConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "encoded",
            transport: "streamable-http",
            url: "https://mcp.example.test/rpc",
            credentialHeaders: { "X-Service": "%41%42" },
          },
        ],
      }),
    ).servers[0];
    if (encoded === undefined) throw new Error("missing encoded credential fixture");
    expect(configuredMcpDefinitionSecrets(encoded)).not.toContain("AB");
  });

  it("keeps DSH inventory out of the Action plan and audits external GitHub authority by owner", () => {
    const githubCredential = "github-mcp-owned-secret";
    const pluginCredential = "plugin-owned-secret";
    const plan = resolve({
      mcp: parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "github-external",
              transport: "stdio",
              command: "github-mcp-server",
              credentialEnv: { SERVICE_VALUE: githubCredential },
              network: true,
              toolCallTimeoutMs: 10_000,
            },
            {
              id: "remote",
              transport: "streamable-http",
              url: "https://mcp.example.test/rpc/private-route-value",
              credentialHeaders: { "X-Service": "Bearer remote-owned-secret" },
            },
          ],
        }),
      ),
      plugins: parseNativePluginConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          bundles: [{ id: "bundle", package: "native-bundle", source: "1.2.3" }],
          plugins: [
            {
              id: "plugin",
              package: "native-plugin",
              source: "2.3.4",
              credentialConfig: { connection: pluginCredential },
            },
          ],
        }),
      ),
      allowPluginInstall: true,
    });

    expect(plan.profileName).toBe("headless-native");
    expect(plan.network).toBe(true);
    expect(plan.audit.workerNetwork).toBe(true);
    expect(plan).not.toHaveProperty("tools");
    expect(plan).not.toHaveProperty("manifests");
    expect(plan.audit.entries).toEqual([
      expect.objectContaining({
        id: "github-external",
        kind: "mcp",
        source: "github-mcp-server",
        inventoryOwner: "dsh",
      }),
      expect.objectContaining({
        id: "remote",
        kind: "mcp",
        source: "https://mcp.example.test",
        requestsNetwork: true,
      }),
      expect.objectContaining({ id: "bundle", kind: "bundle", source: "1.2.3" }),
      expect.objectContaining({ id: "plugin", kind: "plugin", source: "2.3.4" }),
    ]);
    const remoteDefinition = plan.mcpServers.find(
      ({ definition }) => definition.id === "remote",
    )?.definition;
    if (remoteDefinition === undefined) throw new Error("missing native HTTP definition");
    expect(configuredMcpDefinitionSecrets(remoteDefinition)).toEqual(
      expect.arrayContaining(["Bearer remote-owned-secret", "remote-owned-secret"]),
    );

    const authority = buildAuthorityAudit(plan);
    expect(authority.knownSources).toContainEqual(
      expect.objectContaining({ kind: "controller-credential", service: "github" }),
    );
    expect(authority.knownSources).toContainEqual({
      kind: "extension-credential",
      extensionKind: "mcp",
      extensionId: "github-external",
      provisionedBy: "workflow",
      configuredFor: "worker-extension",
    });
    expect(authority.knownSources).toContainEqual(
      expect.objectContaining({
        kind: "extension-credential",
        extensionKind: "plugin",
        extensionId: "plugin",
      }),
    );
    const publicAudit = JSON.stringify({ audit: plan.audit, authority });
    for (const secret of [githubCredential, pluginCredential, "remote-owned-secret"]) {
      expect(publicAudit).not.toContain(secret);
      expect(publicAudit).not.toContain(createHash("sha256").update(secret).digest("hex"));
    }
    const externalGitHub = authority.knownSources.find(
      (source) =>
        source.kind === "extension-credential" && source.extensionId === "github-external",
    );
    expect(externalGitHub).not.toHaveProperty("gateway");
    expect(externalGitHub).not.toHaveProperty("revalidation");
    expect(externalGitHub).not.toHaveProperty("mediation");
  });

  it("fails closed on untrusted, write, network, and package-install authority", () => {
    const networkMcp = parseNativeMcpConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          { id: "remote", transport: "streamable-http", url: "https://mcp.example.test/rpc" },
        ],
      }),
    );
    expect(() =>
      resolve({
        mcp: networkMcp,
        policy: policy({
          capabilities: { ...policy().capabilities, accessNetwork: false },
        }),
      }),
    ).toThrow(/bridge networking is denied/u);

    const writeMcp = parseNativeMcpConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        servers: [
          {
            id: "writer",
            transport: "stdio",
            command: "writer-mcp",
            workspaceWrite: true,
          },
        ],
      }),
    );
    expect(() => resolve({ mcp: writeMcp })).toThrow(/requires trusted-write/u);
    expect(() =>
      resolve({
        mcp: writeMcp,
        policy: policy({ trust: "untrusted" }),
      }),
    ).toThrow(/trusted same-repository workflow/u);

    const packageConfig = parseNativePluginConfiguration(
      JSON.stringify({
        schemaVersion: 1,
        bundles: [{ id: "bundle", package: "native-bundle", source: "1.2.3" }],
        plugins: [],
      }),
    );
    expect(() => resolve({ plugins: packageConfig })).toThrow(/installation is disabled/u);
  });
});
