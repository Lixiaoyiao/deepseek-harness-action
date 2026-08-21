import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

const extensionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/u, "must start with a letter and contain only a-z, 0-9, or -");

const toolIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u, "must start with a letter and contain only a-z, 0-9, _ or -");

const runtimeToolNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/u, "must satisfy the DSH model-facing tool-name contract");

const mcpRawToolNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !value.includes("\0"), {
    message: "must not contain NUL",
  });

const permissionSchema = z.enum(["read", "workspace-write", "network"]);

const extensionToolSchema = z
  .strictObject({
    id: toolIdSchema,
    name: runtimeToolNameSchema,
    description: z.string().trim().min(1).max(500),
    permissions: z.array(permissionSchema).min(1).max(3),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(30 * 60_000)
      .default(60_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1_024)
      .max(2 * 1024 * 1024)
      .default(128 * 1024),
    maxCalls: z.number().int().min(1).max(100).default(10),
  })
  .superRefine((tool, context) => {
    if (!tool.permissions.includes("read")) {
      context.addIssue({
        code: "custom",
        path: ["permissions"],
        message: "must include read because extensions share the Agent workspace process",
      });
    }
    if (new Set(tool.permissions).size !== tool.permissions.length) {
      context.addIssue({ code: "custom", path: ["permissions"], message: "must be unique" });
    }
  });

const mcpToolSchema = extensionToolSchema.safeExtend({ name: mcpRawToolNameSchema });

const reconnectSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    initialDelayMs: z.number().int().min(100).max(30_000).default(500),
    maxDelayMs: z.number().int().min(100).max(60_000).default(30_000),
    maxAttempts: z.number().int().min(1).max(100).default(10),
  })
  .superRefine((value, context) => {
    if (value.initialDelayMs > value.maxDelayMs) {
      context.addIssue({
        code: "custom",
        path: ["initialDelayMs"],
        message: "must be less than or equal to maxDelayMs",
      });
    }
  });

const forbiddenEnvironmentNames = new Set([
  "BASH_ENV",
  "COMSPEC",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "PERL5LIB",
  "PERL5OPT",
  "PROMPT_COMMAND",
  "PSMODULEPATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
  "SHELL",
]);

const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, "must be a portable environment variable name")
  .refine((value) => !forbiddenEnvironmentNames.has(value.toUpperCase()), {
    message: "must not alter executable lookup, loaders, or interpreter startup",
  });
const environmentValueSchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes("\0"), {
    message: "must not contain NUL",
  });
const environmentSchema = z.record(environmentNameSchema, environmentValueSchema);

const forbiddenMcpExecutables = new Set([
  "bash",
  "bash.exe",
  "busybox",
  "busybox.exe",
  "corepack",
  "corepack.cmd",
  "corepack.exe",
  "curl",
  "curl.exe",
  "bunx",
  "bunx.exe",
  "cmd",
  "cmd.exe",
  "deno",
  "deno.exe",
  "env",
  "env.exe",
  "fish",
  "fish.exe",
  "git",
  "git.exe",
  "java",
  "java.exe",
  "node",
  "node.exe",
  "npm",
  "npm.cmd",
  "npm.exe",
  "npx",
  "npx.cmd",
  "npx.exe",
  "pnpm",
  "pnpm.cmd",
  "pnpm.exe",
  "perl",
  "perl.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "python",
  "python.exe",
  "python3",
  "python3.exe",
  "ruby",
  "ruby.exe",
  "sh",
  "sh.exe",
  "yarn",
  "yarn.cmd",
  "yarn.exe",
  "wget",
  "wget.exe",
  "zsh",
  "zsh.exe",
]);

function portableExecutableName(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
}

const commandSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .refine((value) => !value.includes("\0"), { message: "must not contain NUL" })
  .refine((value) => !forbiddenMcpExecutables.has(portableExecutableName(value)), {
    message: "must not be an interpreter, downloader, package manager, git, or dynamic runner",
  })
  .refine((value) => !/[\\/]/u.test(value) || value.startsWith("/"), {
    message: "must be a bare executable name or an absolute container path",
  })
  .refine(
    (value) => {
      const normalized = value.replaceAll("\\", "/").toLowerCase();
      return normalized !== "/workspace" && !normalized.startsWith("/workspace/");
    },
    { message: "must not execute repository-controlled workspace content" },
  );

const relativeCwdSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .refine((value) => !value.includes("\0"), { message: "must not contain NUL" })
  .refine((value) => !isAbsolute(value), { message: "must be repository-relative" })
  .refine(
    (value) => {
      const normalized = normalize(value).replaceAll("\\", "/");
      return normalized !== ".." && !normalized.startsWith("../");
    },
    { message: "must stay inside the repository workspace" },
  );

