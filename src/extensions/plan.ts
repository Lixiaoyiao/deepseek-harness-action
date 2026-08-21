import { createHash, timingSafeEqual } from "node:crypto";

import type { AgentToolManifest } from "../agent/contracts.js";
import type { SecurityPolicy } from "../security/policy.js";
import {
  mcpToolId,
  pluginToolId,
  type AllowedToolId,
  type McpToolId,
  type PluginToolId,
} from "../tools/schema.js";
import type {
  BundleDefinition,
  ExtensionPermission,
  ExtensionToolDefinition,
  McpConfiguration,
  McpServerDefinition,
  McpToolDefinition,
  PluginConfiguration,
  PluginDefinition,
} from "./schema.js";
import type { ExtensionRuntimeLockAudit } from "./runtime-lock.js";

const MAX_PUBLIC_TOOL_NAME_LENGTH = 64;
const PUBLIC_TOOL_HASH_LENGTH = 12;
// Keep rc.8's UTF-16 code-unit replacement semantics exactly: the official
// client intentionally uses this expression without the Unicode flag.
const INVALID_PUBLIC_TOOL_CHARACTERS = /[^A-Za-z0-9_-]/g;
const forbiddenCredentialNames = new Set([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "DEEPSEEK_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

export interface ExtensionToolGrant {
  readonly id: McpToolId | PluginToolId;
  readonly runtimeName: string;
  readonly provider: "mcp" | "plugin";
  readonly ownerId: string;
  readonly ownerKind: "mcp" | "bundle" | "plugin";
  readonly description: string;
  readonly permissions: readonly ExtensionPermission[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxCalls: number;
  readonly groupMaxCalls: number;
}

export interface EffectiveMcpServer {
  readonly definition: McpServerDefinition;
  readonly tools: readonly ExtensionToolGrant[];
}

export interface EffectiveBundle {
  readonly definition: BundleDefinition;
  readonly tools: readonly ExtensionToolGrant[];
}

export interface EffectivePlugin {
  readonly definition: PluginDefinition;
  readonly tools: readonly ExtensionToolGrant[];
}

export interface ExtensionAuditEntry {
  readonly id: string;
  readonly kind: "mcp" | "bundle" | "plugin";
  readonly source: string;
  readonly transport?: "stdio" | "streamable-http";
  readonly network: boolean;
  readonly tools: readonly {
    readonly id: string;
    readonly runtimeName: string;
    readonly permissions: readonly ExtensionPermission[];
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly maxCalls: number;
    readonly groupMaxCalls: number;
  }[];
}

export interface ExtensionAudit {
  readonly schemaVersion: 1;
  readonly profile: "github-action";
  readonly digest: string;
  readonly network: boolean;
  readonly entries: readonly ExtensionAuditEntry[];
  /** Present after the Controller installs and validates Bundle/Plugin dependencies. */
  readonly runtimeLock?: ExtensionRuntimeLockAudit;
}

export interface EffectiveExtensionPlan {
  readonly schemaVersion: 1;
  readonly profileName: "github-action";
  /** Public, deterministic digest of the redacted audit surface. */
  readonly digest: string;
  /** Controller-only digest of the complete effective configuration. */
  readonly configurationDigest: string;
  readonly network: boolean;
  readonly mcpServers: readonly EffectiveMcpServer[];
  readonly bundles: readonly EffectiveBundle[];
  readonly plugins: readonly EffectivePlugin[];
  readonly tools: readonly ExtensionToolGrant[];
  readonly manifests: readonly AgentToolManifest[];
  readonly packageDependencies: Readonly<Record<string, string>>;
  readonly audit: ExtensionAudit;
}

export class ExtensionPolicyError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExtensionPolicyError";
  }
}

/** Mirror the public-name contract documented and implemented by dsh-mcp-client. */
export function mcpPublicToolName(serverName: string, rawName: string): string {
  const joined = `mcp__${serverName}__${rawName}`;
  const normalized = joined.replace(INVALID_PUBLIC_TOOL_CHARACTERS, "_");
  if (normalized === joined && normalized.length <= MAX_PUBLIC_TOOL_NAME_LENGTH) {
    return normalized;
  }
  const hash = createHash("sha256")
    .update(`${serverName}\0${rawName}`, "utf8")
    .digest("hex")
    .slice(0, PUBLIC_TOOL_HASH_LENGTH);
  return `${normalized.slice(0, MAX_PUBLIC_TOOL_NAME_LENGTH - PUBLIC_TOOL_HASH_LENGTH - 1)}_${hash}`;
}

export function validateExtensionToolReferences(
  toolIds: readonly AllowedToolId[],
  mcp: McpConfiguration,
  plugins: PluginConfiguration,
  label = "allowed-tools",
): void {
  const configured = new Set<string>();
  for (const server of mcp.servers) {
    for (const tool of server.tools) configured.add(mcpToolId(server.id, tool.id));
  }
  for (const extension of [...plugins.bundles, ...plugins.plugins]) {
    for (const tool of extension.tools) configured.add(pluginToolId(extension.id, tool.id));
  }
  const missing = toolIds.find(
    (id) => (id.startsWith("mcp.") || id.startsWith("plugin.")) && !configured.has(id),
  );
  if (missing !== undefined) {
    throw new Error(`${label} references undefined extension tool: ${missing}`);
  }
}

function hasPermission(
  tool: { readonly permissions: readonly ExtensionPermission[] },
  permission: ExtensionPermission,
): boolean {
  return tool.permissions.includes(permission);
}

function assertToolPolicy(tool: ExtensionToolGrant, policy: SecurityPolicy): void {
  if (
    !policy.allowed ||
    policy.trust === "untrusted" ||
    !policy.capabilities.readRepository ||
    !policy.capabilities.loadExtensions
  ) {
    throw new ExtensionPolicyError(`Extension tool ${tool.id} is not allowed by this trust policy`);
  }
  if (
    hasPermission(tool, "workspace-write") &&
    (policy.trust !== "trusted-write" || !policy.capabilities.modifyWorkspace)
  ) {
    throw new ExtensionPolicyError(
      `Extension tool ${tool.id} requires workspace-write but the task is not trusted-write`,
    );
  }
  if (hasPermission(tool, "network") && !policy.capabilities.accessNetwork) {
    throw new ExtensionPolicyError(
      `Extension tool ${tool.id} requires network but the trust policy denies network access`,
    );
  }
}

function grantForMcp(server: McpServerDefinition, tool: McpToolDefinition): ExtensionToolGrant {
  return {
    id: mcpToolId(server.id, tool.id),
    runtimeName: mcpPublicToolName(server.id, tool.name),
    provider: "mcp",
    ownerId: server.id,
    ownerKind: "mcp",
    description: tool.description,
    permissions: tool.permissions,
    timeoutMs: tool.timeoutMs,
    maxOutputBytes: tool.maxOutputBytes,
    maxCalls: tool.maxCalls,
    groupMaxCalls: server.maxCalls,
  };
}

function grantForPackage(
  kind: "bundle" | "plugin",
  definition: BundleDefinition | PluginDefinition,
  tool: ExtensionToolDefinition,
): ExtensionToolGrant {
  const requiredPrefix = `plugin__${definition.id}__`;
  if (!tool.name.startsWith(requiredPrefix)) {
    throw new ExtensionPolicyError(
      `Plugin tool ${pluginToolId(definition.id, tool.id)} must use the runtime prefix ${requiredPrefix}`,
    );
  }
  return {
    id: pluginToolId(definition.id, tool.id),
    runtimeName: tool.name,
    provider: "plugin",
    ownerId: definition.id,
    ownerKind: kind,
    description: tool.description,
    permissions: tool.permissions,
    timeoutMs: tool.timeoutMs,
    maxOutputBytes: tool.maxOutputBytes,
    maxCalls: tool.maxCalls,
    groupMaxCalls: definition.tools.reduce((total, candidate) => total + candidate.maxCalls, 0),
  };
}

function manifest(grant: ExtensionToolGrant): AgentToolManifest {
  return {
    id: grant.id,
    description: grant.description,
    provider: grant.provider,
    permissions: [
      "execute",
      ...(hasPermission(grant, "read") ? (["read"] as const) : []),
      ...(hasPermission(grant, "workspace-write") ? (["write"] as const) : []),
      ...(hasPermission(grant, "network") ? (["network"] as const) : []),
    ],
    inputSchema: { type: "object" },
  };
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") {
      return candidate;
    }
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (Array.isArray(candidate)) return candidate.map((item) => normalize(item));
    if (typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return null;
  };
  return JSON.stringify(normalize(value));
}

