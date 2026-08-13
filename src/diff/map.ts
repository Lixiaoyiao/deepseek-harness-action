import type {
  DiffFile,
  DiffLine,
  DiffSide,
  FindingLocation,
  InlineLocation,
  ParsedDiff,
} from "./types.js";

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").normalize("NFC");
}

function isSafeRepositoryPath(path: string): boolean {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\r") ||
    path.includes("\n") ||
    path.startsWith("/") ||
    /^[A-Za-z]:/u.test(path)
  ) {
    return false;
  }
  return !normalizePath(path)
    .split("/")
    .some((segment) => segment === "..");
}

function findFile(diff: ParsedDiff, path: string): DiffFile | undefined {
  const normalized = normalizePath(path);
  return diff.files.find(
    (file) =>
      (file.newPath !== null && normalizePath(file.newPath) === normalized) ||
      (file.oldPath !== null && normalizePath(file.oldPath) === normalized),
  );
}

function lineNumber(line: DiffLine, side: DiffSide): number | null {
  return side === "RIGHT" ? line.newLine : line.oldLine;
}

function supportsSide(line: DiffLine, side: DiffSide): boolean {
  if (side === "RIGHT") return line.kind !== "deletion" && line.newLine !== null;
  return line.kind !== "addition" && line.oldLine !== null;
}

function hasCommentableLine(file: DiffFile, lineNumberToFind: number, side: DiffSide): boolean {
  return file.hunks.some((hunk) =>
    hunk.lines.some(
      (line) => supportsSide(line, side) && lineNumber(line, side) === lineNumberToFind,
    ),
  );
}

function isCommentableRange(
  file: DiffFile,
  startLine: number,
  endLine: number,
  side: DiffSide,
): boolean {
  if (startLine > endLine) return false;
  return file.hunks.some((hunk) => {
    const available = new Set(
      hunk.lines
        .filter((line) => supportsSide(line, side))
        .map((line) => lineNumber(line, side))
        .filter((line): line is number => line !== null),
    );
    for (let line = startLine; line <= endLine; line += 1) {
      if (!available.has(line)) return false;
    }
    return true;
  });
}

/**
 * Map a model-reported blob line to GitHub's modern `line`/`side` coordinates.
 * Returns null rather than guessing when the path or line is outside the patch.
 */
export function mapFindingToInline(
  diff: ParsedDiff,
  location: FindingLocation,
): InlineLocation | null {
  if (
    !isSafeRepositoryPath(location.path) ||
    !Number.isSafeInteger(location.line) ||
    location.line < 1
  ) {
    return null;
  }
  const file = findFile(diff, location.path);
  if (file === undefined || file.binary || file.truncated) return null;

  let side = location.side;
  if (side === undefined) {
    if (hasCommentableLine(file, location.line, "RIGHT")) side = "RIGHT";
    else if (hasCommentableLine(file, location.line, "LEFT")) side = "LEFT";
    else return null;
  }

  if (!hasCommentableLine(file, location.line, side)) return null;

  const path = file.newPath ?? file.oldPath;
  if (path === null || !isSafeRepositoryPath(path)) return null;

  if (location.startLine === undefined) {
    if (location.startSide !== undefined) return null;
    return { path, line: location.line, side };
  }

  if (!Number.isSafeInteger(location.startLine) || location.startLine < 1) return null;
  const startSide = location.startSide ?? side;
  // Cross-side ranges are legal in some GitHub API variants but are fragile
  // across hunks. Keep v1 exact and deterministic.
  if (startSide !== side) return null;
  if (!isCommentableRange(file, location.startLine, location.line, side)) return null;

  return {
    path,
    line: location.line,
    side,
    startLine: location.startLine,
    startSide,
  };
}

export const mapToInlineComment = mapFindingToInline;
