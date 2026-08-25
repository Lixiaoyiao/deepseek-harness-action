import { createHash } from "node:crypto";

import { z } from "zod";

import type { AgentToolManifest } from "../agent/contracts.js";
import type { AnyExtensionAudit } from "../extensions/plan.js";
import {
  autonomyToolSchema,
  type AllowedToolId,
  type AutonomyToolId,
  type ToolPolicyOwner,
} from "../tools/schema.js";

export const permissionProfileSchema = z.enum(["strict", "standard", "custom"]);
export type PermissionProfile = z.infer<typeof permissionProfileSchema>;

export const STRICT_PERMISSION_TOOLS = [
  "workspace.read",
  "workspace.search",
  "workspace.edit",
] as const satisfies readonly AllowedToolId[];

export const STANDARD_PERMISSION_TOOLS = [
  ...STRICT_PERMISSION_TOOLS,
  "native.bash",
  "native.web-search",
  "native.subagent",
] as const satisfies readonly AllowedToolId[];

export interface ToolDenial {
  readonly id: AllowedToolId;
  readonly reason: string;
}

interface ToolPolicyAuditBase {
  readonly schemaVersion: 1;
  readonly policyOwner: ToolPolicyOwner;
}

/** Controller-owned policy: this is the exact model-visible grant, not runtime telemetry. */
export interface ControllerToolPolicyAudit extends ToolPolicyAuditBase {
  readonly policyOwner: "controller";
  /** Canonical capabilities requested by the workflow/profile before policy intersection. */
  readonly requestedTools: readonly AllowedToolId[];
  readonly effectiveTools: readonly string[];
  readonly deniedTools: readonly ToolDenial[];
  readonly observedTools?: never;
}

/** DSH-owned runtime inventory observation; it is not a Controller grant. */
export interface DshToolPolicyAudit extends ToolPolicyAuditBase {
  readonly policyOwner: "dsh";
  /** Names actually observed by the DSH runtime; telemetry, not a Controller grant. */
  readonly observedTools: readonly string[];
  readonly requestedTools?: never;
  readonly deniedTools?: never;
  readonly effectiveTools?: never;
}

export type ToolPolicyAudit = ControllerToolPolicyAudit | DshToolPolicyAudit;

export interface PermissionResolution {
  readonly profile: PermissionProfile;
  readonly requestedTools: readonly AllowedToolId[];
  readonly disallowedTools: readonly AllowedToolId[];
  readonly deniedTools: readonly ToolDenial[];
}

