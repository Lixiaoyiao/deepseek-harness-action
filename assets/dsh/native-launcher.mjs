import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import {
  boot,
  createRuntimeResolution,
  installFailLoud,
  loadProfile,
  PluginPackages,
} from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";

const NAME = "dsh-action-native";
// The Action installs the locked runtime and any admitted out-of-tree packages
// in this run-scoped Profile directory. Its ordered Bundle layers still begin
// with the official 0.2.1-rc.2 headless template.
const PROFILE = "github-action";
const PROFILE_ROOT_FILENAME = "action-native-root.yml";
const INSTALL_ANCHOR = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json");
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

function admittedExtensionSelectors(profile) {
  const selectors = [];
  const addRow = (row) => {
    if (typeof row.id === "string") selectors.push({ id: row.id });
    else if (typeof row.name === "string") selectors.push({ name: row.name });
    if (Array.isArray(row.insert)) row.insert.forEach(addRow);
  };
  for (const layer of profile.layers) {
    if (
      layer.packageName === "@deepseek-ai/dsh-base" ||
      layer.packageName === "@deepseek-ai/dsh-headless"
    )
      continue;
    layer.patches.forEach(addRow);
  }
  for (const patch of profile.patches) {
    for (const row of patch.insert ?? []) {
      if (/^dsh-action-(?:native-)?(?:mcp|plugin)-/u.test(row.id ?? "")) addRow(row);
    }
  }
  return selectors;
}

function requireAdmittedExtensions(host, selectors) {
  if (selectors.length === 0) return;
  // The official Headless driver settles Loader before creating its Agent.
  // Check only explicitly admitted extension entries, including their nested
  // groups/includes; DSH's unrelated optional entries retain their semantics.
  host.on(
    "agent/created",
    () => {
      const loader = host.get("loader");
      if (loader === undefined) throw new Error("admitted extension startup requires Loader");
      const entries = [...loader.entries()];
      const required = new Set();
      for (const selector of selectors) {
        const matched = entries.filter((entry) =>
          selector.id === undefined
            ? entry.options.name === selector.name
            : entry.options.id === selector.id,
        );
        if (matched.length === 0) throw new Error("an admitted extension entry was not composed");
        matched.forEach((entry) => required.add(entry));
      }
      for (const entry of required) {
        if (entry.subtree !== undefined) {
          for (const child of entry.subtree.entries()) required.add(child);
        }
        if (entry.subgroup !== undefined) {
          for (const child of entries) if (child.parent === entry.subgroup) required.add(child);
        }
        // ACTIVE=2 is the exact locked Cordis FiberState public enum.
        if (!entry.disabled && entry.fiber?.state !== 2) {
          throw new Error(`admitted extension ${entry.options.id} failed to activate`);
        }
      }
    },
    { prepend: true },
  );
}

function inheritedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry) => typeof entry[1] === "string"),
  );
}

