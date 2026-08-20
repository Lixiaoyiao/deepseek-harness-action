import type { GitHubClient } from "./client.js";
import { createTrackingMarker } from "../review/tracking.js";
import { upsertTrackingComment } from "./comments.js";
import { sanitizeUntrustedText } from "../security/redaction.js";

export async function publishStatusComment(
  client: GitHubClient,
  target: { owner: string; repo: string; issueNumber: number },
  authorId: number,
  title: string,
  message: string,
  runUrl: string,
  trackingKind: "task" | "write" = "write",
): Promise<void> {
  const body = [
    createTrackingMarker({ kind: trackingKind }),
    `## ${title}`,
    "",
    sanitizeUntrustedText(message.replace(/<!--\s*dsh-action:[\s\S]*?-->/giu, "")).slice(0, 60_000),
    "",
    `<sub>[Workflow run](${runUrl}) · dsh-action</sub>`,
  ].join("\n");
  await upsertTrackingComment(client, target, authorId, trackingKind, body);
}
