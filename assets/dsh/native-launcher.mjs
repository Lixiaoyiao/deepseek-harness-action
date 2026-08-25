import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

import { boot, installFailLoud, loadProfile } from "@deepseek-ai/dsh-app-boot";
import { provideCmdline } from "@deepseek-ai/dsh-cmdline";
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";

const NAME = "dsh-action-native";
// The Action installs the locked runtime and any admitted out-of-tree packages
// in this run-scoped Profile directory. Its ordered Bundle layers still begin
// with the official rc.2 headless template.
const PROFILE = "github-action";
const PROFILE_ROOT_FILENAME = "action-native-root.yml";
const INSTALL_ANCHOR = createRequire(import.meta.url).resolve("@deepseek-ai/dsh/package.json");
const TOOL_NAME = /^[A-Za-z0-9_-]{1,128}$/u;

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
  const task = process.argv.slice(2).join(" ");
  if (task.trim() === "") throw new Error("a non-empty headless task is required");
  const dshHome = process.env.DSH_HOME;
  if (dshHome === undefined || dshHome.trim() === "") {
    throw new Error("DSH_HOME must identify the Controller-owned runtime home");
  }

  const profile = loadProfile(NAME, PROFILE, INSTALL_ANCHOR, dshHome);
  const observationPath = join(dshHome, "action-state", "native-observed-tools.jsonl");
  const patches = [
    ...profile.layers.flatMap((layer) => layer.patches),
    ...profile.patches,
    // The programmatic launcher intentionally skips the product CLI switch,
    // so preserve the Action's default-off telemetry boundary explicitly.
    { id: "session-telemetry-otel", disabled: true },
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
      (host) => {
        root = host;
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
          args: [task],
          exit: requestExit,
        });
      },
      import.meta.url,
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
