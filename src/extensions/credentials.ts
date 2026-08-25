import { timingSafeEqual } from "node:crypto";

import type { ExtensionPlan } from "./plan.js";
import type {
  McpConfiguration,
  McpServerDefinition,
  NativeMcpConfiguration,
  NativeMcpServerDefinition,
  NativePluginConfiguration,
  NativePluginDefinition,
  PluginConfiguration,
  PluginDefinition,
} from "./schema.js";

const forbiddenCredentialNames = new Set([
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "DEEPSEEK_API_KEY",
  "GH_TOKEN",
  "GITHUB_TOKEN",
]);

const SENSITIVE_CONFIG_NAME =
  /(?:auth(?:orization)?|cookie|credential|pass(?:word)?|secret|token|api[-_]?key)/iu;
const AUTH_SCHEMES = new Set(["basic", "bearer", "digest", "token"]);

export interface ExtensionCredentialOwnerFact {
  readonly extensionKind: "mcp" | "plugin";
  readonly extensionId: string;
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

function configuredExplicitSecrets(values: readonly string[]): readonly string[] {
  return [
    ...new Set(
      values.flatMap((value) => [
        ...decodedVariants(value),
        ...value
          .split(/[\s,;=]+/u)
          .filter((part) => part.length >= 4 && !AUTH_SCHEMES.has(part.toLowerCase())),
      ]),
    ),
  ].filter((value) => value.length >= 4);
}

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

/** Explicit native credential channels supplement the compatible heuristic detector. */
export function configuredMcpDefinitionSecrets(
  server: McpServerDefinition | NativeMcpServerDefinition,
): readonly string[] {
  if (server.transport === "stdio") {
    return [
      ...configuredStdioSecrets(server.args, server.env),
      ...("credentialEnv" in server
        ? configuredExplicitSecrets(Object.values(server.credentialEnv))
        : []),
    ];
  }
  return [
    ...configuredHttpSecrets(server.url, server.headers),
    ...("credentialHeaders" in server
      ? configuredExplicitSecrets(Object.values(server.credentialHeaders))
      : []),
  ];
}

export function configuredPluginDefinitionSecrets(
  plugin: PluginDefinition | NativePluginDefinition,
): readonly string[] {
  return [
    ...configuredPluginSecrets(plugin.config),
    ...("credentialConfig" in plugin
      ? configuredExplicitSecrets(Object.values(plugin.credentialConfig))
      : []),
  ];
}

export function configuredExtensionSecrets(
  mcp: McpConfiguration | NativeMcpConfiguration,
  plugins: PluginConfiguration | NativePluginConfiguration,
): readonly string[] {
  const values = [
    ...mcp.servers.flatMap((server) => configuredMcpDefinitionSecrets(server)),
    ...plugins.plugins.flatMap((plugin) => configuredPluginDefinitionSecrets(plugin)),
  ];
  return [...new Set(values.filter((value) => value.length >= 4))];
}

/** Value-free facts for authority audit construction. */
export function extensionCredentialOwnerFacts(
  extensions: ExtensionPlan | undefined,
): readonly ExtensionCredentialOwnerFact[] {
  if (extensions === undefined) return [];
  return [
    ...extensions.mcpServers.flatMap(({ definition }) =>
      configuredMcpDefinitionSecrets(definition).length > 0
        ? [{ extensionKind: "mcp" as const, extensionId: definition.id }]
        : [],
    ),
    ...extensions.plugins.flatMap(({ definition }) =>
      configuredPluginDefinitionSecrets(definition).length > 0
        ? [{ extensionKind: "plugin" as const, extensionId: definition.id }]
        : [],
    ),
  ];
}

export function assertControllerCredentialsAbsentFromExtensions(
  mcp: McpConfiguration | NativeMcpConfiguration,
  plugins: PluginConfiguration | NativePluginConfiguration,
  controllerSecrets: readonly string[],
): void {
  for (const server of mcp.servers) {
    const names =
      server.transport === "stdio"
        ? [
            ...Object.keys(server.env),
            ...("credentialEnv" in server ? Object.keys(server.credentialEnv) : []),
          ]
        : [
            ...Object.keys(server.headers),
            ...("credentialHeaders" in server ? Object.keys(server.credentialHeaders) : []),
          ];
    const forbidden = names.find(containsCredentialName);
    if (forbidden !== undefined) {
      throw new Error(
        `Extension configuration must not use controller credential name ${forbidden}`,
      );
    }
  }
  const forbiddenPluginKey = plugins.plugins
    .flatMap((plugin) => [
      ...keysInJson(plugin.config),
      ...("credentialConfig" in plugin ? Object.keys(plugin.credentialConfig) : []),
    ])
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

/** Recheck admitted definitions against ambient Controller credentials before Profile rendering. */
export function assertControllerCredentialsAbsentFromExtensionPlan(
  plan: ExtensionPlan,
  controllerSecrets: readonly string[],
): void {
  const definitions = {
    mcp: plan.mcpServers.map(({ definition }) => definition),
    bundles: plan.bundles.map(({ definition }) => definition),
    plugins: plan.plugins.map(({ definition }) => definition),
  };
  const forbiddenName = keysInJson(definitions).find(containsCredentialName);
  if (forbiddenName !== undefined) {
    throw new Error(
      `Extension configuration must not use controller credential name ${forbiddenName}`,
    );
  }
  const values = [...stringsInJson(definitions), ...keysInJson(definitions)].flatMap((value) =>
    decodedVariants(value),
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
