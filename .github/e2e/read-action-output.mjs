import { readFile } from "node:fs/promises";

const [path, key] = process.argv.slice(2);
if (!path || !key || /[\r\n=]/u.test(key)) {
  throw new Error("usage: read-action-output.mjs <GITHUB_OUTPUT path> <key>");
}

const lines = (await readFile(path, "utf8")).replaceAll("\r\n", "\n").split("\n");
let value;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index] ?? "";
  if (line.startsWith(`${key}=`)) {
    value = line.slice(key.length + 1);
    continue;
  }
  if (!line.startsWith(`${key}<<`)) continue;
  const delimiter = line.slice(key.length + 2);
  const chunks = [];
  index += 1;
  while (index < lines.length && lines[index] !== delimiter) {
    chunks.push(lines[index] ?? "");
    index += 1;
  }
  if (index >= lines.length) throw new Error(`unterminated output value for ${key}`);
  value = chunks.join("\n");
}

if (value === undefined) throw new Error(`missing action output: ${key}`);
process.stdout.write(value);