function auditedTools(tools: readonly ExtensionToolGrant[]): ExtensionAuditEntry["tools"] {
  return tools.map((tool) => ({
    id: tool.id,
    runtimeName: tool.runtimeName,
    permissions: tool.permissions,
    timeoutMs: tool.timeoutMs,
    maxOutputBytes: tool.maxOutputBytes,
    maxCalls: tool.maxCalls,
    groupMaxCalls: tool.groupMaxCalls,
  }));
}

function mcpAuditEntry(
  definition: McpServerDefinition,
  tools: readonly ExtensionToolGrant[],
): ExtensionAuditEntry {
  const source =
    definition.transport === "stdio"
      ? definition.command
      : (() => {
          const endpoint = new URL(definition.url);
          return endpoint.origin;
        })();
  return {
    id: definition.id,
    kind: "mcp",
    source,
    transport: definition.transport,
    network: definition.network,
    tools: auditedTools(tools),
  };
}

function packageAuditEntry(
  kind: "bundle" | "plugin",
  definition: BundleDefinition | PluginDefinition,
  tools: readonly ExtensionToolGrant[],
): ExtensionAuditEntry {
  return {
    id: definition.id,
    kind,
    source: definition.source,
    network: definition.network,
    tools: auditedTools(tools),
  };
}

