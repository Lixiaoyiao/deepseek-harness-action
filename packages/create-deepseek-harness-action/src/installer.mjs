import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import { INSTALLER_ACTION_INPUTS } from "./action-inputs.generated.mjs";

const DOCUMENTATION_URL =
  "https://github.com/Lixiaoyiao/deepseek-harness-action/blob/create-deepseek-harness-action-v0.5.0/docs/setup.md";
const ACTION_REFERENCE_PATTERN = /uses: Lixiaoyiao\/deepseek-harness-action@[0-9a-f]{40}(?:\s|$)/gu;
const MODES = new Set(["review", "commands", "both", "session"]);
const DSH_MODES = new Set(["controlled", "native"]);
const DSH_MODE_INPUT_NAME = INSTALLER_ACTION_INPUTS.dshMode.name;
const DSH_MODE_OPTION = `--${DSH_MODE_INPUT_NAME}`;
const DEFAULT_DSH_MODE = INSTALLER_ACTION_INPUTS.dshMode.defaultValue;
// Match the fixed Action's Docker image grammar without a runtime dependency.
const IMAGE_PATH_COMPONENT_PATTERN = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const IMAGE_REGISTRY_DOMAIN_PATTERN =
  /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9])(?:\.(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]))*(?::[0-9]+)?$/u;
const IMAGE_TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u;
const IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
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
    session: Object.freeze({
      source: "dsh-session.yml",
      target: ".github/workflows/dsh-session.yml",
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
    session: Object.freeze({
      source: "dsh-session-native.yml",
      target: ".github/workflows/dsh-session.yml",
    }),
  }),
});

function usage() {
  return [
    "Usage: create-deepseek-harness-action [--mode review|commands|both|session] [--dsh-mode controlled|native]",
    "  [--test-commands '<JSON argv arrays>'] [--container-image '<name>@sha256:<digest>']",
    "",
    "Workflow choices:",
    "  1) PR Review",
    "  2) @dsh Coding Commands",
    "  3) Both",
    "  4) Automatic Session",
    "",
    "DSH mode choices:",
    "  1) Controlled (default for non-interactive use)",
    "  2) Native",
    "",
    "CI/non-interactive usage requires --mode; --dsh-mode defaults to controlled.",
    "Validation argv are explicitly maintainer-selected; the installer never reads or executes repository scripts.",
  ].join("\n");
}

function validContainerImageReference(containerImage, requireDigest) {
  if (
    containerImage.length === 0 ||
    containerImage.length > 512 ||
    containerImage.includes("://") ||
    containerImage.includes("//")
  ) {
    return false;
  }
  const digestParts = containerImage.split("@");
  if (digestParts.length > 2) return false;
  const nameAndTag = digestParts[0];
  const digest = digestParts[1];
  if (
    nameAndTag === undefined ||
    nameAndTag === "" ||
    (requireDigest && digest === undefined) ||
    (digest !== undefined && !IMAGE_DIGEST_PATTERN.test(digest))
  ) {
    return false;
  }

  const segments = nameAndTag.split("/");
  const finalSegment = segments.at(-1);
  if (finalSegment === undefined || finalSegment === "") return false;
  const tagSeparator = finalSegment.lastIndexOf(":");
  if (tagSeparator >= 0) {
    const tag = finalSegment.slice(tagSeparator + 1);
    const imageName = finalSegment.slice(0, tagSeparator);
    if (!IMAGE_TAG_PATTERN.test(tag) || !IMAGE_PATH_COMPONENT_PATTERN.test(imageName)) return false;
    segments[segments.length - 1] = imageName;
  }

  const first = segments[0];
  const explicitRegistry =
    segments.length > 1 &&
    first !== undefined &&
    (first.includes(".") ||
      first.includes(":") ||
      first === "localhost" ||
      first !== first.toLowerCase());
  if (explicitRegistry && !IMAGE_REGISTRY_DOMAIN_PATTERN.test(first)) return false;
  return segments
    .slice(explicitRegistry ? 1 : 0)
    .every((segment) => IMAGE_PATH_COMPONENT_PATTERN.test(segment));
}

export function parseArguments(argv) {
  let mode;
  let dshMode;
  let help = false;
  let testCommands;
  let containerImage;

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
    } else if (argument === "--test-commands" || argument === "--container-image") {
      option = argument.slice(2);
      value = argv[index + 1];
      index += 1;
    } else if (argument?.startsWith("--test-commands=")) {
      option = "test-commands";
      value = argument.slice("--test-commands=".length);
    } else if (argument?.startsWith("--container-image=")) {
      option = "container-image";
      value = argument.slice("--container-image=".length);
    } else {
      throw new Error(`Unknown argument: ${argument ?? ""}\n\n${usage()}`);
    }

    if (option === "mode") {
      if (mode !== undefined) throw new Error("--mode may be provided only once");
      if (value === undefined || value === "" || value.startsWith("--")) {
        throw new Error(`--mode requires review, commands, both, or session\n\n${usage()}`);
      }
      if (!MODES.has(value)) {
        throw new Error(`Invalid --mode value: ${value}\n\n${usage()}`);
      }
      mode = value;
      continue;
    }

    if (option === "test-commands") {
      if (testCommands !== undefined) throw new Error("--test-commands may be provided only once");
      testCommands = parseValidationCommands(value);
      continue;
    }
    if (option === "container-image") {
      if (containerImage !== undefined)
        throw new Error("--container-image may be provided only once");
      if (typeof value !== "string" || !validContainerImageReference(value, true)) {
        throw new Error(
          "--container-image requires one name@sha256:<64 lowercase hex> image reference",
        );
      }
      containerImage = value;
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

  if (
    (mode === "review" || mode === "session") &&
    (testCommands !== undefined || containerImage !== undefined)
  ) {
    throw new Error(
      "--test-commands/--container-image are for commands or both; review and session need no write setup",
    );
  }
  return {
    help,
    mode,
    dshMode,
    ...(testCommands === undefined ? {} : { testCommands }),
    ...(containerImage === undefined ? {} : { containerImage }),
  };
}

