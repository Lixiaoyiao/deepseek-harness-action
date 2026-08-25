import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  buildControllerToolPolicyAudit,
  buildDshToolPolicyAudit,
  buildPermissionAudit,
} from "../src/permissions/profile.js";
import {
  resolveExtensionPlan,
  resolveNativeExtensionPlan,
  type ExtensionPlan,
  type NativeExtensionPlan,
} from "../src/extensions/plan.js";
import {
  parseMcpConfiguration,
  parseNativeMcpConfiguration,
  parseNativePluginConfiguration,
  parsePluginConfiguration,
} from "../src/extensions/schema.js";
import { loadInputs } from "../src/inputs.js";
import { buildAuthorityAudit } from "../src/security/authority.js";
import {
  assertNoSecretOutput,
  buildDshWorkerEnvironment,
  redactKnownSecrets,
} from "../src/security/env.js";
import { evaluatePolicy, type SecurityPolicy } from "../src/security/policy.js";
import { selectDshComposition } from "../src/dsh/select-composition.js";
import { CONTROLLER_BUILTIN_CAPABILITY_CONTRACTS } from "../src/tools/capabilities.js";
import { resolveEffectiveTools } from "../src/tools/registry.js";
import {
  parseToolConfiguration,
  type AllowedToolId,
  type GitHubToolId,
  type NativeToolId,
} from "../src/tools/schema.js";
import { permissions, pullRequestContext } from "./helpers.js";

const MATRIX_AXES = {
  mode: ["controlled", "native"],
  trust: ["untrusted", "trusted-read", "trusted-write"],
  profile: ["strict", "standard", "custom"],
  isolation: ["docker", "none"],
  extensionAuthority: ["none", "network", "workspace-write", "both"],
  githubAuthority: ["none", "read", "write"],
} as const;

type MatrixAxes = typeof MATRIX_AXES;
type AxisName = keyof MatrixAxes;
type MatrixRow = { [K in AxisName]: MatrixAxes[K][number] };
type Trust = MatrixRow["trust"];
type ExtensionAuthority = MatrixRow["extensionAuthority"];

const AXIS_NAMES = Object.keys(MATRIX_AXES) as AxisName[];
const REQUIRED_NATIVE_VALID_ROWS = [
  {
    mode: "native",
    trust: "trusted-read",
    profile: "strict",
    isolation: "docker",
    extensionAuthority: "none",
    githubAuthority: "none",
  },
  {
    mode: "native",
    trust: "trusted-read",
    profile: "standard",
    isolation: "docker",
    extensionAuthority: "network",
    githubAuthority: "read",
  },
  {
    mode: "native",
    trust: "trusted-write",
    profile: "custom",
    isolation: "docker",
    extensionAuthority: "both",
    githubAuthority: "write",
  },
] as const satisfies readonly MatrixRow[];

function isValidMatrixRow(row: MatrixRow): boolean {
  if (row.mode === "native" && row.isolation !== "docker") return false;
  if (row.extensionAuthority !== "none" && row.isolation !== "docker") return false;
  if (
    row.mode === "controlled" &&
    row.profile === "standard" &&
    row.extensionAuthority !== "none"
  ) {
    return false;
  }
  return true;
}

function cartesianRows(): MatrixRow[] {
  let rows: Record<string, string>[] = [{}];
  for (const axis of AXIS_NAMES) {
    rows = rows.flatMap((row) => MATRIX_AXES[axis].map((value) => ({ ...row, [axis]: value })));
  }
  return (rows as MatrixRow[]).filter((row) => isValidMatrixRow(row));
}

function pairTokens(row: MatrixRow): string[] {
  const tokens: string[] = [];
  for (let left = 0; left < AXIS_NAMES.length; left += 1) {
    for (let right = left + 1; right < AXIS_NAMES.length; right += 1) {
      const leftAxis = AXIS_NAMES[left];
      const rightAxis = AXIS_NAMES[right];
      if (leftAxis === undefined || rightAxis === undefined) continue;
      tokens.push(`${leftAxis}=${row[leftAxis]}|${rightAxis}=${row[rightAxis]}`);
    }
  }
  return tokens;
}

