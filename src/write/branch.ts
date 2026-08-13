import { validateRefName } from "../security/refs.js";

function slug(value: string): string {
  const candidate = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
  return candidate || "task";
}

export function buildDshBranch(entityNumber: number, hint: string, runIdentity = "run"): string {
  if (!Number.isSafeInteger(entityNumber) || entityNumber < 1) {
    throw new Error("Entity number must be a positive integer");
  }
  return validateRefName(`dsh/${String(entityNumber)}-${slug(hint)}-${slug(runIdentity)}`);
}
