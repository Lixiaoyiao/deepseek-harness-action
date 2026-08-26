import type { AgentToolManifest } from "../agent/contracts.js";
import { createToolDenial, type ToolDenialReasonCode } from "../permissions/profile.js";
import type { Capabilities, SecurityPolicy } from "../security/policy.js";
import type { NativeToolId } from "./schema.js";

export interface BuiltinCapabilityContract {
  readonly manifest: AgentToolManifest & {
    readonly id: NativeToolId;
    readonly provider: "builtin";
  };
  readonly requirements: {
    readonly capabilities: readonly (keyof Capabilities)[];
    readonly trust?: readonly SecurityPolicy["trust"][];
    readonly isolation?: "docker" | "none";
  };
  readonly denialReason: string;
}

/**
 * Single source of truth for Controller-owned builtin model capabilities.
 * Native DSH inventory is deliberately absent: DSH owns and reports that inventory.
 */
export const CONTROLLER_BUILTIN_CAPABILITY_CONTRACTS = Object.freeze([
  {
    manifest: {
      id: "workspace.read",
      description: "Read repository files inside the bound workspace.",
      provider: "builtin",
      permissions: ["read"],
      inputSchema: { type: "object", additionalProperties: false },
    },
    requirements: {
      capabilities: ["readRepository"],
      trust: ["trusted-read", "trusted-write"],
      isolation: "docker",
    },
    denialReason: "Repository tools require a trusted actor and Docker isolation",
  },
  {
    manifest: {
      id: "workspace.search",
      description: "Search repository paths and file contents inside the bound workspace.",
      provider: "builtin",
      permissions: ["read"],
      inputSchema: { type: "object", additionalProperties: false },
    },
    requirements: {
      capabilities: ["readRepository"],
      trust: ["trusted-read", "trusted-write"],
      isolation: "docker",
    },
    denialReason: "Repository tools require a trusted actor and Docker isolation",
  },
  {
    manifest: {
      id: "workspace.edit",
      description: "Edit files inside the disposable bound workspace.",
      provider: "builtin",
      permissions: ["write"],
      inputSchema: { type: "object", additionalProperties: false },
    },
    requirements: {
      capabilities: ["modifyWorkspace"],
      trust: ["trusted-write"],
      isolation: "docker",
    },
    denialReason: "Workspace editing requires trusted-write policy with Docker isolation",
  },
  {
    manifest: {
      id: "native.bash",
      description:
        "Run bounded foreground Bash commands inside the DSH workspace sandbox; escalation is never approved.",
      provider: "builtin",
      permissions: ["read", "execute"],
      inputSchema: { type: "object", additionalProperties: false },
    },
    requirements: {
      capabilities: ["executeRepositoryCode", "modifyWorkspace"],
      trust: ["trusted-write"],
      isolation: "docker",
    },
    denialReason: "Bash requires trusted-write repository-code execution in Docker",
  },
  {
    manifest: {
      id: "native.web-search",
      description:
        "Search the web through the Controller-mediated DeepSeek Messages proxy without receiving the real API key.",
      provider: "builtin",
      permissions: ["network"],
      inputSchema: { type: "object", additionalProperties: false },
    },
    requirements: {
      capabilities: ["accessNetwork"],
      trust: ["trusted-read", "trusted-write"],
      isolation: "docker",
    },
    denialReason: "Web search requires a trusted same-repository actor and Docker",
  },
  {
    manifest: {
      id: "native.subagent",
      description:
        "Delegate bounded foreground work to one in-process DSH subagent with inherited tool restrictions.",
      provider: "builtin",
      permissions: ["read", "execute"],
      inputSchema: { type: "object", additionalProperties: false },
    },
    requirements: {
      capabilities: ["readRepository", "modifyWorkspace"],
      trust: ["trusted-write"],
      isolation: "docker",
    },
    denialReason: "Subagent delegation requires trusted-write policy in Docker",
  },
] as const satisfies readonly BuiltinCapabilityContract[]);

export interface EvaluateBuiltinCapabilitiesOptions {
  readonly requested: ReadonlySet<NativeToolId>;
  readonly disallowed: ReadonlySet<NativeToolId>;
  readonly policy: SecurityPolicy;
  readonly isolation: "docker" | "none";
}

export interface BuiltinCapabilityDenial {
  readonly id: NativeToolId;
  readonly reasonCode: ToolDenialReasonCode;
  readonly reason: string;
}

export function evaluateBuiltinCapabilities(options: EvaluateBuiltinCapabilitiesOptions): {
  readonly contracts: readonly BuiltinCapabilityContract[];
  readonly denials: readonly BuiltinCapabilityDenial[];
} {
  const contracts: BuiltinCapabilityContract[] = [];
  const denials: BuiltinCapabilityDenial[] = [];
  for (const contract of CONTROLLER_BUILTIN_CAPABILITY_CONTRACTS as readonly BuiltinCapabilityContract[]) {
    const id = contract.manifest.id;
    if (!options.requested.has(id) || options.disallowed.has(id)) continue;
    const { requirements } = contract;
    const granted =
      options.policy.allowed &&
      (requirements.isolation === undefined || requirements.isolation === options.isolation) &&
      (requirements.trust === undefined || requirements.trust.includes(options.policy.trust)) &&
      requirements.capabilities.every((capability) => options.policy.capabilities[capability]);
    if (granted) {
      contracts.push(contract);
    } else {
      denials.push(
        createToolDenial(id, contract.denialReason, [
          ...(!options.policy.allowed ||
          (requirements.trust !== undefined && !requirements.trust.includes(options.policy.trust))
            ? (["TRUST_REQUIRED"] as const)
            : []),
          ...(requirements.isolation !== undefined && requirements.isolation !== options.isolation
            ? (["ISOLATION_REQUIRED"] as const)
            : []),
          ...(requirements.capabilities.some(
            (capability) => !options.policy.capabilities[capability],
          )
            ? (["CAPABILITY_NOT_GRANTED"] as const)
            : []),
        ]),
      );
    }
  }
  return { contracts, denials };
}
