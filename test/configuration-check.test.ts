import { z } from "zod";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertStartupConfiguration,
  assertWriteTaskConfiguration,
  checkConfiguration,
} from "../src/configuration-check.js";
import { loadInputs } from "../src/inputs.js";

const execFileAsync = promisify(execFile);
const credentialInputs = {
  "deepseek-api-key": "check-controller-deepseek-key",
  "github-token": "check-controller-github-token",
};
const directories: string[] = [];
const inheritedCredentialNames = ["constructor", "toString", "valueOf", "__proto__"] as const;

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

function configuration(inputs: Record<string, string> = {}) {
  return { schemaVersion: 1, inputs: { ...credentialInputs, ...inputs } };
}

function inputs(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = { ...credentialInputs, ...overrides };
  return loadInputs((name) => values[name] ?? "");
}

describe("offline configuration check", () => {
  it.each(["controlled", "native"])(
    "uses the public %s schemas without claiming online/environment validation",
    (mode) => {
      const result = checkConfiguration(configuration({ "dsh-mode": mode }));
      expect(result.ok).toBe(true);
      expect(result.scope).toBe("static_configuration_only");
      expect(result.diagnostics.find(({ id }) => id === "action_inputs")?.status).toBe("passed");
      expect(
        result.diagnostics.filter(({ status }) => status === "not_checked").map(({ id }) => id),
      ).toEqual([
        "docker",
        "online_authority",
        "repository_validation",
        "runtime_extensions",
        "text_sources",
      ]);
    },
  );

  it("checks environment credential presence and never returns their values", () => {
    const document = {
      schemaVersion: 1,
      inputs: {},
      credentialEnv: { "deepseek-api-key": "CHECK_DSH_KEY", "github-token": "CHECK_GH_TOKEN" },
    };
    const result = checkConfiguration(document, {
      CHECK_DSH_KEY: credentialInputs["deepseek-api-key"],
    });
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find(({ id }) => id === "github-token")?.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain(credentialInputs["deepseek-api-key"]);
    expect(
      checkConfiguration(document, {
        CHECK_DSH_KEY: credentialInputs["deepseek-api-key"],
        CHECK_GH_TOKEN: credentialInputs["github-token"],
      }).ok,
    ).toBe(true);
  });

  it.each(inheritedCredentialNames)(
    "requires an own credential environment property for %s",
    (environmentName) => {
      const document = {
        schemaVersion: 1,
        inputs: { "github-token": credentialInputs["github-token"] },
        credentialEnv: { "deepseek-api-key": environmentName },
      };
      const missing = checkConfiguration(document, {});
      expect(missing.ok).toBe(false);
      expect(missing.diagnostics.find(({ id }) => id === "deepseek-api-key")).toMatchObject({
        status: "failed",
      });
      expect(missing.diagnostics.find(({ id }) => id === "deepseek-api-key")?.message).toContain(
        "missing",
      );
      const supplied = checkConfiguration(document, {
        [environmentName]: credentialInputs["deepseek-api-key"],
      });
      expect(supplied.ok).toBe(true);
      expect(JSON.stringify([missing, supplied])).not.toContain(
        credentialInputs["deepseek-api-key"],
      );
      expect(JSON.stringify([missing, supplied])).not.toContain(credentialInputs["github-token"]);
    },
  );

  it.each([
    { schemaVersion: 2, inputs: credentialInputs },
    { schemaVersion: 1, inputs: { ...credentialInputs, timeout: 3 } },
    { schemaVersion: 1, inputs: credentialInputs, execute: "repository-script" },
    {
      schemaVersion: 1,
      inputs: credentialInputs,
      credentialEnv: { "github-token": "bad env name" },
    },
  ])("rejects malformed checker document %j", (document) => {
    expect(checkConfiguration(document).ok).toBe(false);
  });

  it("rejects unknown input names and ambiguous credentials", () => {
    expect(checkConfiguration(configuration({ "dsh-mod": "controlled" })).ok).toBe(false);
    expect(
      checkConfiguration(
        { ...configuration(), credentialEnv: { "github-token": "TOKEN" } },
        { TOKEN: "environment-token" },
      ).ok,
    ).toBe(false);
  });

  it.each([
    { "dsh-version": "0.2.1-alpha.1" },
    { "dsh-version": "master" },
    { "dsh-mode": "native", isolation: "none" },
    { "plugin-config": '{"schemaVersion":1,"plugins":[{"unexpected":true}]}' },
    { "mcp-config": "not-json" },
    { "permission-profile": "missing" },
  ])("fails invalid public configuration %j", (values) => {
    expect(checkConfiguration(configuration(values)).ok).toBe(false);
  });

  it.each([
    { "test-commands": "[]" },
    { "run-tests": "false", "test-commands": '[["node","trusted-tests.mjs"]]' },
    { "test-commands": '[["REPLACE_WITH_YOUR_PROJECT_TEST_COMMAND"]]' },
    {
      "test-commands": JSON.stringify([
        ["node", "-e", 'console.error("REQUIRED: replace test-commands");process.exit(1)'],
      ]),
    },
    { "test-commands": '[["node","trusted-tests.mjs"]]', "container-image": "node:24" },
    { "test-commands": '[["node","trusted-tests.mjs"]]', isolation: "none" },
  ])("rejects an explicit write before model startup %j", (values) => {
    const result = checkConfiguration(
      configuration({
        command: "task",
        prompt: "Implement a small change",
        "task-access": "write",
        "allow-write": "true",
        ...values,
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.diagnostics.find(({ id }) => id === "action_inputs")?.status).toBe("failed");
  });

  it("keeps auto read routes compatible while warning that unconfigured writes fail closed", () => {
    const result = checkConfiguration(configuration({ "allow-write": "true" }));
    expect(result.ok).toBe(true);
    expect(result.diagnostics.find(({ id }) => id === "conditional_write")?.status).toBe("warning");
    expect(() => assertStartupConfiguration(inputs({ "allow-write": "true" }))).not.toThrow();
    expect(() => assertWriteTaskConfiguration(inputs({ "allow-write": "true" }))).toThrow(
      /test-commands/u,
    );
  });

  it("does not execute declared validation commands or echo credentials in errors", () => {
    const result = checkConfiguration(
      configuration({
        command: "task",
        prompt: "Task",
        "task-access": "write",
        "allow-write": "true",
        "test-commands": '[["node","untrusted-repo-script.mjs"]]',
      }),
    );
    expect(result.ok).toBe(true);
    const leaked = checkConfiguration(
      configuration({ "branch-prefix": credentialInputs["github-token"] }),
    );
    expect(leaked.ok).toBe(false);
    expect(JSON.stringify(leaked)).not.toContain(credentialInputs["github-token"]);
  });

  it("the actual CLI reads only its explicit JSON file and leaves repository code/remote state untouched", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-check-config-test-"));
    directories.push(directory);
    const marker = join(directory, "executed-marker");
    const path = join(directory, "check.json");
    await writeFile(
      path,
      JSON.stringify(
        configuration({
          command: "task",
          prompt: "Task",
          "task-access": "write",
          "allow-write": "true",
          "test-commands": JSON.stringify([
            [
              process.execPath,
              "-e",
              `require('fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe')`,
            ],
          ]),
        }),
      ),
      "utf8",
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/check-config.mjs", import.meta.url)), "--config", path],
      { cwd: directory, windowsHide: true },
    );
    expect(z.looseObject({ ok: z.boolean() }).parse(JSON.parse(stdout))).toMatchObject({
      ok: true,
    });
    await expect(readFile(marker)).rejects.toThrow();
    expect(stdout).not.toContain("unsafe");
    expect(stdout).not.toContain(credentialInputs["deepseek-api-key"]);
  });

  it("the actual CLI returns JSON for an inherited credential environment property", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-check-config-credential-"));
    directories.push(directory);
    const path = join(directory, "check.json");
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        inputs: { "github-token": credentialInputs["github-token"] },
        credentialEnv: { "deepseek-api-key": "constructor" },
      }),
      "utf8",
    );
    const result = await execFileAsync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/check-config.mjs", import.meta.url)), "--config", path],
      { cwd: directory, windowsHide: true, env: {}, timeout: 15_000 },
    ).then(
      ({ stdout, stderr }) => ({ failed: false, stdout, stderr }),
      (error: unknown) => ({
        failed: true,
        stdout: error instanceof Error && "stdout" in error ? String(error.stdout) : "",
        stderr: error instanceof Error && "stderr" in error ? String(error.stderr) : "",
      }),
    );
    expect(result.failed).toBe(true);
    expect(result.stderr).toBe("");
    const parsed = z
      .looseObject({
        ok: z.boolean(),
        diagnostics: z.array(z.looseObject({ id: z.string(), status: z.string() })),
      })
      .parse(JSON.parse(result.stdout));
    expect(parsed.ok).toBe(false);
    expect(parsed.diagnostics.find(({ id }) => id === "deepseek-api-key")?.status).toBe("failed");
    expect(result.stdout).not.toContain(credentialInputs["deepseek-api-key"]);
    expect(result.stdout).not.toContain(credentialInputs["github-token"]);
  });

  it.each(["missing", "encoding", "oversize", "json"])(
    "the CLI diagnoses %s without echoing selected file content",
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), "dsh-check-config-error-"));
      directories.push(directory);
      const path = join(directory, "check.json");
      if (kind === "encoding") await writeFile(path, Buffer.from([0xff, 0xfe, 0xfd]));
      if (kind === "oversize") await writeFile(path, "x".repeat(256 * 1024 + 1));
      if (kind === "json")
        await writeFile(path, `{ "private": "${credentialInputs["deepseek-api-key"]}"`, "utf8");
      const result = await execFileAsync(
        process.execPath,
        [fileURLToPath(new URL("../scripts/check-config.mjs", import.meta.url)), "--config", path],
        { cwd: directory, windowsHide: true },
      ).then(
        () => ({ failed: false, stderr: "" }),
        (error: unknown) => ({
          failed: true,
          stderr: error instanceof Error && "stderr" in error ? String(error.stderr) : "",
        }),
      );
      expect(result.failed).toBe(true);
      expect(result.stderr).toMatch(/could not be read|UTF-8 JSON|exceeds 256 KiB/u);
      expect(result.stderr).not.toContain(credentialInputs["deepseek-api-key"]);
    },
  );
});
