import { describe, expect, it } from "vitest";

import { mapFindingToInline } from "../src/diff/map.js";
import {
  parseGitHubFilePatch,
  parseGitHubFilePatches,
  parseUnifiedDiff,
} from "../src/diff/parse.js";

const MULTI_HUNK_DIFF = `diff --git a/src/value.ts b/src/value.ts
index 1111111..2222222 100644
--- a/src/value.ts
+++ b/src/value.ts
@@ -1,4 +1,5 @@ export function value() {
 const one = 1;
-const value = unsafe();
+const value = safe();
+const extra = validate(value);
 return value;
 }
@@ -10,2 +11,2 @@ export function other() {
 const before = true;
-return oldResult;
+return newResult;
`;

describe("parseUnifiedDiff", () => {
  it("parses multiple hunks and exact old/new blob coordinates", () => {
    const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);

    expect(parsed.truncated).toBe(false);
    expect(parsed.files).toHaveLength(1);
    const file = parsed.files[0];
    expect(file).toMatchObject({
      oldPath: "src/value.ts",
      newPath: "src/value.ts",
      status: "modified",
      binary: false,
      truncated: false,
    });
    expect(file?.hunks).toHaveLength(2);
    expect(file?.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 4,
      newStart: 1,
      newLines: 5,
      heading: "export function value() {",
      truncated: false,
    });
    expect(
      file?.hunks[0]?.lines.map(({ kind, oldLine, newLine }) => ({
        kind,
        oldLine,
        newLine,
      })),
    ).toEqual([
      { kind: "context", oldLine: 1, newLine: 1 },
      { kind: "deletion", oldLine: 2, newLine: null },
      { kind: "addition", oldLine: null, newLine: 2 },
      { kind: "addition", oldLine: null, newLine: 3 },
      { kind: "context", oldLine: 3, newLine: 4 },
      { kind: "context", oldLine: 4, newLine: 5 },
    ]);
    expect(file?.hunks[1]?.lines.at(-1)).toMatchObject({
      kind: "addition",
      oldLine: null,
      newLine: 12,
    });
  });

  it("parses added and deleted files", () => {
    const parsed = parseUnifiedDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,2 @@
+one
+two
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two`);

    expect(parsed.files).toHaveLength(2);
    expect(parsed.files[0]).toMatchObject({
      oldPath: null,
      newPath: "new.ts",
      status: "added",
    });
    expect(parsed.files[1]).toMatchObject({
      oldPath: "old.ts",
      newPath: null,
      status: "deleted",
    });
  });

  it("tracks renames, including paths containing spaces", () => {
    const parsed = parseUnifiedDiff(`diff --git a/src/old name.ts b/src/new name.ts
similarity index 72%
rename from src/old name.ts
rename to src/new name.ts
--- a/src/old name.ts
+++ b/src/new name.ts
@@ -1 +1 @@
-old
+new`);

    expect(parsed.files[0]).toMatchObject({
      oldPath: "src/old name.ts",
      newPath: "src/new name.ts",
      status: "renamed",
    });
  });

  it("does not strip a real a/ or b/ directory from rename metadata", () => {
    const parsed = parseUnifiedDiff(`diff --git a/a/old.ts b/b/new.ts
similarity index 100%
rename from a/old.ts
rename to b/new.ts`);

    expect(parsed.files[0]).toMatchObject({
      oldPath: "a/old.ts",
      newPath: "b/new.ts",
      status: "renamed",
    });
  });

  it("decodes git-quoted paths", () => {
    const parsed = parseUnifiedDiff(String.raw`diff --git "a/src/\303\251.ts" "b/src/\303\251.ts"
--- "a/src/\303\251.ts"
+++ "b/src/\303\251.ts"
@@ -1 +1 @@
-old
+new`);

    expect(parsed.files[0]?.newPath).toBe("src/é.ts");
  });

  it("normalizes CRLF without changing hunk content", () => {
    const parsed = parseUnifiedDiff(
      "--- a/file.txt\r\n+++ b/file.txt\r\n@@ -1 +1 @@\r\n-old\r\n+new\r\n",
    );
    expect(parsed.files[0]?.hunks[0]?.lines.map((line) => line.content)).toEqual(["old", "new"]);
    expect(parsed.truncated).toBe(false);
  });

  it("associates no-newline sentinels with the preceding lines", () => {
    const parsed = parseUnifiedDiff(`--- a/file.txt
+++ b/file.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file`);

    expect(parsed.files[0]?.hunks[0]?.lines).toMatchObject([
      { kind: "deletion", noNewlineAtEnd: true },
      { kind: "addition", noNewlineAtEnd: true },
    ]);
    expect(parsed.truncated).toBe(false);
  });

  it("identifies binary diffs without inventing lines", () => {
    const parsed = parseUnifiedDiff(`diff --git a/image.png b/image.png
index 1111111..2222222 100644
Binary files a/image.png and b/image.png differ`);

    expect(parsed.files[0]).toMatchObject({
      oldPath: "image.png",
      newPath: "image.png",
      binary: true,
      hunks: [],
      truncated: false,
    });
  });

  it("marks a count-mismatched hunk and its file as truncated", () => {
    const parsed = parseUnifiedDiff(`--- a/file.ts
+++ b/file.ts
@@ -1,2 +1,2 @@
 unchanged`);

    expect(parsed.truncated).toBe(true);
    expect(parsed.files[0]?.truncated).toBe(true);
    expect(parsed.files[0]?.hunks[0]?.truncated).toBe(true);
  });

  it("parses GitHub per-file patches and conservatively marks missing patches", () => {
    const renamed = parseGitHubFilePatch({
      filename: "new.ts",
      previousFilename: "old.ts",
      status: "renamed",
      patch: "@@ -2 +2 @@\n-old\n+new",
    });
    expect(renamed).toMatchObject({
      oldPath: "old.ts",
      newPath: "new.ts",
      status: "renamed",
      truncated: false,
    });

    expect(parseGitHubFilePatch({ filename: "large.ts", status: "modified" })).toMatchObject({
      binary: false,
      truncated: true,
      hunks: [],
    });
    expect(
      parseGitHubFilePatch({
        filename: "asset.bin",
        status: "modified",
        binary: true,
      }),
    ).toMatchObject({ binary: true, truncated: false, hunks: [] });
  });

  it("returns no synthetic file for an empty complete diff", () => {
    expect(parseUnifiedDiff("")).toEqual({ files: [], truncated: false });
  });

  it("isolates missing patches instead of poisoning valid files", () => {
    const parsed = parseGitHubFilePatches([
      {
        filename: "good.ts",
        status: "modified",
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
      { filename: "large.ts", status: "modified" },
      { filename: "asset.bin", status: "modified", binary: true },
    ]);
    expect(parsed.truncated).toBe(true);
    expect(parsed.files.map(({ truncated }) => truncated)).toEqual([false, true, false]);
    expect(mapFindingToInline(parsed, { path: "good.ts", line: 1 })).toEqual({
      path: "good.ts",
      line: 1,
      side: "RIGHT",
    });
    expect(mapFindingToInline(parsed, { path: "large.ts", line: 1 })).toBeNull();
  });

  it("treats GitHub metadata as authoritative over injected patch headers", () => {
    const file = parseGitHubFilePatch({
      filename: "safe.ts",
      status: "modified",
      patch: `@@ -1 +1 @@
-old
+new
diff --git a/injected.ts b/injected.ts
--- a/injected.ts
+++ b/injected.ts
@@ -1 +1 @@
-bad
+worse`,
    });
    expect(file).toMatchObject({
      oldPath: "safe.ts",
      newPath: "safe.ts",
      truncated: true,
      hunks: [],
    });
  });
});

describe("mapFindingToInline", () => {
  const parsed = parseUnifiedDiff(MULTI_HUNK_DIFF);

  it("maps additions, deletions and context lines to their correct side", () => {
    expect(mapFindingToInline(parsed, { path: "src/value.ts", line: 2 })).toEqual({
      path: "src/value.ts",
      line: 2,
      side: "RIGHT",
    });
    expect(
      mapFindingToInline(parsed, {
        path: "src/value.ts",
        line: 2,
        side: "LEFT",
      }),
    ).toEqual({ path: "src/value.ts", line: 2, side: "LEFT" });
    expect(mapFindingToInline(parsed, { path: "src/value.ts", line: 1 })).toEqual({
      path: "src/value.ts",
      line: 1,
      side: "RIGHT",
    });
  });

  it("rejects a line on the wrong side or outside a hunk", () => {
    expect(
      mapFindingToInline(parsed, {
        path: "src/value.ts",
        line: 12,
        side: "LEFT",
      }),
    ).toBeNull();
    expect(mapFindingToInline(parsed, { path: "src/value.ts", line: 9 })).toBeNull();
    expect(mapFindingToInline(parsed, { path: "missing.ts", line: 1 })).toBeNull();
  });

  it("maps a contiguous same-hunk range and rejects cross-hunk ranges", () => {
    expect(
      mapFindingToInline(parsed, {
        path: "src/value.ts",
        startLine: 2,
        line: 5,
        side: "RIGHT",
      }),
    ).toEqual({
      path: "src/value.ts",
      startLine: 2,
      startSide: "RIGHT",
      line: 5,
      side: "RIGHT",
    });
    expect(
      mapFindingToInline(parsed, {
        path: "src/value.ts",
        startLine: 5,
        line: 11,
        side: "RIGHT",
      }),
    ).toBeNull();
    expect(
      mapFindingToInline(parsed, {
        path: "src/value.ts",
        startLine: 3,
        startSide: "LEFT",
        line: 4,
        side: "RIGHT",
      }),
    ).toBeNull();
  });

  it("uses the new path for renamed-file GitHub comments", () => {
    const renamed = parseUnifiedDiff(`diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
--- a/old.ts
+++ b/new.ts
@@ -1 +1 @@
-old
+new`);
    expect(mapFindingToInline(renamed, { path: "old.ts", line: 1, side: "LEFT" })).toEqual({
      path: "new.ts",
      line: 1,
      side: "LEFT",
    });
  });

  it("refuses binary, truncated, invalid and traversal locations", () => {
    const binary = parseUnifiedDiff(`diff --git a/a.bin b/a.bin
Binary files a/a.bin and b/a.bin differ`);
    const truncated = parseUnifiedDiff("@@ -1,2 +1,2 @@\n unchanged", {
      defaultPath: "file.ts",
    });
    expect(mapFindingToInline(binary, { path: "a.bin", line: 1 })).toBeNull();
    expect(mapFindingToInline(truncated, { path: "file.ts", line: 1 })).toBeNull();
    expect(mapFindingToInline(parsed, { path: "../src/value.ts", line: 1 })).toBeNull();
    expect(mapFindingToInline(parsed, { path: "src/value.ts", line: 0 })).toBeNull();
    expect(
      mapFindingToInline(parsed, {
        path: "src/value.ts",
        startSide: "RIGHT",
        line: 1,
      }),
    ).toBeNull();
  });
});
