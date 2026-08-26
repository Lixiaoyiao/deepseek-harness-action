import { constants as fileConstants } from "node:fs";
import { access, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { INSTALLER_ACTION_INPUTS } from "./action-inputs.generated.mjs";

const DOCUMENTATION_URL =
  "https://github.com/Lixiaoyiao/deepseek-harness-action/blob/v0.8.0/docs/setup.md";
const ACTION_REFERENCE_PATTERN = /uses: Lixiaoyiao\/deepseek-harness-action@[0-9a-f]{40}(?:\s|$)/gu;
const MODES = new Set(["review", "commands", "both"]);
const DSH_MODES = new Set(["controlled", "native"]);
const DSH_MODE_INPUT_NAME = INSTALLER_ACTION_INPUTS.dshMode.name;
const DSH_MODE_OPTION = `--${DSH_MODE_INPUT_NAME}`;
const DEFAULT_DSH_MODE = INSTALLER_ACTION_INPUTS.dshMode.defaultValue;
const WORKFLOWS = Object.freeze({
  controlled: Object.freeze({
    review: Object.freeze({
      source: "dsh-review.yml",
      target: ".github/workflows/dsh-review.yml",
    }),
    commands: Object.freeze({
      source: "dsh-commands.yml",
      target: ".github/workflows/dsh-commands.yml",
    }),
  }),
  native: Object.freeze({
    review: Object.freeze({
      source: "dsh-review-native.yml",
      target: ".github/workflows/dsh-review.yml",
    }),
    commands: Object.freeze({
      source: "dsh-commands-native.yml",
      target: ".github/workflows/dsh-commands.yml",
    }),
  }),
});

function usage() {
  return [
    "Usage: create-deepseek-harness-action [--mode review|commands|both] [--dsh-mode controlled|native]",
    "",
    "Workflow choices:",
    "  1) PR Review",
    "  2) @dsh Coding Commands",
    "  3) Both",
    "",
    "DSH mode choices:",
    "  1) Controlled (default for non-interactive use)",
    "  2) Native",
    "",
    "CI/non-interactive usage requires --mode; --dsh-mode defaults to controlled.",
  ].join("\n");
}

export function parseArguments(argv) {
  let mode;
  let dshMode;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    let option;
    let value;
    if (argument === "--mode") {
      option = "mode";
      value = argv[index + 1];
      index += 1;
    } else if (argument?.startsWith("--mode=")) {
      option = "mode";
      value = argument.slice("--mode=".length);
    } else if (argument === DSH_MODE_OPTION) {
      option = DSH_MODE_INPUT_NAME;
      value = argv[index + 1];
      index += 1;
    } else if (argument?.startsWith(`${DSH_MODE_OPTION}=`)) {
      option = DSH_MODE_INPUT_NAME;
      value = argument.slice(`${DSH_MODE_OPTION}=`.length);
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage()}`);
    }

    if (option === "mode") {
      if (mode !== undefined) throw new Error("--mode may be provided only once");
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`--mode requires review, commands, or both\n\n${usage()}`);
      }
      if (!MODES.has(value)) {
        throw new Error(`Invalid --mode value: ${value}\n\n${usage()}`);
      }
      mode = value;
      continue;
    }

    if (dshMode !== undefined) throw new Error(`${DSH_MODE_OPTION} may be provided only once`);
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new Error(`${DSH_MODE_OPTION} requires controlled or native\n\n${usage()}`);
    }
    if (!DSH_MODES.has(value)) {
      throw new Error(`Invalid ${DSH_MODE_OPTION} value: ${value}\n\n${usage()}`);
    }
    dshMode = value;
  }

  return { help, mode, dshMode };
}

async function promptForMode(readline, output) {
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
}

async function promptForDshMode(readline, output) {
  while (true) {
    const answer = (
      await readline.question(
        ["Choose the DSH mode:\n", "  1) Controlled\n", "  2) Native\n", "Selection [1-2]: "].join(
          "",
        ),
      )
    )
      .trim()
      .toLowerCase();

    if (answer === "1" || answer === "controlled") return "controlled";
    if (answer === "2" || answer === "native") return "native";
    output.write("Please enter 1 or 2.\n");
  }
}

async function promptForMissingSelections({ input, output, mode, dshMode }) {
  const readline = createInterface({ input, output, terminal: false });
  const answers = readline[Symbol.asyncIterator]();
  const prompt = {
    async question(message) {
      output.write(message);
      const answer = await answers.next();
      if (answer.done) {
        throw new Error("Interactive input ended before all installer choices were selected");
      }
      return answer.value;
    },
  };
  try {
    return {
      mode: mode ?? (await promptForMode(prompt, output)),
      dshMode: dshMode ?? (await promptForDshMode(prompt, output)),
    };
  } finally {
    readline.close();
  }
}

function workflowDefinitions(mode, dshMode) {
  const workflows = WORKFLOWS[dshMode];
  if (mode === "review") return [workflows.review];
  if (mode === "commands") return [workflows.commands];
  return [workflows.review, workflows.commands];
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

async function installWorkflows({ cwd, mode, dshMode, templateDirectory }) {
  const definitions = workflowDefinitions(mode, dshMode).map((definition) => ({
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

function printSuccess(output, mode, dshMode, createdFiles) {
  output.write("\nCreated workflow files:\n");
  for (const path of createdFiles) output.write(`  - ${path}\n`);
  output.write(`\nDSH mode: ${dshMode}\n`);

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
    return { dshMode: parsed.dshMode ?? DEFAULT_DSH_MODE, createdFiles: [] };
  }

  let mode = parsed.mode;
  let dshMode = parsed.dshMode;
  const interactive = isTTY && !environment.CI;
  if (mode === undefined) {
    if (!interactive) {
      throw new Error(
        `Non-interactive or CI input requires --mode review|commands|both\n\n${usage()}`,
      );
    }
  }

  if (interactive && (mode === undefined || dshMode === undefined)) {
    ({ mode, dshMode } = await promptForMissingSelections({ input, output, mode, dshMode }));
  }
  dshMode ??= DEFAULT_DSH_MODE;

  const createdFiles = await installWorkflows({ cwd, mode, dshMode, templateDirectory });
  printSuccess(output, mode, dshMode, createdFiles);
  return { mode, dshMode, createdFiles };
}
