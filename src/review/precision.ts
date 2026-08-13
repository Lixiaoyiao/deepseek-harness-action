import { fingerprintFinding } from "./fingerprint.js";
import type { ReviewCategory, ReviewFinding, ReviewSeverity } from "./schema.js";

const DEFAULT_CATEGORIES = new Set<ReviewCategory>([
  "correctness",
  "security",
  "concurrency",
  "regression",
]);

const DEFAULT_SEVERITIES = new Set<ReviewSeverity>(["critical", "high", "medium"]);

const SEVERITY_ORDER: Readonly<Record<ReviewSeverity, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface PrecisionOptions {
  minConfidence?: number;
  maxFindings?: number;
  requireEvidence?: boolean;
  categories?: ReadonlySet<ReviewCategory>;
  severities?: ReadonlySet<ReviewSeverity>;
}

/** Keep only evidence-backed, high-confidence actionable findings. */
export function filterHighPrecisionFindings(
  findings: readonly ReviewFinding[],
  options: PrecisionOptions = {},
): ReviewFinding[] {
  const minimum = options.minConfidence ?? 0.8;
  const maximum = options.maxFindings ?? 20;
  const requireEvidence = options.requireEvidence ?? true;
  const categories = options.categories ?? DEFAULT_CATEGORIES;
  const severities = options.severities ?? DEFAULT_SEVERITIES;

  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
    throw new RangeError("minConfidence must be between 0 and 1");
  }
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > 100) {
    throw new RangeError("maxFindings must be an integer between 0 and 100");
  }

  const seen = new Set<string>();
  return findings
    .filter(
      (finding) =>
        finding.confidence >= minimum &&
        categories.has(finding.category) &&
        severities.has(finding.severity) &&
        (!requireEvidence || finding.evidence !== undefined),
    )
    .sort(
      (left, right) =>
        SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity] ||
        right.confidence - left.confidence ||
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.title.localeCompare(right.title),
    )
    .filter((finding) => {
      const fingerprint = fingerprintFinding(finding);
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    })
    .slice(0, maximum);
}

export const selectHighPrecisionFindings = filterHighPrecisionFindings;
