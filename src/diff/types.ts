export type DiffSide = "LEFT" | "RIGHT";

export type DiffLineKind = "context" | "addition" | "deletion";

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed" | "copied" | "unknown";

export interface DiffLine {
  kind: DiffLineKind;
  /** Text after the unified-diff prefix character. */
  content: string;
  /** The original unified-diff line, including its prefix. */
  raw: string;
  oldLine: number | null;
  newLine: number | null;
  noNewlineAtEnd: boolean;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading: string;
  lines: DiffLine[];
  /** True when the available patch ended before the header-declared ranges did. */
  truncated: boolean;
}

export interface DiffFile {
  oldPath: string | null;
  newPath: string | null;
  status: DiffFileStatus;
  hunks: DiffHunk[];
  binary: boolean;
  truncated: boolean;
}

export interface ParsedDiff {
  files: DiffFile[];
  truncated: boolean;
}

export interface ParseDiffOptions {
  /** Path to use when parsing GitHub's per-file `patch` field. */
  defaultPath?: string;
  defaultOldPath?: string | null;
  status?: DiffFileStatus;
  /** Set when the caller knows GitHub truncated the supplied patch. */
  truncated?: boolean;
}

export interface GitHubFilePatch {
  filename: string;
  previousFilename?: string;
  status?: string;
  patch?: string | null;
  /** Set by a caller that detected an incomplete GitHub patch response. */
  truncated?: boolean;
  binary?: boolean;
}

export interface FindingLocation {
  path: string;
  /** End line for a single-line or multi-line comment. */
  line: number;
  side?: DiffSide | undefined;
  startLine?: number | undefined;
  startSide?: DiffSide | undefined;
}

export interface InlineLocation {
  path: string;
  line: number;
  side: DiffSide;
  startLine?: number;
  startSide?: DiffSide;
}
