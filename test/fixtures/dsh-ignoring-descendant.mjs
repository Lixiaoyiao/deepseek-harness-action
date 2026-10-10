import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

function stayAlive() {
  setTimeout(stayAlive, 1_000);
}

if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => undefined);
  stayAlive();
  process.send("ready");
} else {
  process.on("SIGTERM", () => process.exit(0));
  const descendant = spawn(process.execPath, [fileURLToPath(import.meta.url), "descendant"], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  descendant.once("message", () => {
    writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid }));
    descendant.disconnect();
  });
  stayAlive();
}