interface ExtensionOwnerMode {
  readonly id: string;
  readonly network: boolean;
  readonly workspaceWrite: boolean;
}

function assertCompatibleOwnerModes(owners: readonly ExtensionOwnerMode[]): void {
  const first = owners[0];
  if (first === undefined) return;
  for (const owner of owners.slice(1)) {
    if (owner.network !== first.network) {
      throw new ExtensionPolicyError(
        `Extension owners ${first.id} and ${owner.id} cannot share one worker with different network permissions`,
      );
    }
    if (owner.workspaceWrite !== first.workspaceWrite) {
      throw new ExtensionPolicyError(
        `Extension owners ${first.id} and ${owner.id} cannot share one worker with different workspace-write permissions`,
      );
    }
  }
}

export interface ResolveExtensionPlanOptions {
  readonly allowedTools: readonly AllowedToolId[];
  readonly mcp: McpConfiguration;
  readonly plugins: PluginConfiguration;
  readonly allowPluginInstall: boolean;
  readonly policy: SecurityPolicy;
}

export function resolveExtensionPlan(options: ResolveExtensionPlanOptions): EffectiveExtensionPlan {
  validateExtensionToolReferences(options.allowedTools, options.mcp, options.plugins);
  const allowed = new Set<AllowedToolId>(options.allowedTools);
  const mcpServers: EffectiveMcpServer[] = [];
  const bundles: EffectiveBundle[] = [];
  const plugins: EffectivePlugin[] = [];
  const runtimeNames = new Map<string, string>();

  const accept = (grant: ExtensionToolGrant): boolean => {
    if (!allowed.has(grant.id)) return false;
    assertToolPolicy(grant, options.policy);
    const existing = runtimeNames.get(grant.runtimeName);
    if (existing !== undefined) {
      throw new ExtensionPolicyError(
        `Extension tools ${existing} and ${grant.id} register the same DSH tool name ${grant.runtimeName}`,
      );
    }
    runtimeNames.set(grant.runtimeName, grant.id);
    return true;
  };

  for (const server of options.mcp.servers) {
    const tools = server.tools.map((tool) => grantForMcp(server, tool)).filter(accept);
    if (tools.length > 0) mcpServers.push({ definition: server, tools });
  }
  for (const definition of options.plugins.bundles) {
    const tools = definition.tools
      .map((tool) => grantForPackage("bundle", definition, tool))
      .filter(accept);
    if (tools.length > 0) bundles.push({ definition, tools });
  }
  for (const definition of options.plugins.plugins) {
    const tools = definition.tools
      .map((tool) => grantForPackage("plugin", definition, tool))
      .filter(accept);
    if (tools.length > 0) plugins.push({ definition, tools });
  }

  if ((bundles.length > 0 || plugins.length > 0) && !options.allowPluginInstall) {
    throw new ExtensionPolicyError(
      "Third-party Bundle/Plugin installation is disabled; set allow-plugin-install=true in the trusted workflow",
    );
  }

  const tools = [
    ...mcpServers.flatMap((server) => server.tools),
    ...bundles.flatMap((bundle) => bundle.tools),
    ...plugins.flatMap((plugin) => plugin.tools),
  ];
  const owners: ExtensionOwnerMode[] = [
    ...mcpServers.map((server) => ({
      id: `mcp.${server.definition.id}`,
      network: server.definition.network,
      workspaceWrite: server.tools.some((tool) => hasPermission(tool, "workspace-write")),
    })),
    ...bundles.map((bundle) => ({
      id: `bundle.${bundle.definition.id}`,
      network: bundle.definition.network,
      workspaceWrite: bundle.tools.some((tool) => hasPermission(tool, "workspace-write")),
    })),
    ...plugins.map((plugin) => ({
      id: `plugin.${plugin.definition.id}`,
      network: plugin.definition.network,
      workspaceWrite: plugin.tools.some((tool) => hasPermission(tool, "workspace-write")),
    })),
  ];
  assertCompatibleOwnerModes(owners);
  if (options.policy.trust === "trusted-write") {
    const readOnlyOwner = owners.find((owner) => !owner.workspaceWrite);
    if (readOnlyOwner !== undefined) {
      throw new ExtensionPolicyError(
        `Extension owner ${readOnlyOwner.id} must declare workspace-write because the trusted-write worker mounts the workspace read-write`,
      );
    }
  }
  const packageDependencies: Record<string, string> = {};
  for (const extension of [...bundles, ...plugins]) {
    packageDependencies[extension.definition.package] = extension.definition.source;
  }
  const entries = [
    ...mcpServers.map((server) => mcpAuditEntry(server.definition, server.tools)),
    ...bundles.map((bundle) => packageAuditEntry("bundle", bundle.definition, bundle.tools)),
    ...plugins.map((plugin) => packageAuditEntry("plugin", plugin.definition, plugin.tools)),
  ];
  const configurationDigest = createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: 1,
        profile: "github-action",
        mcpServers: mcpServers.map(({ definition, tools: grants }) => ({
          definition,
          allowedToolIds: grants.map(({ id }) => id),
        })),
        bundles: bundles.map(({ definition, tools: grants }) => ({
          definition,
          allowedToolIds: grants.map(({ id }) => id),
        })),
        plugins: plugins.map(({ definition, tools: grants }) => ({
          definition,
          allowedToolIds: grants.map(({ id }) => id),
        })),
        packageDependencies,
      }),
      "utf8",
    )
    .digest("hex");
  const network = entries.some((entry) => entry.network);
  const digest = createHash("sha256")
    .update(
      canonicalJson({
        schemaVersion: 1,
        profile: "github-action",
        network,
        entries,
        packageDependencies,
      }),
      "utf8",
    )
    .digest("hex");
  const audit: ExtensionAudit = {
    schemaVersion: 1,
    profile: "github-action",
    digest,
    network,
    entries,
  };
  return {
    schemaVersion: 1,
    profileName: "github-action",
    digest,
    configurationDigest,
    network,
    mcpServers,
    bundles,
    plugins,
    tools,
    manifests: tools.map((tool) => manifest(tool)),
    packageDependencies,
    audit,
  };
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function containsCredentialName(value: string): boolean {
  const upper = value.toUpperCase();
  return forbiddenCredentialNames.has(upper) || upper.startsWith("ACTIONS_ID_TOKEN_");
}

