#!/usr/bin/env node

import { runInstaller } from "./installer.mjs";

try {
  await runInstaller();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
