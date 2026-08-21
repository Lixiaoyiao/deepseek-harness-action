import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.version !== "0.5.0") {
  throw new Error(`Expected the v0.5.0 release candidate, received ${String(manifest.version)}`);
}

process.stdout.write("DSH_V050_VALIDATION_ENTRYPOINT_OK\n");
