import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse as parsePath } from "node:path";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  runInstaller,
  type InstallerDshMode,
  type InstallerMode,
} from "../packages/create-deepseek-harness-action/src/installer.mjs";

const execFileAsync = promisify(execFile);
const INSTALLER_VERSION = "0.2.0";
const RELEASE_SHA = "1234567890abcdef1234567890abcdef12345678";
const RELEASE_TOKEN = "__DSH_ACTION_RELEASE_SHA__";
const DSH_MODE_TOKEN = "__DSH_MODE_INPUT__";
const packageRoot = new URL("../packages/create-deepseek-harness-action/", import.meta.url);
const packageRootPath = fileURLToPath(packageRoot);
const buildScript = fileURLToPath(new URL("scripts/build.mjs", packageRoot));
const sourceTemplates = new URL("src/templates/", packageRoot);

function npmCommand(): { executable: string; prefix: string[] } {
  if (process.platform !== "win32") return { executable: "npm", prefix: [] };
  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  return { executable: process.execPath, prefix: [npmCli] };
}

let suiteDirectory = "";
let builtPackage = "";

class OutputCapture extends Writable {
  public text = "";

  public override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.text += chunk.toString();
    callback();
  }
}

async function createProject(): Promise<string> {
  return mkdtemp(join(suiteDirectory, "project-"));
}

async function workflow(project: string, name: "dsh-review.yml" | "dsh-commands.yml") {
  return readFile(join(project, ".github", "workflows", name), "utf8");
}

async function install(mode: InstallerMode, dshMode?: InstallerDshMode, project?: string) {
  const targetProject = project ?? (await createProject());
  const output = new OutputCapture();
  const result = await runInstaller({
    argv: ["--mode", mode, ...(dshMode === undefined ? [] : ["--dsh-mode", dshMode])],
    cwd: targetProject,
    input: Readable.from([]),
    output,
    isTTY: false,
    templateDirectory: join(builtPackage, "templates"),
  });
  return { output: output.text, project: targetProject, result };
}

beforeAll(async () => {
  suiteDirectory = await mkdtemp(join(tmpdir(), "create-dsh-action-test-"));
  builtPackage = join(suiteDirectory, "dist");
  await execFileAsync(process.execPath, [buildScript, "--output", builtPackage], {
    env: { ...process.env, DSH_ACTION_RELEASE_SHA: RELEASE_SHA },
    windowsHide: true,
  });
});

afterAll(async () => {
  if (suiteDirectory !== "") await rm(suiteDirectory, { force: true, recursive: true });
});

