import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enforceValidationIntegrity,
  inspectValidationIntegrity,
  ValidationIntegrityError,
  type ValidationIntegrityMode,
  type ValidationIntegrityRunner,
} from "../src/write/validation-integrity.js";
import { ValidationFailureError, type ValidationResult } from "../src/write/validate.js";
import {
  createWorkspaceSnapshot,
  inspectWorkspaceChanges,
  type WorkspaceSnapshot,
} from "../src/write/workspace.js";

const temporaryRoots: string[] = [];

async function write(root: string, path: string, content: string): Promise<void> {
  const target = join(root, ...path.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

async function fixture(
  files: Readonly<Record<string, string>>,
): Promise<{ root: string; snapshot: WorkspaceSnapshot }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-integrity-test-"));
  temporaryRoots.push(root);
  const source = join(root, "source");
  const worker = join(root, "worker");
  await mkdir(source);
  for (const [path, content] of Object.entries(files)) await write(source, path, content);
  return { root, snapshot: await createWorkspaceSnapshot(source, worker) };
}

async function audit(
  snapshot: WorkspaceSnapshot,
  mode: ValidationIntegrityMode,
  commands: readonly (readonly string[])[],
  maxReportedChanges?: number,
) {
  const changes = await inspectWorkspaceChanges(snapshot);
  return inspectValidationIntegrity({
    snapshot,
    changes,
    commands,
    mode,
    ...(maxReportedChanges === undefined ? {} : { maxReportedChanges }),
  });
}

function packageJson(
  scripts: Readonly<Record<string, string>>,
  dependencies: Readonly<Record<string, string>> = {},
): string {
  return `${JSON.stringify({ scripts, dependencies }, null, 2)}\n`;
}

function passed(argv: readonly string[] = ["npm", "test"]): ValidationResult {
  return {
    argv,
    result: {
      exitCode: 0,
      stdout: "passed",
      stderr: "",
      timedOut: false,
      outputTruncated: false,
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("validation definition integrity", () => {
  it("reports dangerous changes in off and warn modes without enforcing them", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "test/value.test.ts": "test('value', () => expect(1).toBe(1));\n",
    });
    await write(
      snapshot.workerRoot,
      "package.json",
      packageJson({ test: "echo validation passed" }),
    );

    const off = await audit(snapshot, "off", [["npm", "test"]]);
    const warn = await audit(snapshot, "warn", [["npm", "test"]]);

    expect(off).toMatchObject({
      mode: "off",
      status: "changed",
      dangerousChangeCount: 1,
      controlPlaneChangeCount: 1,
    });
    expect(warn).toMatchObject({ mode: "warn", status: "warned", dangerousChangeCount: 1 });
    await expect(
      enforceValidationIntegrity({ snapshot, commands: [["npm", "test"]], audit: off }),
    ).resolves.toBe(off);
    await expect(
      enforceValidationIntegrity({ snapshot, commands: [["npm", "test"]], audit: warn }),
    ).resolves.toBe(warn);
  });

  it("allows normal source changes together with added and modified tests", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "src/value.ts": "export const value = 1;\n",
      "test/value.test.ts": "test('value', () => expect(1).toBe(1));\n",
    });
    await write(snapshot.workerRoot, "src/value.ts", "export const value = 2;\n");
    await write(
      snapshot.workerRoot,
      "test/value.test.ts",
      "test('value', () => expect(2).toBe(2));\n",
    );
    await write(
      snapshot.workerRoot,
      "test/extra.test.ts",
      "test('extra', () => expect('ok').toBe('ok'));\n",
    );
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);
    const runner = vi.fn<ValidationIntegrityRunner>();

    expect(strict).toMatchObject({
      status: "changed",
      dangerousChangeCount: 0,
      controlPlaneChangeCount: 0,
      testChangeCount: 2,
    });
    await expect(
      enforceValidationIntegrity({
        snapshot,
        commands: [["npm", "test"]],
        audit: strict,
        baselineReplay: { containerImage: "image@sha256:digest", runner },
      }),
    ).resolves.toBe(strict);
    expect(runner).not.toHaveBeenCalled();
  });

  it("blocks a configured package script changed to a no-op", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
    });
    await write(snapshot.workerRoot, "package.json", packageJson({ test: "true" }));
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes[0]).toMatchObject({
      path: "package.json",
      category: "entrypoint",
      risk: "dangerous",
      controlPlane: true,
    });
    const rejected = enforceValidationIntegrity({
      snapshot,
      commands: [["npm", "test"]],
      audit: strict,
    });
    await expect(rejected).rejects.toBeInstanceOf(ValidationIntegrityError);
    await expect(rejected).rejects.toBeInstanceOf(ValidationFailureError);
    await expect(rejected).rejects.toMatchObject({
      integrityCode: "VALIDATION_INTEGRITY",
      audit: { status: "blocked", dangerousChangeCount: 1 },
    });
  });

  it("tracks workspace entrypoints referenced by lifecycle and nested package scripts", async () => {
    const scripts = {
      pretest: "node scripts/pretest.mjs",
      test: "npm run verify",
      posttest: "node scripts/posttest.mjs",
      preverify: "node scripts/preverify.mjs",
      verify: "node scripts/verify.mjs",
      postverify: "node scripts/postverify.mjs",
    };
    const files = Object.fromEntries(
      ["pretest", "posttest", "preverify", "verify", "postverify"].map((name) => [
        `scripts/${name}.mjs`,
        `if (!process.env.CI) throw new Error('${name}');\n`,
      ]),
    );
    const { snapshot } = await fixture({ "package.json": packageJson(scripts), ...files });
    for (const name of ["pretest", "posttest", "preverify", "verify", "postverify"]) {
      await write(snapshot.workerRoot, `scripts/${name}.mjs`, "process.exit(0);\n");
    }

    const strict = await audit(snapshot, "strict", [["npm", "test"]]);
    const entrypoints = strict.changes.filter(({ category }) => category === "entrypoint");

    expect(strict).toMatchObject({
      status: "blocked",
      dangerousChangeCount: 5,
      controlPlaneChangeCount: 5,
    });
    expect(entrypoints.map(({ path }) => path).sort()).toEqual([
      "scripts/posttest.mjs",
      "scripts/postverify.mjs",
      "scripts/pretest.mjs",
      "scripts/preverify.mjs",
      "scripts/verify.mjs",
    ]);
    expect(
      entrypoints.every(({ risk, controlPlane }) => risk === "dangerous" && controlPlane),
    ).toBe(true);
  });

  it.each([
    ["cross-env", ["cross-env", "CI=1", "node", "scripts/check.mjs"]],
    ["Python module", ["python", "-m", "scripts.validate"]],
    ["stdin", ["bash", "-s", "<", "scripts/check.sh"]],
  ])("tracks the configured %s workspace entrypoint", async (_name, command) => {
    const path = command.includes("scripts.validate")
      ? "scripts/validate.py"
      : command.includes("scripts/check.sh")
        ? "scripts/check.sh"
        : "scripts/check.mjs";
    const { snapshot } = await fixture({ [path]: "throw new Error('validation failed');\n" });
    await write(snapshot.workerRoot, path, "process.exit(0);\n");

    const strict = await audit(snapshot, "strict", [command]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual([
      expect.objectContaining({ path, category: "entrypoint", controlPlane: true }),
    ]);
  });

  it.each([
    ["unknown wrapper", ["mystery-wrapper", "node", "scripts/check.mjs"]],
    ["dynamic executable", ["$VALIDATOR", "scripts/check.mjs"]],
    ["dynamic stdin", ["bash", "-s", "<<EOF"]],
    ["recursive package-manager workspace", ["pnpm", "-r", "test"]],
    ["Yarn positional workspace", ["yarn", "workspace", "app", "test"]],
    [
      "out-of-workspace package-manager directory",
      ["npm", "--prefix", "/tmp/outside", "exec", "--", "vitest"],
    ],
  ])("fails closed for a configured %s shape", async (_name, command) => {
    const { snapshot } = await fixture({ "src/value.ts": "export const value = 1;\n" });
    await write(snapshot.workerRoot, "src/value.ts", "export const value = 2;\n");

    const strict = await audit(snapshot, "strict", [command]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes[0]).toMatchObject({
      path: "src/value.ts",
      category: "entrypoint",
      risk: "dangerous",
      controlPlane: true,
    });
    expect(strict.changes[0]?.reasons.join(" ")).toMatch(/fails closed/u);
  });

  it("tracks NODE_OPTIONS hooks resolved from extensionless paths", async () => {
    const { snapshot } = await fixture({
      "hooks/register.js": "throw new Error('validation hook failed');\n",
      "scripts/check.mjs": "export {};\n",
    });
    await write(snapshot.workerRoot, "hooks/register.js", "process.exit(0);\n");

    const strict = await audit(snapshot, "strict", [
      ["NODE_OPTIONS=--require=./hooks/register", "node", "scripts/check.mjs"],
    ]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "hooks/register.js",
        category: "entrypoint",
        controlPlane: true,
      }),
    ]);
  });

  it("follows package scripts invoked by a static shell validation entrypoint", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "scripts/validate.sh": "npm test\n",
    });
    await write(snapshot.workerRoot, "package.json", packageJson({ test: "true" }));

    const strict = await audit(snapshot, "strict", [["bash", "scripts/validate.sh"]]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "package.json",
        category: "entrypoint",
        risk: "dangerous",
        controlPlane: true,
      }),
    ]);
  });

  it.each([
    ["npx", ["npx", "--prefix", "packages/app", "vitest", "run"]],
    ["npm exec", ["npm", "--prefix", "packages/app", "exec", "--", "vitest", "run"]],
  ])("binds direct %s validation to its nearest package manifest", async (_name, command) => {
    const manifest = (version: string) =>
      `${JSON.stringify({ devDependencies: { vitest: version } }, null, 2)}\n`;
    const { snapshot } = await fixture({ "packages/app/package.json": manifest("1.0.0") });
    await write(snapshot.workerRoot, "packages/app/package.json", manifest("file:./fake-vitest"));

    const strict = await audit(snapshot, "strict", [command]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "packages/app/package.json",
        category: "validation-runtime",
        risk: "dangerous",
        controlPlane: true,
      }),
    ]);
  });

  it("binds Node entrypoints to their nearest package scope and replays an added manifest", async () => {
    const { snapshot } = await fixture({
      "package.json": `${JSON.stringify({ type: "module" }, null, 2)}\n`,
      "packages/app/check.js": "export {};\n",
    });
    await write(snapshot.workerRoot, "packages/app/package.json", "{}\n");
    const strict = await audit(snapshot, "strict", [["node", "packages/app/check.js"]]);
    const runner = vi.fn<ValidationIntegrityRunner>(async (cwd) => {
      await expect(
        readFile(join(cwd, "packages", "app", "package.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      return [passed(["node", "packages/app/check.js"])];
    });

    expect(strict).toMatchObject({
      status: "changed",
      dangerousChangeCount: 0,
      controlPlaneChangeCount: 1,
    });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "packages/app/package.json",
        category: "validation-runtime",
        risk: "suspicious",
        controlPlane: true,
      }),
    ]);
    const enforced = await enforceValidationIntegrity({
      snapshot,
      commands: [["node", "packages/app/check.js"]],
      audit: strict,
      baselineReplay: { containerImage: "image@sha256:digest", runner },
    });
    expect(enforced.baselineReplay).toEqual({ status: "passed", commandCount: 1 });
  });

  it("blocks replacement of configured validation dependencies in manifests and locks", async () => {
    const baselineLock = {
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { vitest: "1.0.0" } },
        "node_modules/vitest": {
          version: "1.0.0",
          resolved: "https://registry.example/vitest-1.0.0.tgz",
          integrity: "sha512-baseline",
        },
      },
    };
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest" }, { vitest: "1.0.0" }),
      "package-lock.json": `${JSON.stringify(baselineLock, null, 2)}\n`,
    });
    await write(
      snapshot.workerRoot,
      "package.json",
      packageJson({ test: "vitest" }, { vitest: "file:./fake-vitest" }),
    );
    await write(
      snapshot.workerRoot,
      "package-lock.json",
      `${JSON.stringify(
        {
          lockfileVersion: 3,
          packages: {
            "": { dependencies: { vitest: "file:./fake-vitest" } },
            "node_modules/vitest": {
              version: "0.0.0",
              resolved: "file:fake-vitest",
              integrity: "sha512-candidate",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const strict = await audit(snapshot, "strict", [["npm", "test"]]);

    expect(strict).toMatchObject({
      status: "blocked",
      dangerousChangeCount: 2,
      controlPlaneChangeCount: 2,
    });
    expect(strict.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "package.json",
          category: "validation-runtime",
          risk: "dangerous",
          controlPlane: true,
        }),
        expect.objectContaining({
          path: "package-lock.json",
          category: "validation-runtime",
          risk: "dangerous",
          controlPlane: true,
        }),
      ]),
    );
  });

  it("blocks newly skipped tests and does not accept an unrelated dummy as a replacement", async () => {
    const skippedFixture = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "test/value.test.ts": "test('value', () => expect(1).toBe(1));\n",
    });
    await write(
      skippedFixture.snapshot.workerRoot,
      "test/value.test.ts",
      "test.skip('value', () => expect(1).toBe(1));\n",
    );
    const skipped = await audit(skippedFixture.snapshot, "strict", [["npm", "test"]]);
    expect(skipped).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });

    const replacementFixture = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "test/critical.test.ts":
        "test('authorization is enforced', () => expect(authorize('untrusted')).toBe(false));\n",
    });
    await rm(join(replacementFixture.snapshot.workerRoot, "test", "critical.test.ts"));
    await write(
      replacementFixture.snapshot.workerRoot,
      "test/dummy.test.ts",
      "test('dummy', () => expect(true).toBe(true));\n",
    );
    const replacement = await audit(replacementFixture.snapshot, "strict", [["npm", "test"]]);
    expect(replacement).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(replacement.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "test/critical.test.ts",
          change: "deleted",
          risk: "dangerous",
        }),
      ]),
    );
  });

  it("blocks a test deletion with no replacement", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "test/value.test.ts": "test('value', () => expect(1).toBe(1));\n",
    });
    await rm(join(snapshot.workerRoot, "test", "value.test.ts"));
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes[0]?.reasons.join(" ")).toMatch(
      /deleted without an identical-content rename/u,
    );
  });

  it("does not treat a move to a non-executable test shape as a safe rename", async () => {
    const content = "test('critical authorization', () => expect(false).toBe(false));\n";
    const { snapshot } = await fixture({ "test/critical.test.ts": content });
    await rm(join(snapshot.workerRoot, "test", "critical.test.ts"));
    await write(snapshot.workerRoot, "test/critical.txt", content);
    await write(snapshot.workerRoot, "test/dummy.test.ts", "test('dummy', () => {});\n");

    const strict = await audit(snapshot, "strict", [["vitest", "run"]]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "test/critical.test.ts",
          change: "deleted",
          risk: "dangerous",
        }),
      ]),
    );
  });

  it.each([
    {
      name: "Jest testMatch",
      command: "jest",
      discovery: { jest: { testMatch: ["**/*.test.ts"] } },
    },
    {
      name: "Vitest include",
      command: "vitest",
      discovery: { vitest: { include: ["**/*.test.ts"] } },
    },
  ])("does not treat a rename outside configured $name as safe", async ({ command, discovery }) => {
    const content = "test('critical authorization', () => expect(false).toBe(false));\n";
    const manifest = `${JSON.stringify(
      {
        scripts: { test: command },
        devDependencies: { [command]: "1.0.0" },
        ...discovery,
      },
      null,
      2,
    )}\n`;
    const { snapshot } = await fixture({
      "package.json": manifest,
      "test/critical.test.ts": content,
    });
    await rm(join(snapshot.workerRoot, "test", "critical.test.ts"));
    await write(snapshot.workerRoot, "test/critical.spec.ts", content);
    await write(snapshot.workerRoot, "test/dummy.test.ts", "test('dummy', () => {});\n");

    const strict = await audit(snapshot, "strict", [["npm", "test"]]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "test/critical.test.ts",
          change: "deleted",
          risk: "dangerous",
        }),
      ]),
    );
  });

  it("preserves informational rename handling when the target remains executable", async () => {
    const content = "test('critical authorization', () => expect(false).toBe(false));\n";
    const { snapshot } = await fixture({ "test/critical.test.ts": content });
    await rm(join(snapshot.workerRoot, "test", "critical.test.ts"));
    await write(snapshot.workerRoot, "test/critical.spec.ts", content);

    const strict = await audit(snapshot, "strict", [["vitest", "run"]]);

    expect(strict).toMatchObject({ status: "changed", dangerousChangeCount: 0 });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "test/critical.spec.ts",
        previousPath: "test/critical.test.ts",
        change: "renamed",
        risk: "informational",
      }),
    ]);
  });

  it("blocks configured direct entrypoint removal and explicit config relaxation", async () => {
    const directFixture = await fixture({
      "scripts/check.mjs": "import './verify.mjs';\n",
      "scripts/verify.mjs": "export {};\n",
    });
    await rm(join(directFixture.snapshot.workerRoot, "scripts", "check.mjs"));
    const direct = await audit(directFixture.snapshot, "strict", [["node", "scripts/check.mjs"]]);
    expect(direct).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(direct.changes[0]).toMatchObject({ category: "entrypoint", controlPlane: true });

    const configFixture = await fixture({
      "package.json": packageJson({ typecheck: "tsc --noEmit" }),
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
    });
    await write(
      configFixture.snapshot.workerRoot,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: false, noEmit: true } }),
    );
    const config = await audit(configFixture.snapshot, "strict", [["npm", "run", "typecheck"]]);
    expect(config).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(config.changes[0]).toMatchObject({
      path: "tsconfig.json",
      category: "typecheck-config",
      risk: "dangerous",
    });
  });

  it("consumes interpreter option values before identifying the main entrypoint", async () => {
    const { snapshot } = await fixture({
      "hooks/register.cjs": "globalThis.validationHook = true;\n",
      "scripts/check.mjs": "if (!globalThis.validationHook) process.exit(1);\n",
    });
    await write(snapshot.workerRoot, "scripts/check.mjs", "process.exit(0);\n");

    const strict = await audit(snapshot, "strict", [
      ["node", "--require", "hooks/register.cjs", "scripts/check.mjs"],
    ]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "scripts/check.mjs",
        category: "entrypoint",
        risk: "dangerous",
        controlPlane: true,
      }),
    ]);
  });

  it("replays baseline package scripts while preserving candidate code, tests, and dependencies", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson(
        { test: "vitest run", typecheck: "tsc --noEmit" },
        { existing: "1.0.0" },
      ),
      "src/value.ts": "export const value = 1;\n",
      "test/value.test.ts": "test('value', () => expect(1).toBe(1));\n",
    });
    await write(
      snapshot.workerRoot,
      "package.json",
      packageJson(
        { test: "vitest run && npm run typecheck", typecheck: "tsc --noEmit" },
        { existing: "1.0.0", candidate: "2.0.0" },
      ),
    );
    await write(snapshot.workerRoot, "src/value.ts", "export const value = 2;\n");
    await write(
      snapshot.workerRoot,
      "test/value.test.ts",
      "test('value', () => expect(2).toBe(2));\n",
    );
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);
    const controller = new AbortController();
    const runner = vi.fn<ValidationIntegrityRunner>(
      async (cwd, _commands, _image, _timeout, signal) => {
        expect(signal).toBe(controller.signal);
        const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
          dependencies: Record<string, string>;
        };
        expect(manifest.scripts.test).toBe("vitest run");
        expect(manifest.dependencies).toEqual({ existing: "1.0.0", candidate: "2.0.0" });
        await expect(readFile(join(cwd, "src", "value.ts"), "utf8")).resolves.toContain(
          "value = 2",
        );
        await expect(readFile(join(cwd, "test", "value.test.ts"), "utf8")).resolves.toContain(
          "expect(2)",
        );
        return [passed()];
      },
    );

    expect(strict).toMatchObject({
      status: "changed",
      dangerousChangeCount: 0,
      controlPlaneChangeCount: 1,
    });
    const enforced = await enforceValidationIntegrity({
      snapshot,
      commands: [["npm", "test"]],
      audit: strict,
      baselineReplay: {
        containerImage: "image@sha256:digest",
        signal: controller.signal,
        runner,
      },
    });
    expect(enforced.baselineReplay).toEqual({ status: "passed", commandCount: 1 });
    expect(runner).toHaveBeenCalledOnce();
  });

  it("replays embedded package validation controls while preserving dependency additions", async () => {
    const manifest = (testMatch: string, includeCandidate: boolean) =>
      `${JSON.stringify(
        {
          scripts: { test: "jest" },
          dependencies: {
            jest: "1.0.0",
            ...(includeCandidate ? { candidate: "2.0.0" } : {}),
          },
          jest: { testMatch: [testMatch] },
        },
        null,
        2,
      )}\n`;
    const { snapshot } = await fixture({
      "package.json": manifest("<rootDir>/test/**/*.test.js", false),
    });
    await write(snapshot.workerRoot, "package.json", manifest("<rootDir>/dummy/**/*.js", true));
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);
    const runner = vi.fn<ValidationIntegrityRunner>(async (cwd) => {
      const replayed = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        jest: { testMatch: string[] };
      };
      expect(replayed.jest.testMatch).toEqual(["<rootDir>/test/**/*.test.js"]);
      expect(replayed.dependencies).toEqual({ jest: "1.0.0", candidate: "2.0.0" });
      return [passed()];
    });

    expect(strict).toMatchObject({
      status: "changed",
      dangerousChangeCount: 0,
      controlPlaneChangeCount: 1,
    });
    expect(strict.changes).toEqual([
      expect.objectContaining({
        path: "package.json",
        category: "validation-runtime",
        risk: "suspicious",
        controlPlane: true,
      }),
    ]);
    const enforced = await enforceValidationIntegrity({
      snapshot,
      commands: [["npm", "test"]],
      audit: strict,
      baselineReplay: { containerImage: "image@sha256:digest", runner },
    });
    expect(enforced.baselineReplay).toEqual({ status: "passed", commandCount: 1 });
  });

  it("turns a failed baseline replay into a repairable integrity error", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
    });
    await write(
      snapshot.workerRoot,
      "package.json",
      packageJson({ test: "vitest run --coverage" }),
    );
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);
    const runner = vi.fn<ValidationIntegrityRunner>(() =>
      Promise.resolve([
        {
          argv: ["npm", "test"],
          result: {
            exitCode: 1,
            stdout: "",
            stderr: "baseline suite failed",
            timedOut: false,
            outputTruncated: false,
          },
        },
      ]),
    );

    await expect(
      enforceValidationIntegrity({
        snapshot,
        commands: [["npm", "test"]],
        audit: strict,
        baselineReplay: { containerImage: "image@sha256:digest", runner },
      }),
    ).rejects.toMatchObject({
      name: "ValidationIntegrityError",
      audit: { status: "blocked", baselineReplay: { status: "failed", commandCount: 1 } },
    });
  });

  it("bounds the public change list while retaining aggregate counts", async () => {
    const { snapshot } = await fixture({
      "scripts/check.mjs": "process.exit(0);\n",
      "test/a.test.ts": "test('a', () => {});\n",
      "test/b.test.ts": "test('b', () => {});\n",
    });
    await write(snapshot.workerRoot, "test/a.test.ts", "test('a2', () => {});\n");
    await write(snapshot.workerRoot, "test/b.test.ts", "test('b2', () => {});\n");
    const result = await audit(snapshot, "warn", [["node", "scripts/check.mjs"]], 1);

    expect(result).toMatchObject({ changeCount: 2, truncated: true });
    expect(result.changes).toHaveLength(1);
  });
});
