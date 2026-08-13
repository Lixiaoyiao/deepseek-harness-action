import { z } from "zod";

export const REVIEW_LIMITS = Object.freeze({
  summaryCharacters: 12_000,
  diagnosisCharacters: 12_000,
  titleCharacters: 200,
  bodyCharacters: 6_000,
  evidenceCharacters: 3_000,
  suggestionCharacters: 6_000,
  pathCharacters: 1_024,
  maxFindings: 100,
  maxChanges: 100,
  maxTests: 100,
  maxLine: 2_147_483_647,
});

export const reviewSeveritySchema = z.enum(["critical", "high", "medium", "low"]);

export const reviewCategorySchema = z.enum([
  "correctness",
  "security",
  "concurrency",
  "regression",
  "reliability",
  "performance",
  "maintainability",
  "other",
]);

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
}

const safeRepositoryPathSchema = z
  .string()
  .min(1)
  .max(REVIEW_LIMITS.pathCharacters)
  .superRefine((path, context) => {
    if (
      path !== path.trim() ||
      containsControlCharacter(path) ||
      path.includes("\\") ||
      path.startsWith("/") ||
      /^[A-Za-z]:/u.test(path)
    ) {
      context.addIssue({
        code: "custom",
        message: "path must be a normalized repository-relative POSIX path",
      });
      return;
    }

    const segments = path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      context.addIssue({
        code: "custom",
        message: "path must not contain empty, dot, or parent segments",
      });
    }
  });

const lineSchema = z.number().int().min(1).max(REVIEW_LIMITS.maxLine);

const RESERVED_TRACKING_PATTERN = /<!--\s*dsh-action\s*:/iu;

function rejectTrackingMarker(
  value: string | undefined,
  context: z.RefinementCtx,
  field: string,
): void {
  if (value !== undefined && RESERVED_TRACKING_PATTERN.test(value)) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "reserved tracking markers are controller-owned",
    });
  }
}

export const reviewFindingSchema = z
  .strictObject({
    title: boundedText(REVIEW_LIMITS.titleCharacters),
    body: boundedText(REVIEW_LIMITS.bodyCharacters),
    severity: reviewSeveritySchema,
    category: reviewCategorySchema,
    confidence: z.number().min(0).max(1),
    path: safeRepositoryPathSchema,
    line: lineSchema,
    side: z.enum(["LEFT", "RIGHT"]).optional(),
    startLine: lineSchema.optional(),
    startSide: z.enum(["LEFT", "RIGHT"]).optional(),
    evidence: boundedText(REVIEW_LIMITS.evidenceCharacters).optional(),
    suggestion: boundedText(REVIEW_LIMITS.suggestionCharacters).optional(),
  })
  .superRefine((finding, context) => {
    if (finding.startLine !== undefined && finding.startLine > finding.line) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "startLine must not be greater than line",
      });
    }
    if (finding.startSide !== undefined && finding.startLine === undefined) {
      context.addIssue({
        code: "custom",
        path: ["startSide"],
        message: "startSide requires startLine",
      });
    }
    if (
      finding.startSide !== undefined &&
      finding.side !== undefined &&
      finding.startSide !== finding.side
    ) {
      context.addIssue({
        code: "custom",
        path: ["startSide"],
        message: "cross-side review ranges are not supported",
      });
    }

    rejectTrackingMarker(finding.title, context, "title");
    rejectTrackingMarker(finding.body, context, "body");
    rejectTrackingMarker(finding.evidence, context, "evidence");
    rejectTrackingMarker(finding.suggestion, context, "suggestion");
  });

export const reviewChangeSchema = z
  .strictObject({
    path: safeRepositoryPathSchema,
    summary: boundedText(2_000),
  })
  .superRefine((change, context) => {
    rejectTrackingMarker(change.summary, context, "summary");
  });

export const reviewTestSchema = z
  .strictObject({
    command: boundedText(1_000),
    status: z.enum(["passed", "failed", "skipped"]),
    summary: boundedText(2_000).optional(),
  })
  .superRefine((test, context) => {
    rejectTrackingMarker(test.command, context, "command");
    rejectTrackingMarker(test.summary, context, "summary");
  });

export const reviewResultSchema = z
  .strictObject({
    operation: z.enum(["review", "diagnose", "fix", "implement"]).optional(),
    summary: boundedText(REVIEW_LIMITS.summaryCharacters),
    findings: z.array(reviewFindingSchema).max(REVIEW_LIMITS.maxFindings),
    diagnosis: boundedText(REVIEW_LIMITS.diagnosisCharacters).optional(),
    changes: z.array(reviewChangeSchema).max(REVIEW_LIMITS.maxChanges).optional(),
    tests: z.array(reviewTestSchema).max(REVIEW_LIMITS.maxTests).optional(),
  })
  .superRefine((result, context) => {
    rejectTrackingMarker(result.summary, context, "summary");
    rejectTrackingMarker(result.diagnosis, context, "diagnosis");
  });

export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;
export type ReviewCategory = z.infer<typeof reviewCategorySchema>;
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;
export type ReviewChange = z.infer<typeof reviewChangeSchema>;
export type ReviewTest = z.infer<typeof reviewTestSchema>;
export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** Parse and copy an untrusted agent result, rejecting unknown or unsafe fields. */
export function parseReviewResult(value: unknown): ReviewResult {
  return reviewResultSchema.parse(value);
}

export function safeParseReviewResult(value: unknown): z.ZodSafeParseResult<ReviewResult> {
  return reviewResultSchema.safeParse(value);
}
