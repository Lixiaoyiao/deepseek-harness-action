import { randomUUID } from "node:crypto";
import { chmod, copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.env.SMOKE_ROOT;
const runtime = process.env.RUNTIME_ROOT;
if (root === undefined || runtime === undefined) {
  throw new Error("SMOKE_ROOT and RUNTIME_ROOT are required");
}

const home = join(root, "home");
const workspace = join(root, "workspace");
const profileMount = join(home, "profiles", "github-action");
const bundlePackage = "@dsh-action/native-ecosystem-bundle";
const pluginPackage = "@dsh-action/native-ecosystem-plugin";
const installedBundle = join(runtime, "node_modules", ...bundlePackage.split("/"));
const installedPlugin = join(runtime, "node_modules", ...pluginPackage.split("/"));
for (const directory of [
  profileMount,
  join(home, "action-state"),
  join(home, "sessions"),
  join(home, "attachments"),
  join(workspace, ".dsh", "skills", "native-dsh"),
  join(workspace, ".agents", "skills", "native-agents"),
  join(installedBundle, ".."),
  join(installedPlugin, ".."),
]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

await Promise.all([
  cp(join(process.cwd(), "test", "fixtures", "native-ecosystem-bundle"), installedBundle, {
    recursive: true,
  }),
  cp(join(process.cwd(), "test", "fixtures", "native-ecosystem-plugin"), installedPlugin, {
    recursive: true,
  }),
  copyFile(
    join(process.cwd(), "test", "fixtures", "native-mcp-server.mjs"),
    join(runtime, "native-mcp-server.mjs"),
  ),
]);
await writeFile(
  join(runtime, "native-mcp-fixture"),
  "#!/bin/sh\nexec node /opt/dsh-action/package/native-mcp-server.mjs\n",
  { mode: 0o700 },
);
await chmod(join(runtime, "native-mcp-fixture"), 0o700);

const manifest = JSON.parse(await readFile(join(runtime, "package.json"), "utf8"));
await writeFile(
  join(runtime, "package.json"),
  JSON.stringify(
    {
      ...manifest,
      name: "dsh-profile-headless-native",
      private: true,
      dependencies: {
        ...(manifest.dependencies ?? {}),
        [bundlePackage]: "1.0.0",
        [pluginPackage]: "1.0.0",
      },
      dsh: {
        profile: {
          bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", bundlePackage],
        },
      },
    },
    undefined,
    2,
  ) + "\n",
);
await writeFile(
  join(runtime, "cordis.patch.yml"),
  JSON.stringify(
    [
      {
        insert: [
          {
            id: "dsh-action-native-mcp-fixture",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "fixture",
              transport: "stdio",
              command: "/opt/dsh-action/package/native-mcp-fixture",
              args: [],
              env: {},
              cwd: "/workspace",
              toolCallTimeoutMs: 5_000,
              failOnStartupError: true,
              reconnect: {
                enabled: false,
                initialDelayMs: 500,
                maxDelayMs: 30_000,
                maxAttempts: 10,
              },
            },
          },
          {
            id: "dsh-action-native-plugin-fixture",
            name: "file:///dsh-home/profiles/github-action/node_modules/@dsh-action/native-ecosystem-plugin/index.mjs",
            config: { marker: "CORDIS_NATIVE_CI" },
          },
        ],
      },
    ],
    undefined,
    2,
  ) + "\n",
);
await writeFile(join(runtime, "action-native-root.yml"), "[]\n");
await writeFile(
  join(runtime, "pnpm-workspace.yaml"),
  "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
);
await writeFile(
  join(workspace, ".dsh", "skills", "native-dsh", "SKILL.md"),
  "---\nname: native-dsh\ndescription: Native DSH project skill fixture\n---\nNATIVE_DSH_SKILL_BODY_MARKER\n",
);
await writeFile(
  join(workspace, ".agents", "skills", "native-agents", "SKILL.md"),
  "---\nname: native-agents\ndescription: Native agents project skill fixture\n---\nNATIVE_AGENTS_SKILL_BODY_MARKER\n",
);
await writeFile(join(home, ".anonymous-user-id"), randomUUID() + "\n");
await writeFile(join(home, "action-state", "native-observed-tools.jsonl"), "");
await writeFile(join(workspace, "README.md"), "native ecosystem smoke workspace\n");