function parseValidationCommands(value) {
  let commands;
  try {
    if (typeof value !== "string" || value.length > 64 * 1024) throw new Error();
    commands = JSON.parse(value);
  } catch {
    throw new Error("--test-commands requires a JSON array of non-empty argv arrays");
  }
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.length > 32 ||
    commands.some(
      (argv) =>
        !Array.isArray(argv) ||
        argv.length === 0 ||
        argv.length > 64 ||
        argv.some(
          (argument) =>
            typeof argument !== "string" ||
            argument.length === 0 ||
            argument.length > 4096 ||
            argument.includes("\0") ||
            argument.includes("${{") ||
            /REPLACE_WITH_|REQUIRED: replace test-commands/iu.test(argument),
        ),
    )
  ) {
    throw new Error(
      "--test-commands must contain 1-32 explicit argv arrays without placeholders, NUL or workflow expressions",
    );
  }
  return commands;
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
          "  4) Automatic Session\n",
          "Selection [1-4]: ",
        ].join(""),
      )
    )
      .trim()
      .toLowerCase();

    if (answer === "1" || answer === "review") return "review";
    if (answer === "2" || answer === "commands") return "commands";
    if (answer === "3" || answer === "both") return "both";
    if (answer === "4" || answer === "session") return "session";
    output.write("Please enter 1, 2, 3, or 4.\n");
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
  if (mode === "session") return [workflows.session];
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

async function installWorkflows({
  cwd,
  mode,
  dshMode,
  templateDirectory,
  testCommands,
  containerImage,
}) {
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
    let contents = await readFile(join(templateDirectory, definition.source), "utf8");
    assertReleaseBuiltTemplate(contents, definition.source);
    if (definition.target.endsWith("dsh-commands.yml")) {
      if (testCommands !== undefined) {
        contents = contents.replace(
          /^([ \t]*)test-commands: >-\r?\n[ \t]*\[.*\]\r?$/mu,
          (_source, indentation) =>
            `${indentation}test-commands: ${JSON.stringify(JSON.stringify(testCommands))}`,
        );
        if (contents.includes("REQUIRED: replace test-commands")) {
          throw new Error("Installer command template has no supported validation placeholder");
        }
      }
      if (containerImage !== undefined) {
        const imageInputs = [...contents.matchAll(/^([ \t]*)container-image: .+$/gmu)];
        if (imageInputs.length !== 1) {
          throw new Error(
            `Installer command template ${definition.source} must contain exactly one container-image Action input; found ${String(imageInputs.length)} matching lines`,
          );
        }
        const actionInputs =
          /^([ \t]*)- uses: Lixiaoyiao\/deepseek-harness-action@[0-9a-f]{40}[ \t]*\r?\n\1 {2}with:[ \t]*\r?\n((?:\1 {4}.*(?:\r?\n|$))+)/mu.exec(
            contents,
          );
        const imageInput = imageInputs[0];
        if (
          actionInputs === null ||
          imageInput?.[1] !== `${actionInputs[1]}    ` ||
          !actionInputs[2]?.includes(imageInput[0])
        ) {
          throw new Error(
            `Installer command template ${definition.source} container-image must be a direct input of the pinned Action step`,
          );
        }
        contents = contents.replace(
          /^([ \t]*)container-image: .+$/mu,
          (_source, indentation) => `${indentation}container-image: ${containerImage}`,
        );
      }
    }
    definition.contents = contents;
  }

  await mkdir(join(cwd, ".github", "workflows"), { recursive: true });
  const created = [];
  try {
    for (const definition of definitions) {
      await writeFile(definition.absoluteTarget, definition.contents, {
        encoding: "utf8",
        flag: "wx",
      });
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

function printSuccess(output, mode, dshMode, createdFiles, testCommands) {
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
        testCommands === undefined
          ? "  Replace the fail-closed test-commands placeholder with your repository's commands."
          : "  Explicit validation argv were written; review their trusted source before enabling coding writes.",
        "  Replace the digest-pinned container-image too if validation needs another toolchain.",
        "  No repository scripts were discovered, executed, or automatically trusted.",
        "  run-tests=true, successful validation and fresh Controller authorization remain mandatory.",
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
  if (mode === "session") {
    output.write(
      "  Session: commit this workflow to the default branch, then dispatch there with a lowercase session_key and a new prompt.\n",
    );
    output.write(
      "  Reuse that key to continue automatically; no source run ID is needed. Failed, expired or unknown history requires maintainer reconciliation.\n",
    );
  }
  output.write(`\nDocumentation: ${DOCUMENTATION_URL}\n`);
  output.write(
    "\nNot checked: credential validity/token scopes/quota, Docker daemon/image, repository validation commands, actor/event/SHA authority. These are checked at execution.\n",
  );
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

  if (
    mode === "review" &&
    (parsed.testCommands !== undefined || parsed.containerImage !== undefined)
  ) {
    throw new Error("--test-commands/--container-image require commands or both");
  }
  const createdFiles = await installWorkflows({
    cwd,
    mode,
    dshMode,
    templateDirectory,
    testCommands: parsed.testCommands,
    containerImage: parsed.containerImage,
  });
  printSuccess(output, mode, dshMode, createdFiles, parsed.testCommands);
  return { mode, dshMode, createdFiles };
}