export interface PermissionAudit {
  readonly schemaVersion: 1;
  readonly digest: string;
  readonly profile: PermissionProfile;
  readonly requestedTools: readonly AllowedToolId[];
  readonly disallowedTools: readonly AllowedToolId[];
  readonly effectiveTools: readonly string[];
  readonly deniedTools: readonly ToolDenial[];
  /** Physical worker network path, not merely general Internet authority. */
  readonly network: "host-gateway" | "mediated-web" | "bridge";
  readonly workspaceWrite: boolean;
  readonly extensionDigest?: string;
  readonly trustedExtensions: readonly {
    readonly id: string;
    readonly kind: "mcp" | "bundle" | "plugin";
    readonly network: boolean;
    readonly workspaceWrite: boolean;
  }[];
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function assertPermissionProfileConfiguration(
  profile: PermissionProfile,
  allowedTools: readonly AllowedToolId[],
): void {
  if (profile !== "strict") return;
  const autonomy = allowedTools.find(
    (id): id is AutonomyToolId => autonomyToolSchema.safeParse(id).success,
  );
  if (autonomy !== undefined) {
    throw new Error(
      `permission-profile strict does not expose ${autonomy}; select standard or custom explicitly`,
    );
  }
}

/** Resolve preset additions and explicit deny precedence before trust-policy intersection. */
export function resolvePermissionRequest(
  profile: PermissionProfile,
  allowedTools: readonly AllowedToolId[],
  disallowedTools: readonly AllowedToolId[],
): PermissionResolution {
  assertPermissionProfileConfiguration(profile, allowedTools);
  const requestedTools = sortedUnique([
    ...(profile === "standard"
      ? STANDARD_PERMISSION_TOOLS
      : profile === "strict"
        ? STRICT_PERMISSION_TOOLS
        : []),
    ...allowedTools,
  ]);
  const denied = new Set(disallowedTools);
  return {
    profile,
    requestedTools,
    disallowedTools: sortedUnique(disallowedTools),
    deniedTools: requestedTools
      .filter((id) => denied.has(id))
      .map((id) => ({ id, reason: "Explicit disallowed-tools entry; deny always wins" })),
  };
}

export function buildPermissionAudit(options: {
  readonly resolution: PermissionResolution;
  readonly manifests: readonly AgentToolManifest[];
  readonly additionalDenials?: readonly ToolDenial[];
  readonly extensions?: AnyExtensionAudit;
  readonly mediatedWeb?: boolean;
}): PermissionAudit {
  const effectiveTools = sortedUnique(options.manifests.map(({ id }) => id));
  const effective = new Set(effectiveTools);
  const deniedById = new Map<AllowedToolId, ToolDenial>();
  for (const denial of [...options.resolution.deniedTools, ...(options.additionalDenials ?? [])]) {
    deniedById.set(denial.id, denial);
  }
  for (const id of options.resolution.requestedTools) {
    if (!effective.has(id) && !deniedById.has(id)) {
      deniedById.set(id, {
        id,
        reason: "The Controller trust policy or configured provider did not grant this tool",
      });
    }
  }
  const commandBridge = options.manifests.some(
    ({ provider, permissions }) => provider === "command" && permissions.includes("network"),
  );
  const extensionBridge =
    options.extensions?.profile === "github-action"
      ? options.extensions.network
      : options.extensions?.workerNetwork === true;
  const bridge = commandBridge || extensionBridge;
  const mediatedWeb = options.mediatedWeb ?? effective.has("native.web-search");
  const network: PermissionAudit["network"] = bridge
    ? "bridge"
    : mediatedWeb
      ? "mediated-web"
      : "host-gateway";
  const nativeExtensions =
    options.extensions?.profile === "headless-native" ? options.extensions : undefined;
  const controlledExtensions =
    options.extensions?.profile === "github-action" ? options.extensions : undefined;
  const trustedExtensions =
    nativeExtensions !== undefined
      ? nativeExtensions.entries.map(({ id, kind }) => ({
          id,
          kind,
          network: nativeExtensions.workerNetwork,
          workspaceWrite: options.manifests.some(({ permissions }) =>
            permissions.includes("write"),
          ),
        }))
      : (controlledExtensions?.entries ?? []).map(({ id, kind, network, tools }) => ({
          id,
          kind,
          network,
          workspaceWrite: tools.some(({ permissions }) => permissions.includes("workspace-write")),
        }));
  const auditWithoutDigest = {
    schemaVersion: 1 as const,
    profile: options.resolution.profile,
    requestedTools: options.resolution.requestedTools,
    disallowedTools: options.resolution.disallowedTools,
    effectiveTools,
    deniedTools: [...deniedById.values()].sort((left, right) => left.id.localeCompare(right.id)),
    network,
    workspaceWrite: options.manifests.some(({ permissions }) => permissions.includes("write")),
    ...(options.extensions === undefined ? {} : { extensionDigest: options.extensions.digest }),
    trustedExtensions,
  };
  const digest = createHash("sha256")
    .update(JSON.stringify(auditWithoutDigest), "utf8")
    .digest("hex");
  return { ...auditWithoutDigest, digest };
}

/** Project the legacy permission audit into the current Controller-owned policy semantics. */
export function buildControllerToolPolicyAudit(
  permission: PermissionAudit,
  policyOwner: ToolPolicyOwner,
): ControllerToolPolicyAudit {
  if (policyOwner !== "controller") {
    throw new Error(
      "A DSH-owned policy must report observed tools, not Controller-effective tools",
    );
  }
  return {
    schemaVersion: 1,
    policyOwner: "controller",
    requestedTools: permission.requestedTools,
    effectiveTools: permission.effectiveTools,
    deniedTools: permission.deniedTools,
  };
}

export function buildDshToolPolicyAudit(observedTools: readonly string[]): DshToolPolicyAudit {
  const normalized = sortedUnique(observedTools);
  if (normalized.length === 0 || normalized.some((name) => !/^[A-Za-z0-9_-]{1,128}$/u.test(name))) {
    throw new Error("A DSH-owned policy audit requires observed runtime tool names");
  }
  return {
    schemaVersion: 1,
    policyOwner: "dsh",
    observedTools: normalized,
  };
}
