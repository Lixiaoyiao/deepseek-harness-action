import { constants as fileConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const DOCUMENTATION_URL =
  "https://github.com/Lixiaoyiao/deepseek-harness-action/blob/v0.6.0/docs/setup.md";
const ACTION_REFERENCE_PATTERN = /uses: Lixiaoyiao\/deepseek-harness-action@[0-9a-f]{40}(?:\s|$)/gu;
const MODES = new Set(["review", "commands", "both"]);
const WORKFLOWS = Object.freeze({
  review: Object.freeze({
    source: "dsh-review.yml",
    target: ".github/workflows/dsh-review.yml",
  }),
  commands: Object.freeze({
    source: "dsh-commands.yml",
    target: ".github/workflows/dsh-commands.yml",
  }),
});

function usage() {
  return [
    "Usage: create-deepseek-harness-action [--mode review|commands|both]",
    "",
    "Interactive choices:",
    "  1) PR Review",
    "  2) @dsh Coding Commands",
    "  3) Both",
    "",
    "CI/non-interactive usage requires --mode.",
  ].join("\n");
}

export function parseArguments(argv) {
  let mode;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    let value;
    if (argument === "--mode") {
      value = argv[index + 1];
      index += 1;
    } else if (argument?.startsWith("--mode=")) {
      value = argument.slice("--mode=".length);
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage()}`);
    }

    if (mode !== undefined) throw new Error("--mode may be provided only once");
    if (value === undefined || value === "") {
      throw new Error(`--mode requires review, commands, or both\n\n${usage()}`);
    }
    if (!MODES.has(value)) {
      throw new Error(`Invalid --mode value: ${value}\n\n${usage()}`);
    }
    mode = value;
  }

  return { help, mode };
}

async function promptForMode(input, output) {
  const readline = createInterface({ input, output, terminal: false });
  try {
    while (true) {
      const answer = (
        await readline.question(
          [
            "Choose what to install:\n",
            "  1) PR Review\n",
            "  2) @dsh Coding Commands\n",
            "  3) Both\n",
            "Selection [1-3]: ",
          ].join(""),
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "1" || answer === "review") return "review";
      if (answer === "2" || answer === "commands") return "commands";
      if (answer === "3" || answer === "both") return "both";
      output.write("Please enter 1, 2, or 3.\n");
    }
  } finally {
    readline.close();
  }
}

function workflowDefinitions(mode) {
  if (mode === "review") return [WORKFLOWS.review];
  if (mode === "commands") return [WORKFLOWS.commands];
  return [WORKFLOWS.review, WORKFLOWS.commands];
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function assertReleaseBuiltTemplate(contents, source) {
  const matches = contents.match(ACTION_REFERENCE_PATTERN) ?? [];
  if (matches.length !== 1) {
    throw new Error(
      `Installer template ${source} is not bound to exactly one immutable Action release SHA`,
    );
  }
}

async function installWorkflows({ cwd, mode, templateDirectory }) {
  const definitions = workflowDefinitions(mode).map((definition) => ({
    ...definition,
    absoluteTarget: join(cwd, ...definition.target.split("/")),
  }));

  const conflicts = [];
  for (const definition of definitions) {
    if (await pathExists(definition.absoluteTarget)) conflicts.push(definition.target);
  }
  if (conflicts.length > 0) {
    throw new Error(
      `Refusing to overwrite existing workflow${conflicts.length === 1 ? "" : "s"}:\n${conflicts
        .map((path) => `  - ${path}`)
        .join("\n")}`,
    );
  }

  for (const definition of definitions) {
    const contents = await readFile(join(templateDirectory, definition.source), "utf8");
    assertReleaseBuiltTemplate(contents, definition.source);
  }

  await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
  const created = [];
  try {
    for (const definition of definitions) {
      await copyFile(
        join(templateDirectory, definition.source),
        definition.absoluteTarget,
        fileConstants.COPYFILE_EXCL,
      );
      created.push(definition);
    }
  } catch (error) {
    await Promise.all(created.map(({ absoluteTarget }) => rm(absoluteTarget, { force: true })));
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("A target workflow appeared during installation; no files were overwritten", {
        cause: error,
      });
    }
    throw error;
  }

  return created.map(({ target }) => target);
}

function printSuccess(output, mode, createdFiles) {
  output.write("\nCreated workflow files:\n");
  for (const path of createdFiles) output.write(`  - ${path}\n`);

  output.write(
    [
      "",
      "Required secret:",
      "  Add DEEPSEEK_API_KEY under Settings > Secrets and variables > Actions.",
    ].join("\n"),
  );
  output.write("\n");

  if (mode === "commands" || mode === "both") {
    output.write(
      [
        "",
        "Required before coding writes:",
        "  Replace the fail-closed test-commands placeholder with your repository's commands.",
        "  Replace the digest-pinned container-image too if validation needs another toolchain.",
      ].join("\n"),
    );
    output.write("\n");
  }

  output.write("\nHow to trigger:\n");
  if (mode === "review" || mode === "both") {
    output.write("  Review: open or update a non-draft pull request.\n");
  }
  if (mode === "commands" || mode === "both") {
    output.write("  @dsh: start an Issue or pull request comment with an @dsh command.\n");
  }
  output.write(`\nDocumentation: ${DOCUMENTATION_URL}\n`);
}

export async function runInstaller(options = {}) {
  const argv = options.argv ?? process.argv.slice(2);
  const cwd = resolve(options.cwd ?? process.cwd());
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const environment = options.env ?? process.env;
  const isTTY = options.isTTY ?? Boolean(input.isTTY && output.isTTY);
  const templateDirectory =
    options.templateDirectory ?? fileURLToPath(new URL("./templates/", import.meta.url));
  const parsed = parseArguments(argv);

  if (parsed.help) {
    output.write(`${usage()}\n`);
    return { createdFiles: [] };
  }

  let mode = parsed.mode;
  if (mode === undefined) {
    if (!isTTY || Boolean(environment.CI)) {
      throw new Error(
        `Non-interactive or CI input requires --mode review|commands|both\n\n${usage()}`,
      );
    }
    mode = await promptForMode(input, output);
  }

  const createdFiles = await installWorkflows({ cwd, mode, templateDirectory });
  printSuccess(output, mode, createdFiles);
  return { mode, createdFiles };
}
