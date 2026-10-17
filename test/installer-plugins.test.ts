import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runInstaller } from "../packages/create-deepseek-harness-action/src/installer.mjs";
import {
  parseNativePluginConfiguration,
  parsePluginConfiguration,
} from "../src/extensions/schema.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-plugin-import-"));
  roots.push(root);
  const home = join(root, "home");
  const profile = join(home, "profiles", "default");
  const installed = join(profile, "node_modules", "example-bundle");
  await mkdir(installed, { recursive: true });
  await writeFile(
    join(profile, "package.json"),
    JSON.stringify({
      dependencies: { "example-bundle": "^1.2.0" },
      dsh: { profile: { bundles: ["example-bundle"] } },
    }),
  );
  await writeFile(
    join(installed, "package.json"),
    JSON.stringify({
      name: "example-bundle",
      version: "1.2.3",
      engines: { dsh: ">=0.2.1-rc.1 <0.3.0" },
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    }),
  );
  await writeFile(join(home, ".credentials.yaml"), "PRIVATE_LOCAL_KEY_MUST_STAY_LOCAL");
  await writeFile(join(profile, "cordis.patch.yml"), "PRIVATE_PROFILE_CONFIG_MUST_STAY_LOCAL");
  const templates = join(root, "templates");
  await mkdir(templates);
  const source = await readFile(
    new URL(
      "../packages/create-deepseek-harness-action/src/templates/dsh-review.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const pinned = source.replace(
    "__DSH_ACTION_RELEASE_SHA__",
    "0123456789abcdef0123456789abcdef01234567",
  );
  await writeFile(
    join(templates, "dsh-review-native.yml"),
    pinned.replace("# __DSH_MODE_INPUT__", "dsh-mode: native"),
  );
  await writeFile(
    join(templates, "dsh-review.yml"),
    pinned.replace("# __DSH_MODE_INPUT__", "# controlled"),
  );
  const commands = await readFile(
    new URL(
      "../packages/create-deepseek-harness-action/src/templates/dsh-commands.yml",
      import.meta.url,
    ),
    "utf8",
  );
  await writeFile(
    join(templates, "dsh-commands.yml"),
    commands
      .replace("__DSH_ACTION_RELEASE_SHA__", "0123456789abcdef0123456789abcdef01234567")
      .replace("# __DSH_MODE_INPUT__", "# controlled"),
  );
  let output = "";
  return {
    root,
    home,
    installed,
    templates,
    output: new Writable({
      write(chunk, _encoding, next) {
        output += String(chunk);
        next();
      },
    }),
    text: () => output,
  };
}

describe("local plugin import through the installer", () => {
  it("preserves coding command permissions when importing read-only Controlled plugins into both workflows", async () => {
    const f = await fixture();
    await runInstaller({
      argv: ["--mode", "both", "--import-plugins", "--dsh-home", f.home],
      cwd: f.root,
      isTTY: true,
      env: {},
      input: Readable.from(["1\nplugin__audit__scan\ny\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    expect(await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8")).toContain(
      "plugin.audit.scan",
    );
    const commands = await readFile(join(f.root, ".github/workflows/dsh-commands.yml"), "utf8");
    expect(commands).not.toContain("plugin-config");
    expect(commands).toContain('allow-write: "true"');
    expect(commands).toContain('run-tests: "true"');
    expect(f.text()).toContain("configure command plugins manually");
  });
  it("keeps import optional and writes no plugin configuration when declined", async () => {
    const f = await fixture();
    await runInstaller({
      argv: ["--mode", "review", "--dsh-mode", "native", "--import-plugins", "--dsh-home", f.home],
      cwd: f.root,
      isTTY: true,
      env: {},
      input: Readable.from(["1\nn\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    expect(await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8")).not.toContain(
      "plugin-config",
    );
  });
  it("requires explicit read-only names for compatible Controlled tools", async () => {
    const f = await fixture();
    await runInstaller({
      argv: ["--mode", "review", "--import-plugins", "--dsh-home", f.home],
      cwd: f.root,
      isTTY: true,
      env: {},
      input: Readable.from(["1\nplugin__audit__scan\ny\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    const text = await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8");
    const config = /\{"schemaVersion":1,"bundles":\[.*?\],"plugins":\[\]\}/u.exec(text)?.[0];
    expect(parsePluginConfiguration(config ?? "").bundles[0]).toMatchObject({
      id: "audit",
      network: false,
      tools: [{ id: "scan", name: "plugin__audit__scan", permissions: ["read"] }],
    });
    expect(text).toContain("plugin.audit.scan");
    expect(text).toContain("permission-profile: strict");
    expect(text).not.toContain("PRIVATE_");
  });
  it("reports incompatible local plugins and rejects their selection without creating workflows", async () => {
    const f = await fixture();
    await writeFile(
      join(f.installed, "package.json"),
      JSON.stringify({
        name: "example-bundle",
        version: "1.2.3",
        engines: { dsh: "<0.2.0" },
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    await expect(
      runInstaller({
        argv: ["--mode", "review", "--import-plugins", "--dsh-home", f.home],
        cwd: f.root,
        isTTY: true,
        env: {},
        input: Readable.from(["1\n"]),
        output: f.output,
        templateDirectory: f.templates,
      }),
    ).rejects.toThrow("importable plugins");
    expect(f.text()).toContain("incompatible with DSH");
    await expect(readFile(join(f.root, ".github/workflows/dsh-review.yml"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("shows installed versions, confirms selection, and emits pinned Native config without local secrets", async () => {
    const f = await fixture();
    await runInstaller({
      argv: ["--mode", "review", "--dsh-mode", "native", "--import-plugins", "--dsh-home", f.home],
      cwd: f.root,
      isTTY: true,
      env: {},
      input: Readable.from(["1\ny\n"]),
      output: f.output,
      templateDirectory: f.templates,
    });
    const text = await readFile(join(f.root, ".github/workflows/dsh-review.yml"), "utf8");
    expect(f.text()).toContain("example-bundle@1.2.3");
    expect(f.text()).toContain("compatible");
    expect(text).not.toContain("PRIVATE_");
    expect(text).toContain('"source":"1.2.3"');
    expect(text).toContain("head.repo.full_name == github.repository");
    expect(text).toContain('allow-write: "false"');
    expect(text).toContain("permission-profile: strict");
    const config = /\{"schemaVersion":1,"bundles":\[.*?\],"plugins":\[\]\}/u.exec(text)?.[0];
    expect(parseNativePluginConfiguration(config ?? "").bundles[0]).toMatchObject({
      package: "example-bundle",
      source: "1.2.3",
      network: false,
      workspaceWrite: false,
    });
    expect(parse(text)).toBeDefined();
  });
});
