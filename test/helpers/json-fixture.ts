import { readFile } from "node:fs/promises";

function isFixtureObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fixtureObject(value: unknown): Record<string, unknown> {
  if (!isFixtureObject(value)) {
    throw new Error("Expected a fixture JSON object");
  }
  return value;
}

export function fixtureObjects(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a fixture JSON array");
  return value.map(fixtureObject);
}

export async function readJsonFixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function readFixtureManifest(path: string): Promise<Record<string, unknown>> {
  return fixtureObject(await readJsonFixture(path));
}