/** Deterministic greedy covering array; ties retain cartesian declaration order. */
function buildPairwiseMatrix(): MatrixRow[] {
  const candidates = cartesianRows();
  const uncovered = new Set(candidates.flatMap((row) => pairTokens(row)));
  const selected: MatrixRow[] = [];

  for (const required of REQUIRED_NATIVE_VALID_ROWS) {
    const index = candidates.findIndex((candidate) =>
      AXIS_NAMES.every((axis) => candidate[axis] === required[axis]),
    );
    if (index < 0) throw new Error("Required native pairwise row is not a valid candidate");
    const [candidate] = candidates.splice(index, 1);
    if (candidate === undefined) throw new Error("Required native pairwise row disappeared");
    selected.push(candidate);
    for (const token of pairTokens(candidate)) uncovered.delete(token);
  }

  while (uncovered.size > 0) {
    let bestIndex = -1;
    let bestCoverage: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
      const coverage = pairTokens(candidate).filter((token) => uncovered.has(token));
      if (coverage.length > bestCoverage.length) {
        bestIndex = index;
        bestCoverage = coverage;
      }
    }
    if (bestIndex < 0 || bestCoverage.length === 0) {
      throw new Error("Unable to construct the deterministic security pairwise matrix");
    }
    const [best] = candidates.splice(bestIndex, 1);
    if (best === undefined) throw new Error("Pairwise candidate disappeared");
    selected.push(best);
    for (const token of bestCoverage) uncovered.delete(token);
  }
  return selected;
}

const PAIRWISE_MATRIX = buildPairwiseMatrix();
const EMPTY_TOOL_CONFIGURATION = parseToolConfiguration('{"schemaVersion":1,"commands":[]}');
const ALL_BUILTINS = CONTROLLER_BUILTIN_CAPABILITY_CONTRACTS.map(({ manifest }) => manifest.id);
const PULL_BINDING = {
  repositoryId: 1,
  owner: "octo",
  repo: "repo",
  target: "pull_request",
  entityNumber: 7,
  headSha: "a".repeat(40),
  headRef: "feature",
  headRepositoryId: 1,
  baseSha: "b".repeat(40),
  baseRef: "main",
  baseRepositoryId: 1,
} as const;

function sorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function inputReader(values: Readonly<Record<string, string>>) {
  return (name: string): string => values[name] ?? "";
}

function policyFor(trust: Trust, githubAuthority: MatrixRow["githubAuthority"]): SecurityPolicy {
  const operation =
    trust === "trusted-write" ? "fix" : githubAuthority === "read" ? "diagnose" : "review";
  const policy = evaluatePolicy({
    context: pullRequestContext({ fork: trust === "untrusted" }),
    operation,
    allowWrite: trust === "trusted-write",
    permissions: permissions(trust !== "untrusted"),
    commandSource: "automatic-event",
  });
  expect(policy.trust).toBe(trust);
  return policy;
}

function requestedTools(row: MatrixRow): AllowedToolId[] {
  const allowed: AllowedToolId[] = row.profile === "custom" ? [...ALL_BUILTINS] : [];
  if (row.mode === "controlled" && row.extensionAuthority !== "none") {
    allowed.push("mcp.matrix.capability");
  }
  if (row.githubAuthority === "read") allowed.push("github.checks.read");
  if (row.githubAuthority === "write") allowed.push("github.comment.create");
  return allowed;
}

function expectedBuiltinIds(row: MatrixRow): NativeToolId[] {
  const trustedDocker = row.trust !== "untrusted" && row.isolation === "docker";
  const writeDocker = row.trust === "trusted-write" && row.isolation === "docker";
  const autonomyRequested = row.profile !== "strict";
  return [
    ...(trustedDocker ? (["workspace.read", "workspace.search"] as const) : []),
    ...(writeDocker ? (["workspace.edit"] as const) : []),
    ...(writeDocker && autonomyRequested ? (["native.bash"] as const) : []),
    ...(trustedDocker && autonomyRequested ? (["native.web-search"] as const) : []),
    ...(writeDocker && autonomyRequested ? (["native.subagent"] as const) : []),
  ];
}

