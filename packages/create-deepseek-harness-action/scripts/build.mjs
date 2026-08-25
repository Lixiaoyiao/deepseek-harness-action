import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_TOKEN = "__DSH_ACTION_RELEASE_SHA__";
const DSH_MODE_TOKEN = "__DSH_MODE_INPUT__";
const DSH_MODE_ANCHOR = /^([ \t]*)# __DSH_MODE_INPUT__[ \t]*(\r?\n|$)/mu;
const ACTION_REFERENCE_PATTERN = /uses: Lixiaoyiao\/deepseek-harness-action@[0-9a-f]{40}(?:\s|$)/gu;
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function isStrictDescendant(parent, child) {
  const path = relative(parent, child);
  return (
    path !== "" &&
    path !== ".." &&
    !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
    !isAbsolute(path)
  );
}

function assertSafeOutputDirectory(destination) {
  const packageDist = join(packageRoot, "dist");
  const temporaryRoot = resolve(tmpdir());
  const protectedDirectories = new Set([
    packageRoot,
    resolve(process.cwd()),
    parse(destination).root,
    temporaryRoot,
  ]);
  if (protectedDirectories.has(destination)) {
    throw new Error(`Refusing unsafe build output directory: ${destination}`);
  }
  if (
    destination !== packageDist &&
    !isStrictDescendant(packageDist, destination) &&
    !isStrictDescendant(temporaryRoot, destination)
  ) {
    throw new Error("Build output must be the package dist directory or a specific temp child");
  }
}

function outputDirectory(argv) {
  if (argv.length === 0) return join(packageRoot, "dist");
  if (argv.length === 2 && argv[0] === "--output" && argv[1] !== undefined) {
    const destination = resolve(argv[1]);
    assertSafeOutputDirectory(destination);
    return destination;
  }
  throw new Error("Usage: node scripts/build.mjs [--output <directory>]");
}

const releaseSha = process.env.DSH_ACTION_RELEASE_SHA;
if (releaseSha === undefined || !/^[0-9a-f]{40}$/u.test(releaseSha)) {
  throw new Error("DSH_ACTION_RELEASE_SHA must be the real lowercase 40-character release SHA");
}

const destination = outputDirectory(process.argv.slice(2));
const runtimeFiles = ["cli.mjs", "installer.mjs"];
const sourceTemplateFiles = ["dsh-review.yml", "dsh-commands.yml"];
const runtime = new Map();
const templates = new Map();

function nativeTemplateName(sourceFile) {
  return sourceFile.replace(/\.yml$/u, "-native.yml");
}

function renderTemplate(source, sourceFile, dshMode) {
  const releaseOccurrences = source.split(RELEASE_TOKEN).length - 1;
  if (releaseOccurrences !== 1) {
    throw new Error(`Template ${sourceFile} must contain exactly one release placeholder`);
  }
  const modeOccurrences = source.split(DSH_MODE_TOKEN).length - 1;
  if (modeOccurrences !== 1 || !DSH_MODE_ANCHOR.test(source)) {
    throw new Error(`Template ${sourceFile} must contain exactly one DSH mode build anchor`);
  }

  const withRelease = source.replace(RELEASE_TOKEN, releaseSha);
  const built = withRelease.replace(DSH_MODE_ANCHOR, (_anchor, indentation, newline) =>
    dshMode === "native" ? `${indentation}dsh-mode: native${newline}` : "",
  );

  if (built.includes(RELEASE_TOKEN) || built.includes(DSH_MODE_TOKEN)) {
    throw new Error(`Template ${sourceFile} still contains a build placeholder after rendering`);
  }
  if ((built.match(ACTION_REFERENCE_PATTERN) ?? []).length !== 1) {
    throw new Error(`Template ${sourceFile} must contain exactly one immutable Action reference`);
  }
  const modeLines = built.match(/^\s*dsh-mode:\s*\S+\s*$/gmu) ?? [];
  if (dshMode === "controlled" && modeLines.length !== 0) {
    throw new Error(`Controlled template ${sourceFile} must not contain dsh-mode`);
  }
  if (
    dshMode === "native" &&
    (modeLines.length !== 1 || modeLines[0]?.trim() !== "dsh-mode: native")
  ) {
    throw new Error(
      `Native template ${sourceFile} must contain exactly one dsh-mode: native input`,
    );
  }
  return built;
}

for (const file of runtimeFiles) {
  const contents = await readFile(join(packageRoot, "src", file), "utf8");
  if (contents.includes(RELEASE_TOKEN) || contents.includes(DSH_MODE_TOKEN)) {
    throw new Error(`Runtime file ${file} must not contain a build placeholder`);
  }
  runtime.set(file, contents);
}

for (const file of sourceTemplateFiles) {
  const source = await readFile(join(packageRoot, "src", "templates", file), "utf8");
  templates.set(file, renderTemplate(source, file, "controlled"));
  templates.set(nativeTemplateName(file), renderTemplate(source, file, "native"));
}

await rm(destination, { force: true, recursive: true });
await mkdir(join(destination, "templates"), { recursive: true });
for (const [file, contents] of runtime) await writeFile(join(destination, file), contents, "utf8");
for (const [file, contents] of templates) {
  await writeFile(join(destination, "templates", file), contents, "utf8");
}
await chmod(join(destination, "cli.mjs"), 0o755);

for (const [file, contents] of [...runtime, ...templates]) {
  if (contents.includes(RELEASE_TOKEN) || contents.includes(DSH_MODE_TOKEN)) {
    throw new Error(`Refusing to publish build placeholder from ${file}`);
  }
}

process.stderr.write(`Built create-deepseek-harness-action for ${releaseSha}\n`);