const SENSITIVE_CONFIG_NAME =
  /(?:auth(?:orization)?|cookie|credential|pass(?:word)?|secret|token|api[-_]?key)/iu;

function decodedVariants(value: string): readonly string[] {
  const variants = new Set([value]);
  let current = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) break;
      variants.add(decoded);
      current = decoded;
    } catch {
      break;
    }
  }
  return [...variants];
}

function stringsInJson(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => stringsInJson(item));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).flatMap((item) => stringsInJson(item));
  }
  return [];
}

function keysInJson(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => keysInJson(item));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysInJson(item)]);
}

function sensitiveValuesInJson(value: unknown, sensitive = false): string[] {
  if (typeof value === "string") return sensitive ? [...decodedVariants(value)] : [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => sensitiveValuesInJson(item, sensitive));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, item]) =>
    sensitiveValuesInJson(item, sensitive || SENSITIVE_CONFIG_NAME.test(key)),
  );
}

function httpUrlSecrets(value: string): readonly string[] {
  const url = new URL(value);
  const candidates = [
    url.username,
    url.password,
    url.pathname.slice(1),
    ...url.pathname.split("/"),
    url.search.slice(1),
    ...url.searchParams.values(),
  ];
  return [...new Set(candidates.flatMap((entry) => decodedVariants(entry)))].filter(
    (entry) => entry.length >= 8,
  );
}