function expectedGitHubIds(row: MatrixRow): GitHubToolId[] {
  if (row.githubAuthority === "read" && row.trust !== "untrusted") {
    return ["github.checks.read"];
  }
  if (row.githubAuthority === "write" && row.trust === "trusted-write") {
    return ["github.comment.create"];
  }
  return [];
}

function authorityFlags(authority: ExtensionAuthority): {
  readonly network: boolean;
  readonly workspaceWrite: boolean;
} {
  return {
    network: authority === "network" || authority === "both",
    workspaceWrite: authority === "workspace-write" || authority === "both",
  };
}

function controlledMcpRaw(authority: Exclude<ExtensionAuthority, "none">): string {
  const { network, workspaceWrite } = authorityFlags(authority);
  const permissions = [
    "read",
    ...(network ? ["network"] : []),
    ...(workspaceWrite ? ["workspace-write"] : []),
  ];
  return JSON.stringify({
    schemaVersion: 1,
    servers: [
      {
        id: "matrix",
        transport: "stdio",
        command: "matrix-mcp-server",
        network,
        tools: [
          {
            id: "capability",
            name: "matrix_capability",
            description: "Exercise the matrix extension authority.",
            permissions,
          },
        ],
      },
    ],
  });
}

function nativeMcpRaw(authority: Exclude<ExtensionAuthority, "none">): string {
  const { network, workspaceWrite } = authorityFlags(authority);
  const servers = [
    ...(network
      ? [
          {
            id: "network-owner",
            transport: "stdio" as const,
            command: "network-mcp-server",
            network: true,
            workspaceWrite: false,
          },
        ]
      : []),
    ...(workspaceWrite
      ? [
          {
            id: "write-owner",
            transport: "stdio" as const,
            command: "write-mcp-server",
            network: false,
            workspaceWrite: true,
          },
        ]
      : []),
  ];
  return JSON.stringify({ schemaVersion: 1, servers });
}

function controlledExtensionPlan(
  authority: Exclude<ExtensionAuthority, "none">,
  policy: SecurityPolicy,
): ExtensionPlan {
  return resolveExtensionPlan({
    allowedTools: ["mcp.matrix.capability"],
    mcp: parseMcpConfiguration(controlledMcpRaw(authority)),
    plugins: parsePluginConfiguration('{"schemaVersion":1}'),
    allowPluginInstall: false,
    policy,
  });
}

function nativeExtensionPlan(
  authority: Exclude<ExtensionAuthority, "none">,
  policy: SecurityPolicy,
): NativeExtensionPlan {
  return resolveNativeExtensionPlan({
    mcp: parseNativeMcpConfiguration(nativeMcpRaw(authority)),
    plugins: parseNativePluginConfiguration('{"schemaVersion":1,"bundles":[],"plugins":[]}'),
    allowPluginInstall: false,
    policy,
  });
}

function extensionAdmissionAllowed(row: MatrixRow): boolean {
  if (row.extensionAuthority === "none" || row.trust === "untrusted") return false;
  const { workspaceWrite } = authorityFlags(row.extensionAuthority);
  if (workspaceWrite && row.trust !== "trusted-write") return false;
  if (row.mode === "controlled" && row.trust === "trusted-write" && !workspaceWrite) {
    return false;
  }
  return true;
}

function rowInputValues(row: MatrixRow): Readonly<Record<string, string>> {
  return {
    "deepseek-api-key": "controller-deepseek-key",
    "github-token": "controller-github-token",
    "dsh-mode": row.mode,
    isolation: row.isolation,
    "permission-profile": row.profile,
    "allowed-tools": JSON.stringify(requestedTools(row)),
    ...(row.extensionAuthority === "none"
      ? {}
      : {
          "mcp-config":
            row.mode === "native"
              ? nativeMcpRaw(row.extensionAuthority)
              : controlledMcpRaw(row.extensionAuthority),
        }),
  };
}

