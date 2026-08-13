import type { DshRunResult } from "../dsh/runner.js";
import type { GitHubClient } from "../github/client.js";
import { upsertTrackingComment } from "../github/comments.js";
import { createTrackingMarker, stripTrackingMarkers } from "../review/tracking.js";
import { sanitizeMarkdownPath, sanitizeUntrustedText } from "../security/redaction.js";

export async function finishDiagnosis(
  client: GitHubClient,
  target: { owner: string; repo: string; issueNumber: number },
  expectedAuthorId: number,
  result: DshRunResult,
  runUrl: string,
): Promise<void> {
  const diagnosis = sanitizeUntrustedText(
    stripTrackingMarkers(result.output.diagnosis ?? result.output.summary),
  );
  const findings = result.output.findings
    .map(
      (finding) =>
        `- **${sanitizeUntrustedText(finding.title)}** (\`${sanitizeMarkdownPath(finding.path)}:${String(finding.line)}\`) - ${sanitizeUntrustedText(finding.body)}`,
    )
    .join("\n");
  const body = [
    createTrackingMarker({ kind: "diagnosis" }),
    "## DeepSeek Harness CI diagnosis",
    "",
    diagnosis,
    findings === "" ? "" : "\n### Evidence-backed findings\n\n" + findings,
    "",
    `<sub>[Workflow run](${runUrl}) · dsh-action</sub>`,
  ]
    .filter(Boolean)
    .join("\n")
    .slice(0, 65_000);
  await upsertTrackingComment(client, target, expectedAuthorId, "diagnosis", body);
}
