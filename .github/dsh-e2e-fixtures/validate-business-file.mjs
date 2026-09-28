import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [path, expected, ...extra] = process.argv.slice(2);
const fixed = /^\.github\/dsh-e2e-fixtures\/checks-([1-9][0-9]*)-([1-9][0-9]*)\.txt$/u.exec(
  path ?? "",
);
const implemented = /^dsh-e2e-implementation-([1-9][0-9]*)-([1-9][0-9]*)\.txt$/u.exec(path ?? "");
const identity = fixed ?? implemented;
if (identity === null || extra.length !== 0)
  throw new Error("Expected one run-scoped business fixture path");
assert.equal(expected, `DSH E2E ${fixed ? "fixed" : "implemented"} ${identity[1]}/${identity[2]}`);
assert.equal(readFileSync(path, "utf8"), `${expected}\n`);