describe("create-deepseek-harness-action release build", () => {
  it("declares the independent 0.2.0 npm create package", async () => {
    const manifest: unknown = JSON.parse(
      await readFile(new URL("package.json", packageRoot), "utf8"),
    );
    expect(manifest).toMatchObject({
      name: "create-deepseek-harness-action",
      version: INSTALLER_VERSION,
      private: false,
      type: "module",
      bin: { "create-deepseek-harness-action": "./dist/cli.mjs" },
      files: ["dist/"],
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    });
  });

  it("requires the real release SHA and deterministically builds four bound templates", async () => {
    expect((await readdir(sourceTemplates)).sort()).toEqual(["dsh-commands.yml", "dsh-review.yml"]);

    const repeatedBuild = join(suiteDirectory, "repeated-build");
    await execFileAsync(process.execPath, [buildScript, "--output", repeatedBuild], {
      env: { ...process.env, DSH_ACTION_RELEASE_SHA: RELEASE_SHA },
      windowsHide: true,
    });

    for (const sourceName of ["dsh-review.yml", "dsh-commands.yml"] as const) {
      const source = await readFile(new URL(sourceName, sourceTemplates), "utf8");
      expect(source.split(RELEASE_TOKEN)).toHaveLength(2);
      expect(source.split(DSH_MODE_TOKEN)).toHaveLength(2);
      expect(source).not.toMatch(/^\s*dsh-mode:/mu);
    }

    for (const [name, dshMode] of [
      ["dsh-review.yml", "controlled"],
      ["dsh-review-native.yml", "native"],
      ["dsh-commands.yml", "controlled"],
      ["dsh-commands-native.yml", "native"],
    ] as const) {
      const built = await readFile(join(builtPackage, "templates", name), "utf8");
      await expect(readFile(join(repeatedBuild, "templates", name), "utf8")).resolves.toBe(built);
      expect(built).not.toContain(RELEASE_TOKEN);
      expect(built).not.toContain(DSH_MODE_TOKEN);
      expect(built).toContain(`Lixiaoyiao/deepseek-harness-action@${RELEASE_SHA}`);
      expect(built.match(new RegExp(`deepseek-harness-action@${RELEASE_SHA}`, "gu"))).toHaveLength(
        1,
      );
      expect(() => {
        parse(built);
      }).not.toThrow();
      if (dshMode === "controlled") {
        expect(built).not.toMatch(/^\s*dsh-mode:/mu);
      } else {
        expect(built.match(/^\s*dsh-mode: native\s*$/gmu)).toHaveLength(1);
      }
    }

    for (const name of ["cli.mjs", "installer.mjs"] as const) {
      const runtime = await readFile(join(builtPackage, name), "utf8");
      expect(runtime).not.toContain(RELEASE_TOKEN);
      expect(runtime).not.toContain(DSH_MODE_TOKEN);
    }
    await expect(readFile(join(builtPackage, "installer.mjs"), "utf8")).resolves.toContain(
      "/blob/v0.8.0/docs/setup.md",
    );

    for (const [index, invalidReleaseSha] of [
      undefined,
      "v0.6.0",
      "1234",
      "A".repeat(40),
      "g".repeat(40),
    ].entries()) {
      const environment = { ...process.env };
      if (invalidReleaseSha === undefined) delete environment.DSH_ACTION_RELEASE_SHA;
      else environment.DSH_ACTION_RELEASE_SHA = invalidReleaseSha;
      await expect(
        execFileAsync(
          process.execPath,
          [buildScript, "--output", join(suiteDirectory, `invalid-build-${String(index)}`)],
          { env: environment, windowsHide: true },
        ),
      ).rejects.toThrow(/DSH_ACTION_RELEASE_SHA/u);
    }

    for (const unsafeOutput of [packageRootPath, process.cwd(), parsePath(process.cwd()).root]) {
      await expect(
        execFileAsync(process.execPath, [buildScript, "--output", unsafeOutput], {
          env: { ...process.env, DSH_ACTION_RELEASE_SHA: RELEASE_SHA },
          windowsHide: true,
        }),
      ).rejects.toThrow(/unsafe build output|package dist directory or a specific temp child/u);
    }
  });

  it("keeps the formal npm pack stdout machine-readable", async () => {
    const packDirectory = join(suiteDirectory, "pack");
    await mkdir(packDirectory);
    const npm = npmCommand();
    const { stdout } = await execFileAsync(
      npm.executable,
      [...npm.prefix, "pack", "--silent", "--json", "--pack-destination", packDirectory],
      {
        cwd: packageRoot,
        env: { ...process.env, DSH_ACTION_RELEASE_SHA: RELEASE_SHA },
        windowsHide: true,
      },
    );
    const packResult = JSON.parse(stdout) as {
      filename?: string;
      files?: { path?: string }[];
      name?: string;
      version?: string;
    }[];

    expect(packResult).toHaveLength(1);
    expect(packResult[0]).toMatchObject({
      filename: `create-deepseek-harness-action-${INSTALLER_VERSION}.tgz`,
      name: "create-deepseek-harness-action",
      version: INSTALLER_VERSION,
    });
    await expect(
      readFile(join(packDirectory, packResult[0]?.filename ?? "")),
    ).resolves.not.toHaveLength(0);
    expect(packResult[0]?.files?.map(({ path }) => path).sort()).toEqual(
      expect.arrayContaining([
        "dist/templates/dsh-commands-native.yml",
        "dist/templates/dsh-commands.yml",
        "dist/templates/dsh-review-native.yml",
        "dist/templates/dsh-review.yml",
      ]),
    );
  });
});