describe("deterministic security invariant matrix", () => {
  it("is a strict pairwise covering array across every declared security axis", () => {
    const allRows = cartesianRows();
    expect(PAIRWISE_MATRIX.length).toBeLessThan(allRows.length);
    expect(PAIRWISE_MATRIX.every((row) => isValidMatrixRow(row))).toBe(true);
    expect(new Set(PAIRWISE_MATRIX.flatMap((row) => pairTokens(row)))).toEqual(
      new Set(allRows.flatMap((row) => pairTokens(row))),
    );
    const nativeRows = PAIRWISE_MATRIX.filter(({ mode }) => mode === "native");
    expect(new Set(nativeRows.map(({ isolation }) => isolation))).toEqual(new Set(["docker"]));
    expect(new Set(nativeRows.map(({ profile }) => profile))).toEqual(new Set(MATRIX_AXES.profile));
    expect(new Set(nativeRows.map(({ trust }) => trust))).toEqual(new Set(MATRIX_AXES.trust));
    expect(new Set(nativeRows.map(({ extensionAuthority }) => extensionAuthority))).toEqual(
      new Set(MATRIX_AXES.extensionAuthority),
    );
    expect(new Set(nativeRows.map(({ githubAuthority }) => githubAuthority))).toEqual(
      new Set(MATRIX_AXES.githubAuthority),
    );
    expect(
      new Set(
        nativeRows
          .filter(
            (row) =>
              row.trust !== "untrusted" &&
              (row.extensionAuthority === "none" || extensionAdmissionAllowed(row)),
          )
          .map(({ profile }) => profile),
      ),
    ).toEqual(new Set(MATRIX_AXES.profile));
  });

  it.each(PAIRWISE_MATRIX)(
    "preserves capability invariants for $mode/$trust/$profile/$isolation/$extensionAuthority/$githubAuthority",
    (row) => {
      expect(loadInputs(inputReader(rowInputValues(row)))).toMatchObject({
        dshMode: row.mode,
        isolation: row.isolation,
        permissionProfile: row.profile,
      });
      const policy = policyFor(row.trust, row.githubAuthority);
      const effective = resolveEffectiveTools(
        requestedTools(row),
        EMPTY_TOOL_CONFIGURATION,
        policy,
        {
          permissionProfile: row.profile,
          isolation: row.isolation,
          githubBinding: PULL_BINDING,
          allowWrite: true,
        },
      );

      expect(sorted(effective.native)).toEqual(sorted(expectedBuiltinIds(row)));
      expect(effective.github).toEqual(expectedGitHubIds(row));
      expect(effective.commands).toEqual([]);
      expect(sorted(effective.manifests.map(({ id }) => id))).toEqual(
        sorted([...effective.native, ...effective.github]),
      );

      const workspaceWrite = effective.manifests.some(({ permissions: tags }) =>
        tags.includes("write"),
      );
      expect(workspaceWrite).toBe(row.trust === "trusted-write" && row.isolation === "docker");

      if (row.trust === "untrusted") {
        expect(policy.capabilities).toMatchObject({
          executeRepositoryCode: false,
          loadExtensions: false,
          modifyWorkspace: false,
          commit: false,
          push: false,
          createPullRequest: false,
          manageIssueLabels: false,
          manageIssueAssignees: false,
          updateIssueState: false,
          updatePullRequestMetadata: false,
        });
        expect(effective.native).toEqual([]);
        expect(effective.github).toEqual([]);
        expect(
          effective.manifests.some(({ permissions: tags }) =>
            tags.some((tag) => tag === "execute" || tag === "write" || tag === "github-write"),
          ),
        ).toBe(false);
      }

      if (row.extensionAuthority !== "none" && row.trust === "untrusted") {
        expect(policy.capabilities.loadExtensions).toBe(false);
        const flags = authorityFlags(row.extensionAuthority);
        if (flags.network) expect(policy.capabilities.accessNetwork).toBe(false);
        if (flags.workspaceWrite) expect(policy.capabilities.modifyWorkspace).toBe(false);
      }

      let extensions: ExtensionPlan | undefined;
      const extensionAuthority = row.extensionAuthority;
      if (extensionAuthority !== "none") {
        const resolve = (): ExtensionPlan =>
          row.mode === "native"
            ? nativeExtensionPlan(extensionAuthority, policy)
            : controlledExtensionPlan(extensionAuthority, policy);
        if (extensionAdmissionAllowed(row)) {
          extensions = resolve();
          const flags = authorityFlags(extensionAuthority);
          expect(extensions.network).toBe(flags.network);
          if (extensions.profileName === "headless-native") {
            expect(extensions.workspaceWrite).toBe(flags.workspaceWrite);
            expect(extensions.audit.workerNetwork).toBe(flags.network);
          } else {
            expect(extensions.audit.network).toBe(flags.network);
          }
        } else {
          expect(resolve).toThrow();
        }
      }

      const extensionManifests =
        extensions?.profileName === "github-action" ? extensions.manifests : [];
      const actualManifests = [...effective.manifests, ...extensionManifests];

      const permission = buildPermissionAudit({
        resolution: effective.permission,
        manifests: actualManifests,
        additionalDenials: effective.permissionDenials,
        ...(extensions === undefined ? {} : { extensions: extensions.audit }),
      });
      expect(permission.effectiveTools).toEqual(sorted(actualManifests.map(({ id }) => id)));
      if (extensions !== undefined) {
        expect(permission.trustedExtensions).toHaveLength(extensions.audit.entries.length);
        if (extensions.profileName === "headless-native") {
          const flags = authorityFlags(row.extensionAuthority);
          for (const owner of permission.trustedExtensions) {
            expect(owner.network).toBe(flags.network);
            expect(owner.workspaceWrite).toBe(permission.workspaceWrite);
          }
        }
      }

      const selection = selectDshComposition(row.mode);
      if (row.mode === "controlled") {
        expect(selection.toolPolicyOwner).toBe("controller");
        const audit = buildControllerToolPolicyAudit(permission, "controller");
        expect(audit.policyOwner).toBe("controller");
        expect(audit.effectiveTools).toEqual(permission.effectiveTools);
        expect(audit).not.toHaveProperty("observedTools");
      } else {
        expect(selection.toolPolicyOwner).toBe("dsh");
        const audit = buildDshToolPolicyAudit(["read", "glob", "grep", "read"]);
        expect(audit).toEqual({
          schemaVersion: 1,
          policyOwner: "dsh",
          observedTools: ["glob", "grep", "read"],
        });
        expect(Object.keys(audit).sort()).toEqual([
          "observedTools",
          "policyOwner",
          "schemaVersion",
        ]);
        expect(audit).not.toHaveProperty("effectiveTools");
        expect(audit).not.toHaveProperty("requestedTools");
        expect(audit).not.toHaveProperty("deniedTools");
      }
    },
  );

  it.each([
    {
      mode: "native",
      trust: "trusted-read",
      profile: "strict",
      isolation: "none",
      extensionAuthority: "none",
      githubAuthority: "none",
    },
    {
      mode: "native",
      trust: "trusted-read",
      profile: "standard",
      isolation: "none",
      extensionAuthority: "network",
      githubAuthority: "read",
    },
    {
      mode: "native",
      trust: "trusted-write",
      profile: "custom",
      isolation: "none",
      extensionAuthority: "workspace-write",
      githubAuthority: "write",
    },
  ] as const)(
    "rejects invalid native host row for $profile/$extensionAuthority/$githubAuthority",
    (row) => {
      expect(isValidMatrixRow(row)).toBe(false);
      expect(() => loadInputs(inputReader(rowInputValues(row)))).toThrow(
        /dsh-mode native requires Docker isolation/u,
      );
    },
  );

  it.each(["network", "workspace-write", "both"] as const)(
    "rejects controlled standard profile with %s extension authority outside the valid matrix",
    (extensionAuthority) => {
      const row: MatrixRow = {
        mode: "controlled",
        trust: extensionAuthority === "network" ? "trusted-read" : "trusted-write",
        profile: "standard",
        isolation: "docker",
        extensionAuthority,
        githubAuthority: extensionAuthority === "network" ? "read" : "write",
      };
      expect(isValidMatrixRow(row)).toBe(false);
      expect(() => loadInputs(inputReader(rowInputValues(row)))).toThrow(
        /requires permission-profile custom/u,
      );
    },
  );

  it.each([
    {
      mode: "controlled",
      trust: "trusted-write",
      profile: "strict",
      isolation: "docker",
      denied: "workspace.edit",
    },
    {
      mode: "native",
      trust: "trusted-read",
      profile: "standard",
      isolation: "docker",
      denied: "native.web-search",
    },
    {
      mode: "controlled",
      trust: "trusted-write",
      profile: "custom",
      isolation: "none",
      denied: "github.comment.create",
    },
    {
      mode: "native",
      trust: "untrusted",
      profile: "custom",
      isolation: "docker",
      denied: "workspace.read",
    },
  ] as const)(
    "gives explicit deny precedence for $mode/$trust/$profile/$isolation/$denied",
    ({ trust, profile, isolation, denied }) => {
      const allowed: AllowedToolId[] =
        profile === "custom" ? [...ALL_BUILTINS, "github.comment.create"] : [];
      const effective = resolveEffectiveTools(
        allowed,
        EMPTY_TOOL_CONFIGURATION,
        policyFor(trust, denied === "github.comment.create" ? "write" : "none"),
        {
          permissionProfile: profile,
          disallowedTools: [denied],
          isolation,
          githubBinding: PULL_BINDING,
          allowWrite: true,
        },
      );

      expect(effective.manifests.map(({ id }) => id)).not.toContain(denied);
      expect(effective.permissionDenials).toContainEqual({
        id: denied,
        reason: "Explicit disallowed-tools entry; deny always wins",
      });
    },
  );

  it.each(["controlled", "native"] as const)(
    "keeps Controller GitHub authority orthogonal to %s DSH composition ownership",
    (mode) => {
      const policy = policyFor("trusted-write", "write");
      const effective = resolveEffectiveTools(
        ["github.comment.create"],
        EMPTY_TOOL_CONFIGURATION,
        policy,
        {
          permissionProfile: "custom",
          isolation: "docker",
          githubBinding: PULL_BINDING,
          allowWrite: true,
        },
      );

      expect(selectDshComposition(mode).toolPolicyOwner).toBe(
        mode === "controlled" ? "controller" : "dsh",
      );
      expect(effective.github).toEqual(["github.comment.create"]);
      expect(effective.manifests.map(({ id }) => id)).toEqual(["github.comment.create"]);
    },
  );
});

