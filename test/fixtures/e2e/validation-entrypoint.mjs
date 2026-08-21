import { writeFile } from "node:fs/promises";

await writeFile(new URL(import.meta.url), "process.exit(0);\n", "utf8");
process.stdout.write("DSH_INTEGRITY_FIXTURE_PREPARED\n");