const AUTH_SCHEMES = new Set(["basic", "bearer", "digest", "token"]);

/** Values that must never cross a Controller log/output boundary. */
export function configuredHttpSecrets(
  url: string,
  headers: Readonly<Record<string, string>>,
): readonly string[] {
  const headerValues = Object.entries(headers).flatMap(([name, value]) => {
    if (!SENSITIVE_CONFIG_NAME.test(name)) return [];
    return [
      ...decodedVariants(value),
      ...value
        .split(/[\s,;=]+/u)
        .filter((part) => part.length >= 4 && !AUTH_SCHEMES.has(part.toLowerCase())),
    ];
  });
  return [...new Set([...httpUrlSecrets(url), ...headerValues])].filter(
    (entry) => entry.length >= 4,
  );
}

/** Credential-like stdio fields that need runner masking without treating ordinary argv as secrets. */
export function configuredStdioSecrets(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): readonly string[] {
  const values = Object.entries(env).flatMap(([name, value]) =>
    SENSITIVE_CONFIG_NAME.test(name) ? decodedVariants(value) : [],
  );
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    const separator = argument.indexOf("=");
    if (separator > 0 && SENSITIVE_CONFIG_NAME.test(argument.slice(0, separator))) {
      values.push(...decodedVariants(argument.slice(separator + 1)));
      continue;
    }
    if (SENSITIVE_CONFIG_NAME.test(argument)) {
      const next = args[index + 1];
      if (next !== undefined && !next.startsWith("-")) values.push(...decodedVariants(next));
    }
  }
  return [...new Set(values.filter((value) => value.length >= 4))];
}

/** Credential-like values in direct Plugin configuration, keyed explicitly by the workflow. */
export function configuredPluginSecrets(config: unknown): readonly string[] {
  return [...new Set(sensitiveValuesInJson(config).filter((value) => value.length >= 4))];
}

export function configuredExtensionSecrets(
  mcp: McpConfiguration,
  plugins: PluginConfiguration,
): readonly string[] {
  const values = [
    ...mcp.servers.flatMap((server) =>
      server.transport === "stdio"
        ? configuredStdioSecrets(server.args, server.env)
        : configuredHttpSecrets(server.url, server.headers),
    ),
    ...plugins.plugins.flatMap((plugin) => configuredPluginSecrets(plugin.config)),
  ];
  return [...new Set(values.filter((value) => value.length >= 4))];
}

export function assertControllerCredentialsAbsentFromExtensions(
  mcp: McpConfiguration,
  plugins: PluginConfiguration,
  controllerSecrets: readonly string[],
): void {
  for (const server of mcp.servers) {
    const names =
      server.transport === "stdio" ? Object.keys(server.env) : Object.keys(server.headers);
    const forbidden = names.find(containsCredentialName);
    if (forbidden !== undefined) {
      throw new Error(
        `Extension configuration must not use controller credential name ${forbidden}`,
      );
    }
  }
  const forbiddenPluginKey = plugins.plugins
    .flatMap((plugin) => keysInJson(plugin.config))
    .find(containsCredentialName);
  if (forbiddenPluginKey !== undefined) {
    throw new Error(
      `Extension configuration must not use controller credential name ${forbiddenPluginKey}`,
    );
  }
  const values = [...stringsInJson({ mcp, plugins }), ...keysInJson({ mcp, plugins })].flatMap(
    (value) => decodedVariants(value),
  );
  if (
    values.some((value) =>
      controllerSecrets.some(
        (secret) => secret.length >= 4 && (equalSecret(value, secret) || value.includes(secret)),
      ),
    )
  ) {
    throw new Error("Extension configuration must not contain a controller credential");
  }
}