function observeRootAgent(host, observationPath) {
  let observed = false;
  host.on("agent/created", ({ agent }) => {
    if (observed) return;
    const tools = host.get("tools");
    if (tools === undefined) {
      throw new Error("native tool observation requires the DSH tools service");
    }
    const names = [
      ...new Set(
        tools.schemas(agent).map((schema) => {
          if (typeof schema?.name !== "string" || !TOOL_NAME.test(schema.name)) {
            throw new Error("native tool observation received an invalid DSH schema name");
          }
          return schema.name;
        }),
      ),
    ].sort((left, right) => left.localeCompare(right));
    if (names.length === 0 || names.length > 512) {
      throw new Error("native tool observation received an invalid DSH inventory");
    }
    appendFileSync(
      observationPath,
      `${JSON.stringify({
        schemaVersion: 1,
        source: "ctx.tools.schemas(agent)",
        observedTools: names,
      })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    observed = true;
  });
}

async function main() {
  const sessionEnabled = process.argv.length === 4 && process.argv[3] === "--action-session";
  const task = sessionEnabled ? process.argv[2] : process.argv.slice(2).join(" ");
  if (task.trim() === "") throw new Error("a non-empty headless task is required");
  const dshHome = process.env.DSH_HOME;
  if (dshHome === undefined || dshHome.trim() === "") {
    throw new Error("DSH_HOME must identify the Controller-owned runtime home");
  }
  const sessionModule = sessionEnabled ? await import("./action-session.mjs") : undefined;
  const sessionPlan = sessionModule?.readSessionPlan(
    join(dshHome, "action-state", "session-plan.json"),
    dshHome,
  );

  const profile = loadProfile(NAME, PROFILE, INSTALL_ANCHOR, dshHome);
  if (profile.skippedBundles.length !== 0) {
    throw new Error("an admitted DSH Profile Bundle failed compatibility or resolution");
  }
  const resolution = await createRuntimeResolution({
    installAnchor: INSTALL_ANCHOR,
    profile,
    home: dshHome,
  });
  const observationPath = join(dshHome, "action-state", "native-observed-tools.jsonl");
  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    // Both web tools use the Controller's fixed DeepSeek API routes.
    { id: "web-fetch-http", disabled: true },
    { id: "mcp-resources", disabled: true },
    {
      id: "web",
      config: {
        searchProvider:
          process.env.DSH_ACTION_SEARCH_PROVIDER === "deepseek-official"
            ? "deepseek-official"
            : "deepseek-search-api",
        fetchProvider: "deepseek-fetch-api",
      },
    },
    {
      id: "web-deepseek-api",
      config: {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseURL: `${process.env.DEEPSEEK_BASE_URL}/v1/tools`,
      },
    },
    { id: "tool-web", config: { search: true, fetch: true, searchTimeoutMs: 60_000 } },
    // Session-log and package-inventory uploads are independent of telemetry.
    { id: "session-log-deepseek", disabled: true },
    { id: "plugin-package-inventory-deepseek", disabled: true },
    // The programmatic launcher intentionally skips the product CLI switch,
    // so preserve the Action's default-off telemetry boundary explicitly.
    { id: "session-telemetry-otel", disabled: true },
    ...(sessionPlan === undefined
      ? []
      : [
          sessionModule.sessionHeadlessPatch(sessionPlan, task),
          // Portable headless Session admission uses this run's Controller
          // mode without restoring old interactive approval decisions.
          { id: "approval", config: { policy: "never" } },
          {
            id: "permission",
            config: {
              presets: {
                [sessionPlan.permissionMode]: {
                  sandbox: sessionPlan.permissionMode,
                  approval: "never",
                },
              },
              defaultPreset: sessionPlan.permissionMode,
            },
          },
          {
            id: "session-persistence-jsonl",
            config: { root: join(dshHome, "sessions"), compression: "none" },
          },
        ]),
  ];
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);
  const environment = createLaunchEnvironmentSnapshot([
    { source: "process", values: inheritedEnvironment() },
  ]);

  let root;
  let disposePromise;
  let exitStarted = false;
  let resolveExit;
  const exitRequested = new Promise((resolve) => {
    resolveExit = resolve;
  });
  const disposeOnce = () => {
    if (root === undefined) return Promise.resolve();
    disposePromise ??= root.fiber.dispose();
    return disposePromise;
  };
  const requestExit = (code) => {
    if (exitStarted) return;
    exitStarted = true;
    if (!Number.isSafeInteger(code) || code < 0 || code > 255) {
      const invalidCode = new Error("appExit supplied an invalid process exit code");
      void disposeOnce().then(
        () => resolveExit({ error: invalidCode }),
        (error) => resolveExit({ error }),
      );
      return;
    }
    void disposeOnce().then(
      () => resolveExit({ code }),
      (error) => resolveExit({ error }),
    );
  };
  let signalHandlers;
  const uninstallFailLoud = installFailLoud(NAME, process, async () => {
    await disposeOnce();
  });

  try {
    const context = await boot(
      NAME,
      rootConfig,
      globalThis.structuredClone(patches),
      async (host) => {
        root = host;
        if (sessionPlan !== undefined)
          sessionModule.installSessionAdmission(host, sessionPlan, {
            auditPath: join(dshHome, "action-state", "session-admission.json"),
          });
        await host.plugin(PluginPackages, { resolution });
        requireAdmittedExtensions(host, admittedExtensionSelectors(profile));
        observeRootAgent(host, observationPath);
        const signal = (code) => {
          if (exitStarted) process.exit(code);
          requestExit(code);
        };
        signalHandlers = {
          sigterm: () => signal(0),
          sigint: () => signal(130),
        };
        process.on("SIGTERM", signalHandlers.sigterm);
        process.on("SIGINT", signalHandlers.sigint);
        host.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
        provideCmdline(host, {
          args:
            sessionPlan?.sessionId === undefined
              ? ["--json", "--", task]
              : ["--json", "--session-id", sessionPlan.sessionId, "--", task],
          exit: requestExit,
        });
      },
    );
    root = context;
    const outcome = await exitRequested;
    if (outcome.error !== undefined) throw outcome.error;
    process.exitCode = outcome.code;
  } finally {
    if (signalHandlers !== undefined) {
      process.off("SIGTERM", signalHandlers.sigterm);
      process.off("SIGINT", signalHandlers.sigint);
    }
    uninstallFailLoud();
    if (root !== undefined) await disposeOnce();
  }
}

main().catch((error) => {
  process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
