import { createHash } from "node:crypto";

import type { ReviewFinding } from "./schema.js";

const FINGERPRINT_VERSION = "dsh-finding-v2";

export interface FingerprintableFinding extends Pick<
  ReviewFinding,
  "category" | "path" | "line" | "side" | "startLine" | "startSide"
> {
  /** Accepted for call-site compatibility, but never used for identity. */
  title?: string | undefined;
  /** Accepted for call-site compatibility, but never used for identity. */
  body?: string | undefined;
  /** Accepted for call-site compatibility, but never used for identity. */
  evidence?: string | undefined;
  /** Stable source context is preferred over model prose when available. */
  anchorContext?: string | undefined;
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "").normalize("NFC");
}

function normalizeAnchor(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").trim();
}

/**
 * Produce a stable finding identity without using model-authored prose. The
 * publisher supplies source context so line movement across commits does not
 * create another thread. Location is a deterministic fallback for callers
 * that do not have a parsed diff (for example, in-run precision filtering).
 */
export function fingerprintFinding(finding: FingerprintableFinding): string {
  const sourceAnchor =
    finding.anchorContext === undefined ? undefined : normalizeAnchor(finding.anchorContext);
  const anchor =
    sourceAnchor === undefined || sourceAnchor.length === 0
      ? [
          "location",
          finding.side ?? "AUTO",
          finding.startSide ?? finding.side ?? "AUTO",
          finding.startLine ?? finding.line,
          finding.line,
        ]
      : ["source", sourceAnchor];
  const canonical = JSON.stringify([
    FINGERPRINT_VERSION,
    finding.category,
    normalizePath(finding.path),
    anchor,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export const createFindingFingerprint = fingerprintFinding;
