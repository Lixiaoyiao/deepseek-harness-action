import { z } from "zod";

import {
  REVIEW_LIMITS,
  reviewChangeSchema,
  reviewFindingSchema,
  reviewTestSchema,
} from "../review/schema.js";
import { DshMalformedOutputError } from "./errors.js";

export const dshOperationSchema = z.enum(["review", "diagnose", "fix", "implement"]);
export type DshOperation = z.infer<typeof dshOperationSchema>;

/**
 * The only accepted boundary format from the untrusted model process. Unknown
 * keys are rejected so a model cannot smuggle controller directives alongside
 * review data.
 */
export const dshOutputSchema = z.strictObject({
  operation: dshOperationSchema,
  summary: z.string().trim().min(1).max(REVIEW_LIMITS.summaryCharacters),
  findings: z.array(reviewFindingSchema).max(REVIEW_LIMITS.maxFindings),
  diagnosis: z.string().trim().min(1).max(REVIEW_LIMITS.diagnosisCharacters).optional(),
  changePlan: z.array(reviewChangeSchema).max(REVIEW_LIMITS.maxChanges).optional(),
  verification: z.array(reviewTestSchema).max(REVIEW_LIMITS.maxTests).optional(),
});

export type DshOutput = z.infer<typeof dshOutputSchema>;

function renderIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path = issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`;
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/** Parse one complete JSON value. Markdown fences and trailing prose fail. */
export function parseDshOutput(raw: string, expectedOperation?: DshOperation): DshOutput {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch (error: unknown) {
    throw new DshMalformedOutputError("DSH stdout was not one complete JSON value", {
      cause: error,
    });
  }

  const parsed = dshOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new DshMalformedOutputError(
      `DSH output failed schema validation: ${renderIssues(parsed.error)}`,
    );
  }
  if (expectedOperation !== undefined && parsed.data.operation !== expectedOperation) {
    throw new DshMalformedOutputError(
      `DSH returned operation ${parsed.data.operation}; expected ${expectedOperation}`,
    );
  }
  return parsed.data;
}
