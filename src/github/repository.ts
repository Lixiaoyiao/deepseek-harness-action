import { mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import type { GitHubClient } from "./client.js";
import { validateCommitSha } from "../security/refs.js";

const MAX_FILES = 50_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MATERIALIZABLE_MODES = new Set(["100644", "100755"]);

interface MaterializableBlob {
  readonly path: string;
  readonly sha: string;
  readonly size: number;
  readonly mode: "100644" | "100755";
}

function safePath(path: string): string {
  if (
    path === "" ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe Git tree path: ${JSON.stringify(path)}`);
  }
  return path;
}

function strictBase64(value: string, path: string): Buffer {
  const normalized = value.replaceAll("\r", "").replaceAll("\n", "");
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
  ) {
    throw new Error(`GitHub blob is not valid base64: ${path}`);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.toString("base64") !== normalized) {
    throw new Error(`GitHub blob is not canonical base64: ${path}`);
  }
  return decoded;
}

function validateBlobs(
  entries: Awaited<ReturnType<GitHubClient["rest"]["git"]["getTree"]>>["data"]["tree"],
): readonly MaterializableBlob[] {
  const blobs: MaterializableBlob[] = [];
  const paths = new Set<string>();
  const blobPaths = new Set<string>();
  let bytes = 0;
  for (const entry of entries) {
    const path = safePath(entry.path);
    if (paths.has(path)) throw new Error(`Duplicate Git tree path: ${path}`);
    paths.add(path);
    validateCommitSha(entry.sha);
    if (entry.type === "tree") {
      if (entry.mode !== "040000") {
        throw new Error(`Unsupported Git tree mode for ${path}: ${entry.mode}`);
      }
      continue;
    }
    if (entry.type !== "blob") {
      throw new Error(`Unsupported Git tree entry for ${path}: ${entry.type}`);
    }
    if (!MATERIALIZABLE_MODES.has(entry.mode)) {
      throw new Error(`Unsupported Git blob mode for ${path}: ${entry.mode}`);
    }
    const size = entry.size;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`Invalid Git blob size for ${path}`);
    }
    bytes += size;
    if (!Number.isSafeInteger(bytes) || bytes > MAX_BYTES) {
      throw new Error("Repository exceeds materialization byte limit");
    }
    blobPaths.add(path);
    blobs.push({
      path,
      sha: validateCommitSha(entry.sha),
      size,
      mode: entry.mode as "100644" | "100755",
    });
  }
  if (blobs.length > MAX_FILES) throw new Error("Repository exceeds materialization file limit");
  for (const path of blobPaths) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      if (blobPaths.has(segments.slice(0, index).join("/"))) {
        throw new Error(`Git blob path conflicts with a parent file: ${path}`);
      }
    }
  }
  return blobs;
}

export interface MaterializedRepository {
  readonly root: string;
  readonly sha: string;
  readonly files: number;
  readonly bytes: number;
}

/** Materialize an immutable commit without checkout credentials, hooks or .git. */
export async function materializeRepositoryAtSha(
  client: GitHubClient,
  owner: string,
  repo: string,
  sha: string,
  root: string,
): Promise<MaterializedRepository> {
  const commitSha = validateCommitSha(sha);
  const commit = await client.rest.git.getCommit({ owner, repo, commit_sha: commitSha });
  const returnedCommitSha = validateCommitSha(commit.data.sha);
  if (returnedCommitSha !== commitSha) throw new Error("GitHub returned a different commit SHA");
  const treeSha = validateCommitSha(commit.data.tree.sha);
  const tree = await client.rest.git.getTree({
    owner,
    repo,
    tree_sha: treeSha,
    recursive: "true",
  });
  if (validateCommitSha(tree.data.sha) !== treeSha) {
    throw new Error("GitHub returned a different tree SHA");
  }
  if (tree.data.truncated) throw new Error("GitHub tree response was truncated");
  const blobs = validateBlobs(tree.data.tree);
  await mkdir(root, { recursive: true, mode: 0o700 });
  let bytes = 0;
  for (const entry of blobs) {
    const { path, size } = entry;
    bytes += size;
    const blob = await client.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
    if (validateCommitSha(blob.data.sha) !== entry.sha) {
      throw new Error(`GitHub returned a different blob SHA: ${path}`);
    }
    if (blob.data.encoding !== "base64") throw new Error(`Unsupported blob encoding: ${path}`);
    const content = strictBase64(blob.data.content, path);
    if (content.byteLength !== size) {
      throw new Error(`GitHub blob size changed while materializing: ${path}`);
    }
    const target = resolve(root, ...path.split("/"));
    const rootPath = resolve(root);
    if (target !== rootPath && !target.startsWith(rootPath + sep)) {
      throw new Error("Git tree path escaped materialization root");
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, { flag: "wx" });
    await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
  }
  return { root, sha: commitSha, files: blobs.length, bytes };
}
