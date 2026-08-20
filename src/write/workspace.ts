import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { assertPathWithin } from "../security/paths.js";
import { requireGitSuccess } from "./git.js";

const MAX_SNAPSHOT_FILES = 50_000;
const MAX_SNAPSHOT_BYTES = 1024 * 1024 * 1024;
const IGNORED_GENERATED_DIRECTORIES = new Set([".git", "node_modules"]);

export function isIgnoredGeneratedRootEntry(name: string): boolean {
  return IGNORED_GENERATED_DIRECTORIES.has(name);
}

interface FileState {
  readonly kind: "file";
  readonly digest: string;
  readonly mode: number;
}

export interface WorkspaceSnapshot {
  readonly sourceRoot: string;
  readonly workerRoot: string;
  readonly baseline: ReadonlyMap<string, FileState>;
}

export interface WorkspaceChanges {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly all: readonly string[];
}

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe repository path: ${JSON.stringify(value)}`);
  }
  return normalized;
}

async function stateFor(path: string): Promise<FileState> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`Symbolic links are not allowed: ${path}`);
  if (!metadata.isFile()) throw new Error(`Unsupported repository entry type: ${path}`);
  return { kind: "file", digest: hash(await readFile(path)), mode: metadata.mode & 0o777 };
}

async function copyEntry(source: string, destination: string, state: FileState): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, state.mode);
}

/** Reject every symbolic-link component before path containment resolves it. */
async function assertNoSymlinkComponents(root: string, path: string): Promise<string> {
  let candidate = resolve(root);
  for (const segment of path.split("/")) {
    candidate = join(candidate, segment);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed: ${candidate}`);
    }
  }
  return candidate;
}

async function trackedPaths(root: string): Promise<readonly string[]> {
  const result = await requireGitSuccess(["ls-files", "-z", "--cached"], {
    cwd: root,
    maxOutputBytes: 32 * 1024 * 1024,
  });
  const paths = result.stdout.split("\0").filter(Boolean).map(normalizeRelativePath);
  if (paths.length > MAX_SNAPSHOT_FILES) throw new Error("Repository exceeds snapshot file limit");
  return paths;
}

async function repositoryPaths(root: string): Promise<readonly string[]> {
  try {
    return await trackedPaths(root);
  } catch {
    const result: string[] = [];
    const pending = [""];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const absolute = current === "" ? root : join(root, ...current.split("/"));
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (current === "" && isIgnoredGeneratedRootEntry(entry.name)) continue;
        const path = normalizeRelativePath(
          current === "" ? entry.name : `${current}/${entry.name}`,
        );
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() || entry.isSymbolicLink()) result.push(path);
        else throw new Error(`Unsupported repository entry type: ${path}`);
      }
    }
    return result.sort((left, right) => left.localeCompare(right));
  }
}

/**
 * Copies only tracked files into a .git-less worker directory. DSH and tests
 * operate on this copy, never on the token-bearing controller checkout.
 */
export async function createWorkspaceSnapshot(
  sourceRoot: string,
  workerRoot: string,
): Promise<WorkspaceSnapshot> {
  await mkdir(workerRoot, { recursive: true, mode: 0o700 });
  const baseline = new Map<string, FileState>();
  let bytes = 0;
  for (const path of await repositoryPaths(sourceRoot)) {
    // Check the lexical path before assertPathWithin resolves it. Otherwise a
    // repository symlink to an in-root file is silently converted to its
    // target and copied as a regular file on Linux.
    const lexicalSource = await assertNoSymlinkComponents(sourceRoot, path);
    const source = await assertPathWithin(sourceRoot, path);
    if (resolve(source) !== resolve(lexicalSource)) {
      throw new Error(`Repository path changed while validating: ${path}`);
    }
    const metadata = await lstat(source);
    bytes += metadata.size;
    if (bytes > MAX_SNAPSHOT_BYTES) throw new Error("Repository exceeds snapshot byte limit");
    const state = await stateFor(source);
    baseline.set(path, state);
    const destination = resolve(workerRoot, ...path.split("/"));
    if (!destination.startsWith(resolve(workerRoot) + sep))
      throw new Error("Snapshot path escaped root");
    await copyEntry(source, destination, state);
  }
  return { sourceRoot, workerRoot, baseline };
}

async function walkFiles(root: string, directory = ""): Promise<Map<string, FileState>> {
  const result = new Map<string, FileState>();
  const pending = [directory];
  let totalFiles = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const absolute = current === "" ? root : join(root, ...current.split("/"));
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name === "." || entry.name === "..") throw new Error("Invalid directory entry");
      if (current === "" && isIgnoredGeneratedRootEntry(entry.name)) continue;
      const path = normalizeRelativePath(current === "" ? entry.name : `${current}/${entry.name}`);
      const candidate = join(root, ...path.split("/"));
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) {
        throw new Error(`DSH created unsupported entry type: ${path}`);
      }
      totalFiles += 1;
      if (totalFiles > MAX_SNAPSHOT_FILES) throw new Error("Worker output exceeds file limit");
      const metadata = await lstat(candidate);
      totalBytes += metadata.size;
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error("Worker output exceeds byte limit");
      result.set(path, await stateFor(candidate));
    }
  }
  return result;
}

export async function inspectWorkspaceChanges(
  snapshot: WorkspaceSnapshot,
): Promise<WorkspaceChanges> {
  const current = await walkFiles(snapshot.workerRoot);
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [path, state] of current) {
    const previous = snapshot.baseline.get(path);
    if (previous === undefined) added.push(path);
    else if (previous.digest !== state.digest || previous.mode !== state.mode) {
      modified.push(path);
    }
  }
  for (const path of snapshot.baseline.keys()) {
    if (!current.has(path)) deleted.push(path);
  }
  const sort = (values: string[]) => values.sort((left, right) => left.localeCompare(right));
  return {
    added: sort(added),
    modified: sort(modified),
    deleted: sort(deleted),
    all: sort([...added, ...modified, ...deleted]),
  };
}

/** Stable content revision used to distinguish repair progress from a retry loop. */
export async function fingerprintWorkspace(root: string): Promise<string> {
  const current = await walkFiles(root);
  const digest = createHash("sha256");
  for (const [path, state] of [...current.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    digest.update(path, "utf8");
    digest.update("\0", "utf8");
    digest.update(state.digest, "utf8");
    digest.update("\0", "utf8");
    digest.update(String(state.mode), "utf8");
    digest.update("\0", "utf8");
  }
  return digest.digest("hex");
}

/** Apply an already inspected change set to the real checkout. */
export async function applyWorkspaceChanges(
  snapshot: WorkspaceSnapshot,
  changes: WorkspaceChanges,
): Promise<void> {
  for (const path of changes.deleted) {
    const target = await assertPathWithin(snapshot.sourceRoot, path);
    await rm(target, { force: false });
  }
  for (const path of [...changes.added, ...changes.modified]) {
    const source = await assertPathWithin(snapshot.workerRoot, path);
    const state = await stateFor(source);
    const target = resolve(snapshot.sourceRoot, ...path.split("/"));
    const parentRelative = relative(snapshot.sourceRoot, dirname(target));
    await mkdir(resolve(snapshot.sourceRoot, parentRelative), { recursive: true });
    await assertPathWithin(snapshot.sourceRoot, parentRelative === "" ? "." : parentRelative);
    await copyFile(source, target);
    await chmod(target, state.mode);
  }
}
