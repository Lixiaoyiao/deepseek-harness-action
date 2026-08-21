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

  it("blocks newly skipped tests but permits a test replacement", async () => {
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
      "test/old.test.ts": "test('old', () => expect(1).toBe(1));\n",
    });
    await rm(join(replacementFixture.snapshot.workerRoot, "test", "old.test.ts"));
    await write(
      replacementFixture.snapshot.workerRoot,
      "test/new.test.ts",
      "test('new', () => expect(2).toBe(2));\n",
    );
    const replacement = await audit(replacementFixture.snapshot, "strict", [["npm", "test"]]);
    expect(replacement).toMatchObject({ status: "changed", dangerousChangeCount: 0 });
  });

  it("blocks a test deletion with no replacement", async () => {
    const { snapshot } = await fixture({
      "package.json": packageJson({ test: "vitest run" }),
      "test/value.test.ts": "test('value', () => expect(1).toBe(1));\n",
    });
    await rm(join(snapshot.workerRoot, "test", "value.test.ts"));
    const strict = await audit(snapshot, "strict", [["npm", "test"]]);

    expect(strict).toMatchObject({ status: "blocked", dangerousChangeCount: 1 });
    expect(strict.changes[0]?.reasons.join(" ")).toMatch(/deleted without an added replacement/u);
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
    const runner = vi.fn<ValidationIntegrityRunner>(async (cwd) => {
      const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
        dependencies: Record<string, string>;
      };
      expect(manifest.scripts.test).toBe("vitest run");
      expect(manifest.dependencies).toEqual({ existing: "1.0.0", candidate: "2.0.0" });
      await expect(readFile(join(cwd, "src", "value.ts"), "utf8")).resolves.toContain("value = 2");
      await expect(readFile(join(cwd, "test", "value.test.ts"), "utf8")).resolves.toContain(
        "expect(2)",
      );
      return [passed()];
    });

    expect(strict).toMatchObject({
      status: "changed",
      dangerousChangeCount: 0,
      controlPlaneChangeCount: 1,
    });
    const enforced = await enforceValidationIntegrity({
      snapshot,
      commands: [["npm", "test"]],
      audit: strict,
      baselineReplay: { containerImage: "image@sha256:digest", runner },
    });
    expect(enforced.baselineReplay).toEqual({ status: "passed", commandCount: 1 });
    expect(runner).toHaveBeenCalledOnce();
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
