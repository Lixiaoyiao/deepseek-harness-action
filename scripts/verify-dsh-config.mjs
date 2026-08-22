import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
const dshBin = join(dshPackage, "..", "lib", "bin.js");
const headlessPackage = require.resolve("@deepseek-ai/dsh-headless/package.json");
const headlessRunner = join(headlessPackage, "..", "lib", "index.js");
const headlessStartup = join(headlessPackage, "..", "lib", "startup.js");
const projectRoot = join(import.meta.dirname, "..");
const dshHome = await mkdtemp(join(tmpdir(), "dsh-action-config-"));

try {
  const [runnerSource, startupSource] = await Promise.all([
    readFile(headlessRunner, "utf8"),
    readFile(headlessStartup, "utf8"),
  ]);
  assert.match(
    runnerSource,
    /const Config = z\.object\(\{ task: z\.string\(\)\.required\(\) \}\);/u,
    "the audited headless runner must accept only the single text task contract",
  );
  assert.match(
    runnerSource,
    /content:\s*\[\{\s*type:\s*"text",\s*text:\s*task\s*\}\]/u,
    "the audited headless runner must submit the task as one text content block",
  );
  assert.doesNotMatch(
    runnerSource,
    /type:\s*["']image["']/u,
    "GitHub attachments must remain deferred until the audited headless runner exposes images",
  );
  assert.match(
    startupSource,
    /\.argument\(\s*"\[task\.\.\.\]"/u,
    "the audited headless startup must continue to expose only the task positional",
  );

  for (const patch of [
    "strict-untrusted.patch.yml",
    "trusted-read.patch.yml",
    "trusted-write.patch.yml",
  ]) {
    const result = spawnSync(
      process.execPath,
      [
        dshBin,
        "--profile",
        "headless",
        "--patch",
        join(projectRoot, "assets", "dsh", patch),
        "--dump-config",
      ],
      {
        cwd: dshHome,
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          DSH_HOME: dshHome,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_TOOLS_MODE: "native",
        },
        timeout: 60_000,
      },
    );
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(
        `${patch} was rejected by DSH: ${result.error?.message ?? result.stderr ?? "unknown failure"}`,
      );
    }
  }
} finally {
  await rm(dshHome, { force: true, recursive: true });
}
