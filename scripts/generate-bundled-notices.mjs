import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
const entries = [];

for (const [packagePath, metadata] of Object.entries(lock.packages)) {
  if (packagePath === "" || metadata.dev === true) continue;
  const manifestPath = join(projectRoot, packagePath, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
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
  "The Marketplace `dist/` bundle includes code from the production dependency",
  "closure locked in `package-lock.json`. The corresponding notices follow.",
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
