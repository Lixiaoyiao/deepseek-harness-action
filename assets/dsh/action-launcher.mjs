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
import { createRequire } from "node:module";
import { join } from "node:path";

const NAME = "dsh-action";
const PROFILE = "github-action";
const PROFILE_ROOT_FILENAME = "action-root.yml";
const INSTALL_ANCHOR = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json");

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

  // loadProfile and boot are the official 0.2.1-rc.2 Profile/Bundle and Cordis
  // entrypoints. The Action deliberately omits the product CLI's layered .env,
  // home patch, and live user-patch watchers because workflow inputs — not the
  // checked-out repository or model output — are the authorization boundary.
  const profile = loadProfile(NAME, PROFILE, INSTALL_ANCHOR, dshHome);
  if (profile.skippedBundles.length !== 0) {
    throw new Error("an admitted DSH Profile Bundle failed compatibility or resolution");
  }
  const resolution = await createRuntimeResolution({
    installAnchor: INSTALL_ANCHOR,
    profile,
    home: dshHome,
  });
  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    ...(process.env.DSH_ACTION_SEARCH_PROVIDER === "deepseek-official"
      ? [
          {
            id: "web",
            config: { searchProvider: "deepseek-official", fetchProvider: "deepseek-fetch-api" },
          },
          { id: "web-search-deepseek", disabled: false, config: { apiKeyEnv: "DEEPSEEK_API_KEY" } },
        ]
      : []),
    {
      id: "web-deepseek-api",
      config: {
        apiKeyEnv: "DEEPSEEK_API_KEY",
        baseURL: `${process.env.DEEPSEEK_BASE_URL}/v1/tools`,
      },
    },
    // These upstream defaults send extra durable log or installed-package
    // data. An Action runtime upgrade must not opt the user into that upload.
    { id: "session-log-deepseek", disabled: true },
    { id: "plugin-package-inventory-deepseek", disabled: true },
    { id: "session-telemetry-otel", disabled: true },
    ...(sessionPlan === undefined
      ? []
      : [
          sessionModule.sessionHeadlessPatch(sessionPlan, task),
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