const headerNameSchema = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u, "must be a valid HTTP header name")
  .refine((value) => !["host", "content-length"].includes(value.toLowerCase()), {
    message: "is controlled by the HTTP transport",
  });
const headerValueSchema = z
  .string()
  .max(16_384)
  .refine((value) => !/[\r\n\0]/u.test(value), { message: "must not contain CR, LF, or NUL" });

const mcpServerBaseSchema = z.strictObject({
  id: extensionIdSchema,
  tools: z.array(mcpToolSchema).min(1).max(64),
  maxCalls: z.number().int().min(1).max(500).default(50),
  reconnect: reconnectSchema.default({
    enabled: true,
    initialDelayMs: 500,
    maxDelayMs: 30_000,
    maxAttempts: 10,
  }),
});

const stdioMcpServerSchema = mcpServerBaseSchema
  .extend({
    transport: z.literal("stdio"),
    command: commandSchema,
    args: z
      .array(
        z
          .string()
          .min(1)
          .max(4_096)
          .refine((value) => !value.includes("\0"), {
            message: "must not contain NUL",
          }),
      )
      .max(64)
      .default([]),
    env: environmentSchema.default({}),
    cwd: relativeCwdSchema.optional(),
    network: z.boolean().default(false),
  })
  .superRefine((server, context) => {
    validateConsistentWorkspacePermission(server.tools, context);
    for (const [index, tool] of server.tools.entries()) {
      const declaresNetwork = tool.permissions.includes("network");
      if (declaresNetwork !== server.network) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "permissions"],
          message: server.network
            ? "must include network because the stdio server has network enabled"
            : "must not include network because the stdio server has network disabled",
        });
      }
    }
  });

const streamableHttpMcpServerSchema = mcpServerBaseSchema
  .extend({
    transport: z.literal("streamable-http"),
    url: z.url().max(2_048),
    headers: z.record(headerNameSchema, headerValueSchema).default({}),
    network: z.literal(true).default(true),
  })
  .superRefine((server, context) => {
    validateConsistentWorkspacePermission(server.tools, context);
    let url: URL;
    try {
      url = new URL(server.url);
    } catch {
      return;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      context.addIssue({ code: "custom", path: ["url"], message: "must use http or https" });
    }
    if (url.username !== "" || url.password !== "") {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "must not embed credentials; use explicit headers",
      });
    }
    if (url.hash !== "") {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "must not contain a URL fragment",
      });
    }
    for (const [index, tool] of server.tools.entries()) {
      if (!tool.permissions.includes("network")) {
        context.addIssue({
          code: "custom",
          path: ["tools", index, "permissions"],
          message: "must include network for Streamable HTTP",
        });
      }
    }
  });

const mcpServerSchema = z.discriminatedUnion("transport", [
  stdioMcpServerSchema,
  streamableHttpMcpServerSchema,
]);

const mcpConfigurationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    servers: z.array(mcpServerSchema).max(16).default([]),
  })
  .superRefine((configuration, context) => {
    validateUniqueIds(configuration.servers, context, "server");
  });

const reservedRuntimePackages = new Set([
  "@actions/core",
  "@actions/github",
  "@deepseek-ai/cordis",
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-mcp-client",
  "@modelcontextprotocol/sdk",
  "zod",
]);

const npmPackageNameSchema = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u, "must be an exact npm package name")
  .max(214)
  .refine((value) => !value.startsWith("@deepseek-ai/") && !reservedRuntimePackages.has(value), {
    message: "must not replace the Controller-owned DeepSeek runtime namespace",
  });

const exactSemverPattern =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const pinnedGitPattern =
  /^git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git#[0-9a-f]{40}$/u;

export const pinnedPackageSourceSchema = z
  .string()
  .refine(
    (value) => exactSemverPattern.test(value) || pinnedGitPattern.test(value),
    "must be an exact semver or git+https GitHub URL pinned to a 40-character commit",
  );

const packageExtensionBaseSchema = z.strictObject({
  id: extensionIdSchema,
  package: npmPackageNameSchema,
  source: pinnedPackageSourceSchema,
  network: z.boolean().default(false),
  tools: z.array(extensionToolSchema).min(1).max(64),
});

const bundleSchema = packageExtensionBaseSchema;
const pluginSchema = packageExtensionBaseSchema.extend({
  config: z.record(z.string().min(1).max(128), z.json()).default({}),
});

const pluginConfigurationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    bundles: z.array(bundleSchema).max(16).default([]),
    plugins: z.array(pluginSchema).max(32).default([]),
  })
  .superRefine((configuration, context) => {
    validateUniqueIds([...configuration.bundles, ...configuration.plugins], context, "extension");
    const packages = new Map<string, string>();
    for (const [kind, extensions] of [
      ["bundles", configuration.bundles],
      ["plugins", configuration.plugins],
    ] as const) {
      for (const [index, extension] of extensions.entries()) {
        const existing = packages.get(extension.package);
        if (existing !== undefined && existing !== extension.source) {
          context.addIssue({
            code: "custom",
            path: [kind, index, "source"],
            message: `package ${extension.package} is already pinned to a different source`,
          });
        }
        packages.set(extension.package, extension.source);
        validateToolSet(extension.tools, context, [kind, index, "tools"]);
        validateConsistentWorkspacePermission(extension.tools, context, [kind, index, "tools"]);
        for (const [toolIndex, tool] of extension.tools.entries()) {
          const declaresNetwork = tool.permissions.includes("network");
          if (declaresNetwork !== extension.network) {
            context.addIssue({
              code: "custom",
              path: [kind, index, "tools", toolIndex, "permissions"],
              message: extension.network
                ? "must include network because the package has network enabled"
                : "must not include network because the package has network disabled",
            });
          }
        }
      }
    }
  });

function validateConsistentWorkspacePermission(
  tools: readonly { readonly permissions: readonly ExtensionPermission[] }[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = ["tools"],
): void {
  const workspaceWrite = tools[0]?.permissions.includes("workspace-write") ?? false;
  for (const [index, tool] of tools.entries()) {
    if (tool.permissions.includes("workspace-write") !== workspaceWrite) {
      context.addIssue({
        code: "custom",
        path: [...path, index, "permissions"],
        message:
          "all tools owned by one extension process must consistently declare workspace-write",
      });
    }
  }
}

function validateUniqueIds(
  values: readonly { readonly id: string }[],
  context: z.RefinementCtx,
  label: string,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        path: [index, "id"],
        message: `duplicate ${label} id: ${value.id}`,
      });
    }
    seen.add(value.id);
  }
}

function validateToolSet(
  tools: readonly { readonly id: string; readonly name: string }[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[] = ["tools"],
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, tool] of tools.entries()) {
    if (ids.has(tool.id)) {
      context.addIssue({
        code: "custom",
        path: [...path, index, "id"],
        message: `duplicate tool id: ${tool.id}`,
      });
    }
    if (names.has(tool.name)) {
      context.addIssue({
        code: "custom",
        path: [...path, index, "name"],
        message: `duplicate runtime tool name: ${tool.name}`,
      });
    }
    ids.add(tool.id);
    names.add(tool.name);
  }
}

function decodeJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

export type ExtensionPermission = z.infer<typeof permissionSchema>;
export type ExtensionToolDefinition = z.infer<typeof extensionToolSchema>;
export type McpToolDefinition = z.infer<typeof mcpToolSchema>;
export type McpServerDefinition = z.infer<typeof mcpServerSchema>;
export type McpConfiguration = z.infer<typeof mcpConfigurationSchema>;
export type BundleDefinition = z.infer<typeof bundleSchema>;
export type PluginDefinition = z.infer<typeof pluginSchema>;
export type PluginConfiguration = z.infer<typeof pluginConfigurationSchema>;

export function parseMcpConfiguration(raw: string): McpConfiguration {
  const result = mcpConfigurationSchema.safeParse(decodeJson(raw, "mcp-config"));
  if (!result.success) throw new Error(`Invalid mcp-config: ${z.prettifyError(result.error)}`);
  for (const [index, server] of result.data.servers.entries()) {
    validateToolSetOrThrow(server.tools, `mcp-config.servers[${String(index)}].tools`);
  }
  return result.data;
}

export function parsePluginConfiguration(raw: string): PluginConfiguration {
  const result = pluginConfigurationSchema.safeParse(decodeJson(raw, "plugin-config"));
  if (!result.success) throw new Error(`Invalid plugin-config: ${z.prettifyError(result.error)}`);
  return result.data;
}

function validateToolSetOrThrow(
  tools: readonly { readonly id: string; readonly name: string }[],
  label: string,
): void {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const tool of tools) {
    if (ids.has(tool.id)) throw new Error(`${label} contains duplicate tool id: ${tool.id}`);
    if (names.has(tool.name)) {
      throw new Error(`${label} contains duplicate runtime tool name: ${tool.name}`);
    }
    ids.add(tool.id);
    names.add(tool.name);
  }
}
