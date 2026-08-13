/*
 * Adapted from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

function isWithin(root: string, candidate: string): boolean {
  const segment = relative(root, candidate);
  return segment === "" || (!segment.startsWith("..") && !isAbsolute(segment));
}

/** Resolve an existing path, or the nearest existing ancestor, and reject symlink escapes. */
export async function assertPathWithin(rootPath: string, candidatePath: string): Promise<string> {
  const root = await realpath(rootPath).catch(() => {
    throw new Error(`Repository root does not exist: ${rootPath}`);
  });
  const candidate = resolve(root, candidatePath);
  if (!isWithin(root, candidate)) throw new Error("Path resolves outside repository root");

  let ancestor = candidate;
  for (;;) {
    try {
      await lstat(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("No existing ancestor for path");
      ancestor = parent;
    }
  }
  const realAncestor = await realpath(ancestor);
  if (!isWithin(root, realAncestor)) throw new Error("Path escapes repository root via symlink");
  const suffix = relative(ancestor, candidate);
  return resolve(realAncestor, suffix);
}