describe("extension whole-worker and credential invariants", () => {
  it.each([
    ["controlled", "untrusted", "network", false],
    ["controlled", "trusted-read", "network", true],
    ["controlled", "trusted-read", "workspace-write", false],
    ["controlled", "trusted-write", "workspace-write", true],
    ["controlled", "trusted-write", "both", true],
    ["native", "untrusted", "network", false],
    ["native", "trusted-read", "network", true],
    ["native", "trusted-read", "workspace-write", false],
    ["native", "trusted-write", "network", true],
    ["native", "trusted-write", "workspace-write", true],
    ["native", "trusted-write", "both", true],
  ] as const)(
    "%s extension authority is fail-closed for %s/%s (allowed=%s)",
    (mode, trust, authority, allowed) => {
      const policy = policyFor(trust, "none");
      const resolve = (): ExtensionPlan =>
        mode === "native"
          ? nativeExtensionPlan(authority, policy)
          : controlledExtensionPlan(authority, policy);

      if (!allowed) {
        expect(resolve).toThrow();
        return;
      }

      const plan = resolve();
      const flags = authorityFlags(authority);
      expect(plan.network).toBe(flags.network);
      if (plan.profileName === "headless-native") {
        expect(plan.workspaceWrite).toBe(flags.workspaceWrite);
        expect(plan.audit.workerNetwork).toBe(flags.network);
        expect(plan.audit.entries.some(({ requestsNetwork }) => requestsNetwork)).toBe(
          flags.network,
        );
        expect(
          plan.audit.entries.some(({ requestsWorkspaceWrite }) => requestsWorkspaceWrite),
        ).toBe(flags.workspaceWrite);
      } else {
        expect(plan.audit.network).toBe(flags.network);
        expect(
          plan.audit.entries.some(({ tools }) =>
            tools.some(({ permissions: tags }) => tags.includes("workspace-write")),
          ),
        ).toBe(flags.workspaceWrite);
      }
    },
  );

  it("projects split native owner requests into one whole-worker network/write boundary", () => {
    const plan = nativeExtensionPlan("both", policyFor("trusted-write", "none"));
    const networkOwner = plan.audit.entries.find(({ id }) => id === "network-owner");
    const writeOwner = plan.audit.entries.find(({ id }) => id === "write-owner");

    expect(networkOwner).toMatchObject({
      requestsNetwork: true,
      requestsWorkspaceWrite: false,
      inventoryOwner: "dsh",
    });
    expect(writeOwner).toMatchObject({
      requestsNetwork: false,
      requestsWorkspaceWrite: true,
      inventoryOwner: "dsh",
    });
    expect(plan).toMatchObject({ network: true, workspaceWrite: true });
    expect(plan.audit.workerNetwork).toBe(true);
  });

  it("keeps extension and authority audit serialization free of secret values and hashes", () => {
    const mcpSecret = "matrix-mcp-owned-secret";
    const pluginSecret = "matrix-plugin-owned-secret";
    const plan = resolveNativeExtensionPlan({
      mcp: parseNativeMcpConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          servers: [
            {
              id: "credential-mcp",
              transport: "stdio",
              command: "credential-mcp-server",
              credentialEnv: { SERVICE_VALUE: mcpSecret },
            },
          ],
        }),
      ),
      plugins: parseNativePluginConfiguration(
        JSON.stringify({
          schemaVersion: 1,
          bundles: [],
          plugins: [
            {
              id: "credential-plugin",
              package: "native-credential-plugin",
              source: "1.2.3",
              credentialConfig: { connection: pluginSecret },
            },
          ],
        }),
      ),
      allowPluginInstall: true,
      policy: policyFor("trusted-read", "none"),
    });
    const publicAudit = JSON.stringify({
      extensions: plan.audit,
      authority: buildAuthorityAudit(plan),
    });

    expect(publicAudit).not.toContain("credentialEnv");
    expect(publicAudit).not.toContain("credentialConfig");
    for (const secret of [mcpSecret, pluginSecret]) {
      expect(publicAudit).not.toContain(secret);
      expect(publicAudit).not.toContain(createHash("sha256").update(secret).digest("hex"));
    }
  });

  it("filters Controller credentials from worker env and rejects them in argv/result channels", () => {
    const githubSecret = "controller-github-secret";
    const deepseekSecret = "controller-deepseek-secret";
    const oidcSecret = "controller-oidc-secret";
    const proxyToken = "ephemeral-worker-proxy-token";
    const secrets = [githubSecret, deepseekSecret, oidcSecret];
    const workerEnvironment = buildDshWorkerEnvironment({
      source: {
        PATH: "/usr/bin",
        GITHUB_TOKEN: githubSecret,
        GH_TOKEN: githubSecret,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidcSecret,
        DEEPSEEK_API_KEY: deepseekSecret,
      },
      dshHome: "/tmp/dsh-home",
      permissionMode: "read-only",
      proxyBaseUrl: "http://127.0.0.1:43210",
      proxyToken,
      realDeepSeekApiKey: deepseekSecret,
    });

    expect(workerEnvironment).toMatchObject({
      PATH: "/usr/bin",
      DEEPSEEK_API_KEY: proxyToken,
      DSH_PERMISSION_MODE: "read-only",
    });
    expect(workerEnvironment).not.toHaveProperty("GITHUB_TOKEN");
    expect(workerEnvironment).not.toHaveProperty("GH_TOKEN");
    expect(workerEnvironment).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
    const serializedEnvironment = JSON.stringify(workerEnvironment);
    for (const secret of secrets) expect(serializedEnvironment).not.toContain(secret);

    const safeArgv = JSON.stringify(["node", "native-launcher.mjs", "review repository"]);
    expect(() => assertNoSecretOutput("argv", safeArgv, secrets)).not.toThrow();
    for (const secret of secrets) {
      expect(() => assertNoSecretOutput("argv", `${safeArgv}${secret}`, secrets)).toThrow(
        /credential/u,
      );
    }

    const redactedResult = redactKnownSecrets(
      JSON.stringify({ summary: deepseekSecret, receipt: githubSecret, authority: oidcSecret }),
      secrets,
    );
    expect(redactedResult).toContain("[REDACTED]");
    for (const secret of secrets) expect(redactedResult).not.toContain(secret);
    expect(() => assertNoSecretOutput("tool receipt", redactedResult, secrets)).not.toThrow();
  });
});
