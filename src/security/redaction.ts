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

/** Keep Markdown image sources out of every model text channel until multimodal input is audited. */
export function removeMarkdownImages(content: string): string {
  return content
    .replace(/!\[[^\]]*\]\([^\n)]*\)/gu, "[image removed]")
    .replace(/!\[[^\]]*\]\[[^\]]*\]/gu, "[image removed]");
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