describe("installer modes", () => {
  it("creates Review and its parent directories", async () => {
    const { output, project, result } = await install("review");

    await expect(workflow(project, "dsh-review.yml")).resolves.toContain("name: DSH review");
    await expect(workflow(project, "dsh-commands.yml")).rejects.toThrow();
    expect(result).toEqual({
      mode: "review",
      dshMode: "controlled",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    await expect(workflow(project, "dsh-review.yml")).resolves.not.toMatch(/^\s*dsh-mode:/mu);
    expect(output).toContain("DSH mode: controlled");
    expect(output).toContain("DEEPSEEK_API_KEY");
    expect(output).toContain("open or update a non-draft pull request");
    expect(output).toContain("docs/setup.md");
  });

  it("creates Commands without assuming an npm project", async () => {
    const { output, project, result } = await install("commands");
    const commands = await workflow(project, "dsh-commands.yml");

    expect(commands).toContain("name: DSH commands");
    expect(commands).toContain("REQUIRED: Replace this fail-closed placeholder");
    expect(commands).not.toMatch(/\b(?:npm|pnpm|yarn)\b/u);
    expect(result.dshMode).toBe("controlled");
    expect(result.createdFiles).toEqual([".github/workflows/dsh-commands.yml"]);
    expect(output).toContain("Replace the fail-closed test-commands placeholder");
    expect(output).toContain("digest-pinned container-image");
    expect(output).toContain("start an Issue or pull request comment with an @dsh command");
    expect(output).toContain("DEEPSEEK_API_KEY");
    expect(output).toContain("docs/setup.md");
  });

  it("creates Both workflows", async () => {
    const { output, project, result } = await install("both");

    await expect(workflow(project, "dsh-review.yml")).resolves.toContain("name: DSH review");
    await expect(workflow(project, "dsh-commands.yml")).resolves.toContain("name: DSH commands");
    expect(result.createdFiles).toEqual([
      ".github/workflows/dsh-review.yml",
      ".github/workflows/dsh-commands.yml",
    ]);
    expect(result.dshMode).toBe("controlled");
    expect(output).toContain("dsh-review.yml");
    expect(output).toContain("dsh-commands.yml");
    expect(output).toContain("DEEPSEEK_API_KEY");
    expect(output).toContain("open or update a non-draft pull request");
    expect(output).toContain("start an Issue or pull request comment with an @dsh command");
    expect(output).toContain("docs/setup.md");
  });

  it.each([
    ["review", "controlled", ["dsh-review.yml"]],
    ["commands", "controlled", ["dsh-commands.yml"]],
    ["both", "controlled", ["dsh-review.yml", "dsh-commands.yml"]],
    ["review", "native", ["dsh-review.yml"]],
    ["commands", "native", ["dsh-commands.yml"]],
    ["both", "native", ["dsh-review.yml", "dsh-commands.yml"]],
  ] as const)(
    "installs the non-interactive %s/%s combination",
    async (mode, dshMode, createdNames) => {
      const { output, project, result } = await install(mode, dshMode);
      expect(result).toEqual({
        mode,
        dshMode,
        createdFiles: createdNames.map((name) => `.github/workflows/${name}`),
      });
      expect(output).toContain(`DSH mode: ${dshMode}`);

      for (const name of createdNames) {
        const contents = await workflow(project, name);
        expect(() => {
          parse(contents);
        }).not.toThrow();
        expect(
          contents.match(new RegExp(`deepseek-harness-action@${RELEASE_SHA}`, "gu")),
        ).toHaveLength(1);
        expect(contents).not.toContain(RELEASE_TOKEN);
        expect(contents).not.toContain(DSH_MODE_TOKEN);
        if (dshMode === "controlled") {
          expect(contents).not.toMatch(/^\s*dsh-mode:/mu);
        } else {
          expect(contents.match(/^\s*dsh-mode: native\s*$/gmu)).toHaveLength(1);
        }
      }
    },
  );

  it.each([
    ["1\n1\n", "review", "controlled", [".github/workflows/dsh-review.yml"]],
    ["2\n2\n", "commands", "native", [".github/workflows/dsh-commands.yml"]],
    [
      "3\n1\n",
      "both",
      "controlled",
      [".github/workflows/dsh-review.yml", ".github/workflows/dsh-commands.yml"],
    ],
  ] as const)("supports interactive choices %s", async (answer, mode, dshMode, createdFiles) => {
    const project = await createProject();
    const output = new OutputCapture();
    const result = await runInstaller({
      argv: [],
      cwd: project,
      input: Readable.from([answer]),
      output,
      isTTY: true,
      env: {},
      templateDirectory: join(builtPackage, "templates"),
    });

    expect(result).toEqual({ mode, dshMode, createdFiles: [...createdFiles] });
    expect(output.text).toContain("PR Review");
    expect(output.text).toContain("@dsh Coding Commands");
    expect(output.text).toContain("Both");
    expect(output.text).toContain("Controlled");
    expect(output.text).toContain("Native");
  });

  it("prompts only for DSH mode when the workflow mode is explicit", async () => {
    const project = await createProject();
    const output = new OutputCapture();
    const result = await runInstaller({
      argv: ["--mode", "review"],
      cwd: project,
      input: Readable.from(["2\n"]),
      output,
      isTTY: true,
      env: {},
      templateDirectory: join(builtPackage, "templates"),
    });

    expect(result).toEqual({
      mode: "review",
      dshMode: "native",
      createdFiles: [".github/workflows/dsh-review.yml"],
    });
    expect(output.text).not.toContain("Choose what to install");
    expect(output.text).toContain("Choose the DSH mode");
  });

  it("prompts only for workflow mode when DSH mode is explicit", async () => {
    const project = await createProject();
    const output = new OutputCapture();
    const result = await runInstaller({
      argv: ["--dsh-mode", "native"],
      cwd: project,
      input: Readable.from(["3\n"]),
      output,
      isTTY: true,
      env: {},
      templateDirectory: join(builtPackage, "templates"),
    });

    expect(result).toEqual({
      mode: "both",
      dshMode: "native",
      createdFiles: [".github/workflows/dsh-review.yml", ".github/workflows/dsh-commands.yml"],
    });
    expect(output.text).toContain("Choose what to install");
    expect(output.text).not.toContain("Choose the DSH mode");
  });
});

describe("safe filesystem and non-interactive behavior", () => {
  it.each(["controlled", "native"] as const)(
    "preflights Both/%s and does not overwrite or partially create workflows",
    async (dshMode) => {
      const project = await createProject();
      const workflowDirectory = join(project, ".github", "workflows");
      const existingReview = join(workflowDirectory, "dsh-review.yml");
      await mkdir(workflowDirectory, { recursive: true });
      await writeFile(existingReview, "user-owned\n", "utf8");

      await expect(
        runInstaller({
          argv: ["--mode", "both", "--dsh-mode", dshMode],
          cwd: project,
          input: Readable.from([]),
          output: new OutputCapture(),
          isTTY: false,
          templateDirectory: join(builtPackage, "templates"),
        }),
      ).rejects.toThrow(/Refusing to overwrite.*dsh-review\.yml/su);

      await expect(readFile(existingReview, "utf8")).resolves.toBe("user-owned\n");
      await expect(workflow(project, "dsh-commands.yml")).rejects.toThrow();
    },
  );

  it.each(["other", "", "CONTROLLED"])(
    "rejects invalid non-interactive --dsh-mode value %j",
    async (dshMode) => {
      const project = await createProject();
      await expect(
        runInstaller({
          argv: ["--mode", "review", `--dsh-mode=${dshMode}`],
          cwd: project,
          input: Readable.from([]),
          output: new OutputCapture(),
          isTTY: false,
          templateDirectory: join(builtPackage, "templates"),
        }),
      ).rejects.toThrow(/dsh-mode requires controlled or native|Invalid --dsh-mode value/u);
      await expect(workflow(project, "dsh-review.yml")).rejects.toThrow();
    },
  );

  it("fails immediately without --mode on non-TTY input and never reads stdin", async () => {
    let readAttempted = false;
    const input = new Readable({
      read() {
        readAttempted = true;
      },
    });

    await expect(
      runInstaller({
        argv: [],
        cwd: await createProject(),
        input,
        output: new OutputCapture(),
        isTTY: false,
        templateDirectory: join(builtPackage, "templates"),
      }),
    ).rejects.toThrow(/Non-interactive or CI input requires --mode/u);
    expect(readAttempted).toBe(false);
  });

  it("never prompts when CI is set even if stdin and stdout are TTYs", async () => {
    let readAttempted = false;
    const input = new Readable({
      read() {
        readAttempted = true;
      },
    });

    await expect(
      runInstaller({
        argv: [],
        cwd: await createProject(),
        input,
        output: new OutputCapture(),
        env: { CI: "1" },
        isTTY: true,
        templateDirectory: join(builtPackage, "templates"),
      }),
    ).rejects.toThrow(/Non-interactive or CI input requires --mode/u);
    expect(readAttempted).toBe(false);
  });

  it("exits in CI without waiting for an open stdin pipe", async () => {
    const child = spawn(process.execPath, [join(builtPackage, "cli.mjs")], {
      cwd: await createProject(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number | null>((resolveExit, rejectExit) => {
      const timeout = setTimeout(() => {
        child.kill();
        rejectExit(new Error("installer waited for stdin in non-interactive mode"));
      }, 2_000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        rejectExit(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolveExit(code);
      });
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("Non-interactive or CI input requires --mode");
  });
});

describe("generated workflow contracts", () => {
  it.each(["controlled", "native"] as const)(
    "generates %s YAML 1.2 documents that preserve the consumer safety constraints",
    async (dshMode) => {
      const { project } = await install("both", dshMode);
      const review = await workflow(project, "dsh-review.yml");
      const commands = await workflow(project, "dsh-commands.yml");

      expect(() => {
        parse(review);
      }).not.toThrow();
      expect(() => {
        parse(commands);
      }).not.toThrow();
      const reviewDocument = parse(review) as { permissions?: Record<string, string> };
      const commandsDocument = parse(commands) as { permissions?: Record<string, string> };

      expect(reviewDocument.permissions).toEqual({
        contents: "read",
        "pull-requests": "write",
      });
      expect(commandsDocument.permissions).toEqual({
        actions: "read",
        checks: "read",
        contents: "write",
        issues: "write",
        "pull-requests": "write",
      });

      expect(review).toContain("pull_request_target:");
      expect(review).not.toMatch(/^\s+pull_request:\s*$/mu);
      expect(review).toContain("contents: read");
      expect(review).not.toContain("contents: write");
      expect(review).toContain("pull-requests: write");
      expect(review).toContain("ref: ${{ github.event.pull_request.base.sha }}");
      expect(review).not.toContain("pull_request.head");
      expect(review).toContain("persist-credentials: false");
      expect(review).toContain('allow-write: "false"');
      expect(review).toContain("permission-profile: strict");
      expect(review).toContain("isolation: docker");

      for (const permission of [
        "actions: read",
        "checks: read",
        "contents: write",
        "issues: write",
        "pull-requests: write",
      ]) {
        expect(commands).toContain(permission);
      }
      expect(commands).toContain("ref: ${{ github.event.repository.default_branch }}");
      expect(commands).toContain("persist-credentials: false");
      expect(commands).toContain("permission-profile: standard");
      expect(commands).toContain("isolation: docker");
      expect(commands).toContain('allow-write: "true"');
      expect(commands).toContain('run-tests: "true"');
      expect(commands).toContain("validation-integrity: strict");
      expect(commands).toContain("process.exit(1)");
      expect(commands).toMatch(
        /^\s+container-image: docker\.io\/library\/node:24\.18\.0-bookworm@sha256:[0-9a-f]{64}$/mu,
      );

      for (const contents of [review, commands]) {
        expect(
          contents.match(new RegExp(`deepseek-harness-action@${RELEASE_SHA}`, "gu")),
        ).toHaveLength(1);
        expect(contents).not.toContain(RELEASE_TOKEN);
        expect(contents).not.toContain(DSH_MODE_TOKEN);
        expect(contents).not.toMatch(/deepseek-harness-action@(?:main|latest|v\d)/u);
        if (dshMode === "controlled") {
          expect(contents).not.toMatch(/^\s*dsh-mode:/mu);
        } else {
          expect(contents.match(/^\s*dsh-mode: native\s*$/gmu)).toHaveLength(1);
        }
        expect(contents).not.toContain("github-token:");
        expect(contents).not.toContain("id-token:");
        expect(contents).not.toContain("secrets: inherit");
        expect(contents).not.toContain("GITHUB_TOKEN");
        expect(contents).not.toContain("GH_TOKEN");
        expect(contents).not.toMatch(/^\s+env:\s*$/mu);
        expect(contents).toContain("deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}");
        expect(
          contents.match(/uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/gu),
        ).toHaveLength(1);
      }
    },
  );
});
