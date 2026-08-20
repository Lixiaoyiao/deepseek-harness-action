import { createHash } from "node:crypto";

export interface IssueContentIdentityInput {
  readonly number: number;
  readonly title: string;
  readonly body: string | null | undefined;
  readonly authorId: number | null | undefined;
}

/**
 * Bind the issue fields that shape an Issue -> PR task. Comments are excluded:
 * the controller's own sticky progress comment advances issue.updated_at and
 * must not invalidate the immutable title/body snapshot.
 */
export function issueContentFingerprint(input: IssueContentIdentityInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "dsh-issue-content-v1",
        input.number,
        input.title,
        input.body ?? "",
        input.authorId ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}
