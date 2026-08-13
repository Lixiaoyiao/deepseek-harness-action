import type {
  DiffFile,
  DiffFileStatus,
  DiffHunk,
  DiffLine,
  GitHubFilePatch,
  ParsedDiff,
  ParseDiffOptions,
} from "./types.js";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: ?(.*))?$/;

function decodeQuotedGitPath(value: string): string {
  if (!(value.startsWith('"') && value.endsWith('"'))) {
    return value;
  }

  const body = value.slice(1, -1);
  const bytes: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character !== "\\") {
      bytes.push(...Buffer.from(character ?? "", "utf8"));
      continue;
    }

    const escaped = body[index + 1];
    if (escaped === undefined) {
      bytes.push(0x5c);
      continue;
    }
    index += 1;

    const simpleEscapes: Readonly<Record<string, number>> = {
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
      "\\": 0x5c,
      '"': 0x22,
    };
    const simple = simpleEscapes[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }

    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2; count += 1) {
        const next = body[index + 1];
        if (next === undefined || !/[0-7]/u.test(next)) break;
        octal += next;
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    bytes.push(...Buffer.from(escaped, "utf8"));
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripGitPrefix(path: string): string {
  return path.startsWith("a/") || path.startsWith("b/") ? path.slice(2) : path;
}

function parsePatchPath(rawValue: string, removeDiffPrefix = true): string | null {
  const value = rawValue.trimEnd();
  if (value === "/dev/null") return null;

  if (value.startsWith('"')) {
    let escaped = false;
    for (let index = 1; index < value.length; index += 1) {
      const character = value[index];
      if (character === '"' && !escaped) {
        const decoded = decodeQuotedGitPath(value.slice(0, index + 1));
        return removeDiffPrefix ? stripGitPrefix(decoded) : decoded;
      }
      escaped = character === "\\" && !escaped;
      if (character !== "\\") escaped = false;
    }
  }

  // Traditional unified diffs may append a timestamp after a tab. Spaces are
  // valid path characters and therefore deliberately remain untouched.
  const path = value.split("\t", 1)[0] ?? value;
  return removeDiffPrefix ? stripGitPrefix(path) : path;
}

function parseDiffGitPaths(line: string): [string | null, string | null] {
  const value = line.slice("diff --git ".length);
  if (value.startsWith('"')) {
    const tokens = value.match(/"(?:\\.|[^"\\])*"/gu);
    const oldPath = tokens?.[0];
    const newPath = tokens?.[1];
    if (tokens?.length === 2 && oldPath !== undefined && newPath !== undefined) {
      return [parsePatchPath(oldPath), parsePatchPath(newPath)];
    }
  }

  const separator = value.lastIndexOf(" b/");
  if (separator >= 0) {
    return [parsePatchPath(value.slice(0, separator)), parsePatchPath(value.slice(separator + 1))];
  }
  return [null, null];
}

function normalizeStatus(status: string | undefined): DiffFileStatus {
  switch (status) {
    case "added":
      return "added";
    case "removed":
    case "deleted":
      return "deleted";
    case "modified":
      return "modified";
    case "renamed":
      return "renamed";
    case "copied":
      return "copied";
    default:
      return "unknown";
  }
}

function deriveStatus(file: DiffFile, explicitStatus?: DiffFileStatus): DiffFileStatus {
  if (explicitStatus !== undefined && explicitStatus !== "unknown") {
    return explicitStatus;
  }
  if (file.oldPath === null && file.newPath !== null) return "added";
  if (file.newPath === null && file.oldPath !== null) return "deleted";
  if (file.oldPath !== file.newPath) return "renamed";
  return file.oldPath === null && file.newPath === null ? "unknown" : "modified";
}

function createFile(options: ParseDiffOptions): DiffFile {
  const defaultPath = options.defaultPath ?? null;
  const defaultOldPath = options.defaultOldPath ?? defaultPath;
  return {
    oldPath: defaultOldPath,
    newPath: defaultPath,
    status: options.status ?? "unknown",
    hunks: [],
    binary: false,
    truncated: options.truncated ?? false,
  };
}

function finalizeHunk(file: DiffFile, hunk: DiffHunk | null): void {
  if (hunk === null) return;
  const oldConsumed = hunk.lines.filter((line) => line.oldLine !== null).length;
  const newConsumed = hunk.lines.filter((line) => line.newLine !== null).length;
  if (oldConsumed !== hunk.oldLines || newConsumed !== hunk.newLines) {
    hunk.truncated = true;
    file.truncated = true;
  }
}

function finalizeFile(
  files: DiffFile[],
  file: DiffFile | null,
  hunk: DiffHunk | null,
  explicitStatus?: DiffFileStatus,
): void {
  if (file === null) return;
  finalizeHunk(file, hunk);
  file.status = deriveStatus(file, explicitStatus ?? file.status);
  files.push(file);
}

