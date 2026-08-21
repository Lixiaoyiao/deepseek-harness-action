import { createHash } from "node:crypto";

import { z } from "zod";

import type { AgentToolManifest } from "../agent/contracts.js";
import type { ExtensionAudit } from "../extensions/plan.js";
import { autonomyToolSchema, type AllowedToolId, type AutonomyToolId } from "../tools/schema.js";

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
  readonly extensions?: ExtensionAudit;
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
  const bridge = commandBridge || options.extensions?.network === true;
  const mediatedWeb = effective.has("native.web-search");
  const network: PermissionAudit["network"] = bridge
    ? "bridge"
    : mediatedWeb
      ? "mediated-web"
      : "host-gateway";
  const trustedExtensions = (options.extensions?.entries ?? []).map(
    ({ id, kind, network, tools }) => ({
      id,
      kind,
      network,
      workspaceWrite: tools.some(({ permissions }) => permissions.includes("workspace-write")),
    }),
  );
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
