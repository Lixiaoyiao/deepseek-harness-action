import { sanitizeUntrustedText } from "../security/redaction.js";
import { utf8Prefix } from "../security/utf8.js";
import { stripTrackingMarkers } from "../review/tracking.js";
import { RESERVED_MARKER_PATTERN } from "./github-catalog.js";

function utf16Prefix(value: string, maximumCodeUnits: number): string {
  if (value.length <= maximumCodeUnits) return value;
  const finalCodeUnit = value.charCodeAt(maximumCodeUnits - 1);
  const nextCodeUnit = value.charCodeAt(maximumCodeUnits);
  const splitsSurrogatePair =
    finalCodeUnit >= 0xd800 &&
    finalCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff;
  return value.slice(0, splitsSurrogatePair ? maximumCodeUnits - 1 : maximumCodeUnits);
}

/** Sanitize model text before a public GitHub mutation, then enforce exact input bounds. */
export function sanitizedGitHubPublicText(
  value: string,
  label: string,
  allowEmpty: boolean,
  maximumCharacters: number,
  maximumBytes: number,
): string {
  if (RESERVED_MARKER_PATTERN.test(value)) {
    throw new Error(`${label} contains a reserved Controller marker`);
  }
  const sanitized = sanitizeUntrustedText(stripTrackingMarkers(value));
  if (!allowEmpty && sanitized.trim() === "") {
    throw new Error(`${label} is empty after Controller sanitization`);
  }
  if (sanitized.length > maximumCharacters || Buffer.byteLength(sanitized, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds its bound after Controller sanitization`);
  }
  return sanitized;
}

/** Sanitize backend-owned public text and return a complete-code-point bounded prefix. */
export function sanitizedGitHubOutputText(
  value: string,
  maximumCharacters: number,
  maximumBytes: number,
): string {
  const sanitized = sanitizeUntrustedText(stripTrackingMarkers(value));
  return utf16Prefix(utf8Prefix(sanitized, maximumBytes), maximumCharacters);
}
