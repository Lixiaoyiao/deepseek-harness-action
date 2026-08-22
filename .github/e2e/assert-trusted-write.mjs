import { readFile } from "node:fs/promises";

const [path, ...extra] = process.argv.slice(2);
if (
  path === undefined ||
  extra.length !== 0 ||
  !/^dsh-e2e-write-[1-9][0-9]*-[1-9][0-9]*\.txt$/u.test(path)
) {
  throw new Error("Expected one run-scoped trusted-write marker path");
}

const content = await readFile(path, "utf8");
if (content !== "trusted-write\n") {
  throw new Error("Trusted-write marker content did not match the golden value");
}