/** Parse either a complete git diff or GitHub's per-file `patch` field. */
export function parseUnifiedDiff(patch: string, options: ParseDiffOptions = {}): ParsedDiff {
  if (patch.length === 0) {
    if (options.defaultPath === undefined) return { files: [], truncated: false };
    const file = createFile(options);
    file.truncated = options.truncated ?? true;
    file.status = deriveStatus(file, options.status);
    return { files: [file], truncated: file.truncated };
  }

  const files: DiffFile[] = [];
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const ensureFile = (): DiffFile => {
    file ??= createFile(options);
    return file;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      finalizeFile(files, file, hunk, options.status);
      const [oldPath, newPath] = parseDiffGitPaths(line);
      file = {
        oldPath,
        newPath,
        status: "unknown",
        hunks: [],
        binary: false,
        truncated: options.truncated ?? false,
      };
      hunk = null;
      continue;
    }

    const hunkMatch = HUNK_HEADER.exec(line);
    if (hunkMatch !== null) {
      const target = ensureFile();
      finalizeHunk(target, hunk);
      const oldStart = Number(hunkMatch[1]);
      const newStart = Number(hunkMatch[3]);
      hunk = {
        oldStart,
        oldLines: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart,
        newLines: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        heading: hunkMatch[5] ?? "",
        lines: [],
        truncated: false,
      };
      target.hunks.push(hunk);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }

    if (hunk !== null) {
      if (line === "\\ No newline at end of file") {
        const previousLine = hunk.lines.at(-1);
        if (previousLine !== undefined) previousLine.noNewlineAtEnd = true;
        continue;
      }

      const prefix = line[0];
      let parsedLine: DiffLine | null = null;
      if (prefix === " ") {
        parsedLine = {
          kind: "context",
          content: line.slice(1),
          raw: line,
          oldLine,
          newLine,
          noNewlineAtEnd: false,
        };
        oldLine += 1;
        newLine += 1;
      } else if (prefix === "+") {
        parsedLine = {
          kind: "addition",
          content: line.slice(1),
          raw: line,
          oldLine: null,
          newLine,
          noNewlineAtEnd: false,
        };
        newLine += 1;
      } else if (prefix === "-") {
        parsedLine = {
          kind: "deletion",
          content: line.slice(1),
          raw: line,
          oldLine,
          newLine: null,
          noNewlineAtEnd: false,
        };
        oldLine += 1;
      } else if (line.length === 0 && index === lines.length - 1) {
        // A trailing newline creates an empty split element; it is not a hunk line.
        continue;
      } else {
        hunk.truncated = true;
        ensureFile().truncated = true;
        hunk = null;
      }

      if (parsedLine !== null) hunk?.lines.push(parsedLine);
      continue;
    }

    const target = ensureFile();
    if (line.startsWith("--- ")) {
      target.oldPath = parsePatchPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      target.newPath = parsePatchPath(line.slice(4));
    } else if (line.startsWith("rename from ")) {
      target.oldPath = parsePatchPath(line.slice("rename from ".length), false);
      target.status = "renamed";
    } else if (line.startsWith("rename to ")) {
      target.newPath = parsePatchPath(line.slice("rename to ".length), false);
      target.status = "renamed";
    } else if (line.startsWith("copy from ")) {
      target.oldPath = parsePatchPath(line.slice("copy from ".length), false);
      target.status = "copied";
    } else if (line.startsWith("copy to ")) {
      target.newPath = parsePatchPath(line.slice("copy to ".length), false);
      target.status = "copied";
    } else if (line.startsWith("new file mode ")) {
      target.oldPath = null;
      target.status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      target.newPath = null;
      target.status = "deleted";
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      target.binary = true;
    }
  }

  finalizeFile(files, file, hunk, options.status);
  return { files, truncated: files.some((candidate) => candidate.truncated) };
}

/** Convert a GitHub REST changed-file record into the same parsed representation. */
export function parseGitHubFilePatch(input: GitHubFilePatch): DiffFile {
  const status = normalizeStatus(input.status);
  const oldPath = input.previousFilename ?? input.filename;
  if (input.patch === undefined || input.patch === null) {
    return {
      oldPath: status === "added" ? null : oldPath,
      newPath: status === "deleted" ? null : input.filename,
      status,
      hunks: [],
      binary: input.binary ?? false,
      truncated: input.truncated ?? !(input.binary ?? false),
    };
  }

  const parseOptions: ParseDiffOptions = {
    defaultPath: input.filename,
    defaultOldPath: status === "added" ? null : oldPath,
    status,
  };
  if (input.truncated !== undefined) parseOptions.truncated = input.truncated;
  const parsed = parseUnifiedDiff(input.patch, parseOptions);
  if (parsed.files.length !== 1) {
    return {
      oldPath: status === "added" ? null : oldPath,
      newPath: status === "deleted" ? null : input.filename,
      status,
      hunks: [],
      binary: input.binary ?? false,
      truncated: true,
    };
  }
  const file = parsed.files[0];
  if (file === undefined) {
    throw new Error("GitHub file patch unexpectedly produced no file");
  }
  // GitHub's filename metadata is authoritative. Never let patch text replace
  // the path binding used for inline review coordinates.
  file.oldPath = status === "added" ? null : oldPath;
  file.newPath = status === "deleted" ? null : input.filename;
  file.binary = input.binary ?? file.binary;
  return file;
}

/**
 * Parse GitHub file patches independently. A missing/truncated/binary file is
 * fail-closed on its own without invalidating commentable lines in other files.
 */
export function parseGitHubFilePatches(inputs: readonly GitHubFilePatch[]): ParsedDiff {
  const files = inputs.map(parseGitHubFilePatch);
  return { files, truncated: files.some((file) => file.truncated) };
}
