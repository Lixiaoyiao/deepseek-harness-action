/*
 * Adapted from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */

export function stripInvisibleCharacters(content: string): string {
  // Regex ranges intentionally remove hidden Unicode and ASCII control channels.
  /* eslint-disable no-control-regex, no-misleading-character-class */
  return content
    .replace(/[\u200b\u200c\u200d\ufeff\u00ad]/gu, "")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  /* eslint-enable no-control-regex, no-misleading-character-class */
}

export function redactSecrets(content: string): string {
  return content
    .replace(/gh[pousr]_[A-Za-z0-9]{36}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/github_pat_[A-Za-z0-9_]{11,221}\b/gu, "[REDACTED_GITHUB_TOKEN]")
    .replace(/sk-ant-[A-Za-z0-9_-]{20,}/gu, "[REDACTED_ANTHROPIC_KEY]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/gu, "[REDACTED_API_KEY]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[REDACTED_AWS_KEY_ID]")
    .replace(/xox[abpsr]-[A-Za-z0-9-]{10,}/gu, "[REDACTED_SLACK_TOKEN]")
    .replace(
      /eyJ[A-Za-z0-9_-]{10,2000}\.eyJ[A-Za-z0-9_-]{10,4000}\.[A-Za-z0-9_-]{10,2000}\b/gu,
      "[REDACTED_JWT]",
    );
}

const IMAGE_MARKER = "[image removed]";
const MAX_IMAGE_INPUT_CHARACTERS = 1024 * 1024;
const MAX_IMAGE_TOKEN_CHARACTERS = 16 * 1024;
const MAX_IMAGE_TOKENS = 512;
const MAX_MARKDOWN_NESTING = 32;
const MAX_HTML_TAG_CHARACTERS = 16 * 1024;

interface BalancedDelimiter {
  readonly end: number;
  readonly exceededLimit: boolean;
}

function escapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findBalancedDelimiter(
  value: string,
  start: number,
  opening: "[" | "(",
  closing: "]" | ")",
): BalancedDelimiter {
  let depth = 1;
  const limit = Math.min(value.length, start + MAX_IMAGE_TOKEN_CHARACTERS);
  for (let cursor = start + 1; cursor < limit; cursor += 1) {
    const character = value[cursor];
    if (character === "\\") {
      cursor += 1;
      continue;
    }
    if (character === "\n" || character === "\r") {
      if (opening === "(") return { end: -1, exceededLimit: false };
      continue;
    }
    if (character === opening) {
      depth += 1;
      if (depth > MAX_MARKDOWN_NESTING) return { end: -1, exceededLimit: true };
    } else if (character === closing) {
      depth -= 1;
      if (depth === 0) return { end: cursor, exceededLimit: false };
    }
  }
  return { end: -1, exceededLimit: limit < value.length };
}

function normalizeReferenceLabel(value: string): string {
  return value
    .replace(/\\([!"#$%&'()*+,./:;<=>?@[\\\]^_`{|}~-])/gu, "$1")
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function referenceDefinitionLabel(line: string): string | undefined {
  const indentation = /^ {0,3}/u.exec(line)?.[0].length ?? 0;
  if (line[indentation] !== "[") return undefined;
  const closing = findBalancedDelimiter(line, indentation, "[", "]");
  if (closing.end < 0 || line[closing.end + 1] !== ":") return undefined;
  const label = normalizeReferenceLabel(line.slice(indentation + 1, closing.end));
  return label === "" || label.length > 999 ? undefined : label;
}

function referenceDefinitionLabels(content: string): ReadonlySet<string> {
  const labels = new Set<string>();
  for (const line of content.split(/\r?\n/u)) {
    const label = referenceDefinitionLabel(line);
    if (label !== undefined) labels.add(label);
  }
  return labels;
}

function removeMarkdownImageTokens(content: string): {
  readonly content: string;
  readonly usedReferenceLabels: ReadonlySet<string>;
} {
  const definitions = referenceDefinitionLabels(content);
  const usedReferenceLabels = new Set<string>();
  let output = "";
  let copiedThrough = 0;
  let tokenCount = 0;

  for (let cursor = 0; cursor < content.length - 1; cursor += 1) {
    if (content[cursor] !== "!" || content[cursor + 1] !== "[" || escapedAt(content, cursor)) {
      continue;
    }
    tokenCount += 1;
    if (tokenCount > MAX_IMAGE_TOKENS) {
      output += content.slice(copiedThrough, cursor) + IMAGE_MARKER;
      return { content: output, usedReferenceLabels };
    }

    const altClosing = findBalancedDelimiter(content, cursor + 1, "[", "]");
    if (altClosing.end < 0) {
      if (altClosing.exceededLimit) {
        output += content.slice(copiedThrough, cursor) + IMAGE_MARKER;
        return { content: output, usedReferenceLabels };
      }
      continue;
    }

    const alt = content.slice(cursor + 2, altClosing.end);
    let tokenEnd = -1;
    const next = content[altClosing.end + 1];
    if (next === "(") {
      const destinationClosing = findBalancedDelimiter(content, altClosing.end + 1, "(", ")");
      if (destinationClosing.end >= 0) tokenEnd = destinationClosing.end;
      else if (destinationClosing.exceededLimit) {
        output += content.slice(copiedThrough, cursor) + IMAGE_MARKER;
        return { content: output, usedReferenceLabels };
      }
    } else if (next === "[") {
      const labelClosing = findBalancedDelimiter(content, altClosing.end + 1, "[", "]");
      if (labelClosing.end >= 0) {
        const explicitLabel = content.slice(altClosing.end + 2, labelClosing.end);
        const label = normalizeReferenceLabel(explicitLabel === "" ? alt : explicitLabel);
        if (label !== "") usedReferenceLabels.add(label);
        tokenEnd = labelClosing.end;
      }
    } else {
      const label = normalizeReferenceLabel(alt);
      if (definitions.has(label)) {
        usedReferenceLabels.add(label);
        tokenEnd = altClosing.end;
      }
    }

    if (tokenEnd < 0) continue;
    output += content.slice(copiedThrough, cursor) + IMAGE_MARKER;
    copiedThrough = tokenEnd + 1;
    cursor = tokenEnd;
  }

  return { content: output + content.slice(copiedThrough), usedReferenceLabels };
}

function removeUsedReferenceDefinitions(
  content: string,
  usedReferenceLabels: ReadonlySet<string>,
): string {
  if (usedReferenceLabels.size === 0) return content;
  const lines = content.split(/(\r?\n)/u);
  for (let index = 0; index < lines.length; index += 2) {
    const line = lines[index] ?? "";
    const label = referenceDefinitionLabel(line);
    if (label !== undefined && usedReferenceLabels.has(label)) lines[index] = "";
  }
  return lines.join("");
}

function htmlTagEnd(content: string, start: number): number {
  const limit = Math.min(content.length, start + MAX_HTML_TAG_CHARACTERS);
  let quote: '"' | "'" | undefined;
  for (let cursor = start + 1; cursor < limit; cursor += 1) {
    const character = content[cursor];
    if (quote !== undefined) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === ">") return cursor;
  }
  return -1;
}

function removeRawHtmlImages(content: string): string {
  let output = "";
  let copiedThrough = 0;
  for (let cursor = 0; cursor < content.length; cursor += 1) {
    if (content[cursor] !== "<") continue;
    const match = /^<\/?\s*(img|source|picture)(?=\s|\/?>)/iu.exec(content.slice(cursor));
    if (match === null) continue;
    const end = htmlTagEnd(content, cursor);
    if (end < 0) continue;
    output += content.slice(copiedThrough, cursor);
    if (match[1]?.toLowerCase() === "img" && !match[0].startsWith("</")) output += IMAGE_MARKER;
    copiedThrough = end + 1;
    cursor = end;
  }
  return output + content.slice(copiedThrough);
}

function removeRawGitHubAttachmentUrls(content: string): string {
  return content.replace(
    /\bhttps?:\/\/(?:(?:www\.)?github\.com\/user-attachments\/(?:assets|files)\/|(?:private-)?user-images\.githubusercontent\.com\/)[^\s<>"'\])}]+/giu,
    IMAGE_MARKER,
  );
}

/** Keep Markdown image sources out of every model text channel until multimodal input is audited. */
export function removeMarkdownImages(content: string): string {
  const bounded = content.slice(0, MAX_IMAGE_INPUT_CHARACTERS);
  const markdown = removeMarkdownImageTokens(bounded);
  const withoutDefinitions = removeUsedReferenceDefinitions(
    markdown.content,
    markdown.usedReferenceLabels,
  );
  const sanitized = removeRawGitHubAttachmentUrls(removeRawHtmlImages(withoutDefinitions));
  return content.length <= MAX_IMAGE_INPUT_CHARACTERS ? sanitized : `${sanitized}\n${IMAGE_MARKER}`;
}

export function sanitizeUntrustedText(content: string): string {
  return redactSecrets(
    removeMarkdownImages(stripInvisibleCharacters(content).replace(/<!--[\s\S]*?-->/gu, ""))
      .replace(/(^|[^\w])@([A-Za-z0-9][A-Za-z0-9-]{0,38})/gu, "$1@\u200b$2")
      .replace(
        /\s(?:alt|title|aria-label|placeholder|data-[\w-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu,
        "",
      ),
  );
}

/** Render a repository path as inert Markdown code, never syntax or HTML. */
export function sanitizeMarkdownPath(path: string): string {
  return sanitizeUntrustedText(path)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;");
}
