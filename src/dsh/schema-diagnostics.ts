import type { z } from "zod";

const contractFields = new Set([
  "protocolVersion",
  "operation",
  "state",
  "summary",
  "findings",
  "diagnosis",
  "changePlan",
  "verification",
  "toolRequest",
  "taskOutput",
  "id",
  "input",
  "reason",
  "title",
  "body",
  "severity",
  "category",
  "confidence",
  "path",
  "line",
  "side",
  "startLine",
  "startSide",
  "evidence",
  "suggestion",
  "command",
  "status",
]);
const structuralMessages = new Set([
  "is required when state is needs_tool",
  "must be omitted when state is final",
  "must be omitted when state is blocked",
  "is allowed only for a final task operation",
  "path must be a normalized repository-relative POSIX path",
  "path must not contain empty, dot, or parent segments",
  "reserved tracking markers are controller-owned",
  "startLine must not be greater than line",
  "startSide requires startLine",
  "cross-side review ranges are not supported",
]);

/** Bounded, locale-independent diagnostics that never echo model keys or values. */
export function renderDshSchemaIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((issue) => {
      const path =
        "$" +
        issue.path
          .slice(0, 8)
          .map((part) =>
            typeof part === "number" && Number.isSafeInteger(part) && part >= 0
              ? `[${String(Math.min(part, 2_147_483_647))}]`
              : typeof part === "string" && contractFields.has(part)
                ? `.${part}`
                : ".[field]",
          )
          .join("");
      let reason: string;
      switch (issue.code) {
        case "too_small":
          reason = `must meet minimum ${String(issue.minimum)} (${issue.origin})`;
          break;
        case "too_big":
          reason = `must not exceed maximum ${String(issue.maximum)} (${issue.origin})`;
          break;
        case "invalid_type":
          reason = `expected ${issue.expected}`;
          break;
        case "unrecognized_keys":
          reason = "unknown fields are not allowed";
          break;
        case "custom":
          reason = structuralMessages.has(issue.message)
            ? issue.message
            : "failed a structural or safety constraint";
          break;
        default:
          reason = "does not match the required format or allowed values";
      }
      return `${path}: ${reason}`;
    })
    .join("; ");
}
