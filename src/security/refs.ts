/*
 * Adapted from anthropics/claude-code-action, MIT licensed.
 * See THIRD_PARTY_NOTICES.md.
 */

/** Validate an unqualified branch name before passing it as a Git argv value. */
export function validateRefName(refName: string): string {
  if (refName.trim() === "") throw new Error("Ref name cannot be empty");
  if (refName.startsWith("-")) throw new Error("Ref name cannot start with a dash");
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f ~^:?*[\]\\]/u.test(refName)) {
    throw new Error("Ref name contains a control, space, or reserved Git character");
  }
  if (!/^[A-Za-z0-9@_][A-Za-z0-9/_.#+,@-]*$/u.test(refName)) {
    throw new Error("Ref name contains an unsupported character");
  }
  if (refName.startsWith(".") || refName.endsWith(".")) {
    throw new Error("Ref name cannot start or end with a period");
  }
  if (refName.endsWith("/")) throw new Error("Ref name cannot end with a slash");
  if (refName.includes("//")) throw new Error("Ref name cannot contain consecutive slashes");
  if (refName.includes("..")) throw new Error("Ref name cannot contain '..'");
  const components = refName.split("/");
  if (components.some((component) => component.startsWith("."))) {
    throw new Error("Ref name components cannot start with a period");
  }
  if (components.some((component) => component.endsWith(".lock"))) {
    throw new Error("Ref name components cannot end with '.lock'");
  }
  if (refName.includes("@{")) throw new Error("Ref name cannot contain '@{'");
  if (refName === "@") throw new Error("Ref name cannot be the single character '@'");
  return refName;
}

export function validateCommitSha(sha: string): string {
  if (!/^[0-9a-f]{40}$/iu.test(sha)) throw new Error("Invalid full commit SHA");
  return sha.toLowerCase();
}
