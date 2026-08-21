import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
const distDirectory = join(projectRoot, "dist");
const sourceMaps = (await readdir(distDirectory, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".js.map"))
  .map((entry) => entry.name)
  .sort();

if (sourceMaps.length === 0) {
  throw new Error("No NCC source maps found in dist; run npm run build first");
}

function packagePathFromSource(source) {
  const segments = source.replaceAll("\\", "/").split("/");
  const firstNodeModules = segments.indexOf("node_modules");
  const lastNodeModules = segments.lastIndexOf("node_modules");
  if (firstNodeModules === -1) return undefined;

  const packageNameStart = lastNodeModules + 1;
  const packageNameLength = segments[packageNameStart]?.startsWith("@") ? 2 : 1;
  const packageNameEnd = packageNameStart + packageNameLength;
  if (
    packageNameEnd > segments.length ||
    segments.slice(packageNameStart, packageNameEnd).some((part) => part === "")
  ) {
    throw new Error(`Cannot identify bundled package from source map entry: ${source}`);
  }
  return segments.slice(firstNodeModules, packageNameEnd).join("/");
}

const bundledPackagePaths = new Set();
for (const sourceMap of sourceMaps) {
  const parsed = JSON.parse(await readFile(join(distDirectory, sourceMap), "utf8"));
  if (!Array.isArray(parsed.sources)) {
    throw new Error(`${sourceMap} has no sources array`);
  }
  for (const source of parsed.sources) {
    if (typeof source !== "string") {
      throw new Error(`${sourceMap} contains a non-string source entry`);
    }
    const packagePath = packagePathFromSource(source);
    if (packagePath !== undefined) bundledPackagePaths.add(packagePath);
  }
}

const entries = [];

for (const packagePath of bundledPackagePaths) {
  const metadata = lock.packages?.[packagePath];
  if (metadata === undefined) {
    throw new Error(`Bundled package is absent from package-lock.json: ${packagePath}`);
  }
  const manifestPath = join(projectRoot, packagePath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (metadata.version !== manifest.version) {
    throw new Error(
      `Bundled package lock mismatch for ${manifest.name}: ${metadata.version ?? "unknown"} != ${manifest.version}`,
    );
  }
  const directory = dirname(manifestPath);
  let licenseText;
  for (const candidate of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "license.md"]) {
    try {
      licenseText = await readFile(join(directory, candidate), "utf8");
      break;
    } catch {
      // Try the next conventional license filename.
    }
  }
  if (licenseText === undefined) {
    throw new Error(`No license file found for ${manifest.name}@${manifest.version}`);
  }
  entries.push({
    name: manifest.name,
    version: manifest.version,
    repository:
      typeof manifest.repository === "string"
        ? manifest.repository
        : (manifest.repository?.url ?? manifest.homepage ?? ""),
    license: manifest.license,
    licenseText: licenseText.trim(),
  });
}

entries.sort((left, right) =>
  `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
);

const output = [
  "# Bundled dependency notices",
  "",
  "The Marketplace `dist/` bundle statically includes the dependency modules",
  "reported by the committed NCC source maps. The corresponding notices follow.",
  "",
  "DeepSeek Harness and its official MCP/Profile runtime packages are installed",
  "from `package-lock.json` inside the Controller-created Docker runtime. They are",
  "not statically copied into `dist/` and are intentionally excluded here.",
  "",
  ...entries.flatMap((entry) => [
    `## ${entry.name}@${entry.version}`,
    "",
    `License: ${entry.license}`,
    ...(entry.repository === "" ? [] : [`Source: ${entry.repository}`]),
    "",
    "```text",
    entry.licenseText.replaceAll("```", "` ` `"),
    "```",
    "",
  ]),
].join("\n");

await writeFile(join(projectRoot, "BUNDLED_DEPENDENCIES.md"), output, "utf8");
