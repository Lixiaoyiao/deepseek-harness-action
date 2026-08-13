import type { GitHubClient } from "../github/client.js";
import { assertPullRequestSnapshotCurrent, type PullRequestSnapshot } from "../github/fetch.js";
import { parseGitHubFilePatches } from "../diff/parse.js";
import { mapFindingToInline } from "../diff/map.js";
import type { DiffLine, DiffSide, InlineLocation, ParsedDiff } from "../diff/types.js";
import { sanitizeMarkdownPath, sanitizeUntrustedText } from "../security/redaction.js";
import { fingerprintFinding } from "./fingerprint.js";
import { filterHighPrecisionFindings } from "./precision.js";
import type { ReviewFinding, ReviewResult } from "./schema.js";
import { createTrackingMarker, indexTrackingComments, stripTrackingMarkers } from "./tracking.js";
import { upsertTrackingComment } from "../github/comments.js";

const GITHUB_BODY_LIMIT = 65_000;

export interface PublicationTarget {
  readonly owner: string;
  readonly repo: string;
  readonly pullNumber: number;
  readonly expectedAuthorId: number;
  readonly runUrl: string;
}

export interface PublicationResult {
  readonly selected: number;
  readonly inlinePublished: number;
  readonly inlineUpdated: number;
  readonly duplicatesSkipped: number;
  readonly summaryOnly: number;
  readonly failures: readonly string[];
}

function safeBody(value: string): string {
  const sanitized = sanitizeUntrustedText(stripTrackingMarkers(value));
  return sanitized.length <= GITHUB_BODY_LIMIT
    ? sanitized
    : `${sanitized.slice(0, GITHUB_BODY_LIMIT - 40)}\n\n[truncated by dsh-action]`;
}

function severityIcon(severity: ReviewFinding["severity"]): string {
  switch (severity) {
    case "critical":
      return "🔴";
    case "high":
      return "🟠";
    case "medium":
      return "🟡";
    case "low":
      return "🔵";
  }
}

function findingBody(finding: ReviewFinding, fingerprint: string): string {
  const sections = [
    createTrackingMarker({ kind: "finding", fingerprint }),
    `### ${severityIcon(finding.severity)} ${safeBody(finding.title)}`,
    safeBody(finding.body),
    finding.evidence === undefined ? "" : `**Evidence:** ${safeBody(finding.evidence)}`,
    finding.suggestion === undefined
      ? ""
      : `**Suggested change:**\n\n${safeBody(finding.suggestion)}`,
    `<sub>${finding.category} · confidence ${String(Math.round(finding.confidence * 100))}%</sub>`,
  ];
  return sections.filter(Boolean).join("\n\n").slice(0, GITHUB_BODY_LIMIT);
}

function buildDiff(snapshot: PullRequestSnapshot): ParsedDiff {
  return parseGitHubFilePatches(
    snapshot.changedFiles.map((file) => ({
      filename: file.path,
      ...(file.previousPath === undefined ? {} : { previousFilename: file.previousPath }),
      status: file.status,
      ...(file.patch === undefined ? {} : { patch: file.patch }),
      truncated: file.patchMissing || file.patchTruncated,
      binary: file.patchMissing && file.changes === 0,
    })),
  );
}

function mapFinding(diff: ParsedDiff, finding: ReviewFinding) {
  return mapFindingToInline(diff, {
    path: finding.path,
    line: finding.line,
    ...(finding.side === undefined ? {} : { side: finding.side }),
    ...(finding.startLine === undefined ? {} : { startLine: finding.startLine }),
    ...(finding.startSide === undefined ? {} : { startSide: finding.startSide }),
  });
}

function lineNumber(line: DiffLine, side: DiffSide): number | null {
  return side === "RIGHT" ? line.newLine : line.oldLine;
}

function supportsSide(line: DiffLine, side: DiffSide): boolean {
  return side === "RIGHT"
    ? line.kind !== "deletion" && line.newLine !== null
    : line.kind !== "addition" && line.oldLine !== null;
}

function lineAnchor(line: DiffLine): readonly [DiffLine["kind"], string] {
  return [line.kind, line.content];
}

/** Build a line-number-free source window that remains stable when a hunk moves. */
function findDiffAnchorContext(diff: ParsedDiff, location: InlineLocation): string | undefined {
  const file = diff.files.find(
    (candidate) => candidate.newPath === location.path || candidate.oldPath === location.path,
  );
  if (file === undefined) return undefined;

  const startLine = location.startLine ?? location.line;
  for (const hunk of file.hunks) {
    const supported = hunk.lines
      .map((line, index) => ({ index, line, number: lineNumber(line, location.side) }))
      .filter(
        (item) =>
          supportsSide(item.line, location.side) &&
          item.number !== null &&
          item.number >= startLine &&
          item.number <= location.line,
      );
    if (
      supported.length === 0 ||
      !supported.some((item) => item.number === startLine) ||
      !supported.some((item) => item.number === location.line)
    ) {
      continue;
    }

    const firstIndex = supported[0]?.index;
    const lastIndex = supported.at(-1)?.index;
    if (firstIndex === undefined || lastIndex === undefined) continue;
    const before = hunk.lines
      .slice(0, firstIndex)
      .findLast((line) => supportsSide(line, location.side));
    const after = hunk.lines.slice(lastIndex + 1).find((line) => supportsSide(line, location.side));

    return JSON.stringify({
      side: location.side,
      heading: hunk.heading,
      before: before === undefined ? null : lineAnchor(before),
      target: supported.map(({ line }) => lineAnchor(line)),
      after: after === undefined ? null : lineAnchor(after),
    });
  }
  return undefined;
}

function formatSummary(
  result: ReviewResult,
  findings: readonly ReviewFinding[],
  outcome: PublicationResult,
  target: PublicationTarget,
): string {
  const lines = [
    createTrackingMarker({ kind: "summary" }),
    "## DeepSeek Harness review",
    "",
    safeBody(result.summary),
    "",
    `**High-confidence findings:** ${String(findings.length)}`,
    `**Inline:** ${String(outcome.inlinePublished + outcome.inlineUpdated)} · **Summary-only:** ${String(outcome.summaryOnly)}`,
  ];
  if (outcome.failures.length > 0) {
    lines.push(
      "",
      "### Publication warnings",
      ...outcome.failures.map((failure) => `- ${safeBody(failure)}`),
    );
  }
  void findings;
  lines.push("", `<sub>[Workflow run](${target.runUrl}) · dsh-action</sub>`);
  return lines.join("\n").slice(0, GITHUB_BODY_LIMIT);
}

function formatSummaryWithDiff(
  result: ReviewResult,
  findings: readonly ReviewFinding[],
  outcome: PublicationResult,
  target: PublicationTarget,
  diff: ParsedDiff,
  fallbackFindings: ReadonlySet<ReviewFinding>,
): string {
  const base = formatSummary(result, findings, outcome, target);
  const summaryFindings = findings.filter(
    (finding) => mapFinding(diff, finding) === null || fallbackFindings.has(finding),
  );
  if (summaryFindings.length === 0) return base;
  const rendered = summaryFindings.map(
    (finding) =>
      `- ${severityIcon(finding.severity)} **${safeBody(finding.title)}** — \`${sanitizeMarkdownPath(finding.path)}:${String(finding.line)}\`\n  ${safeBody(finding.body)}`,
  );
  return `${base}\n\n### Findings carried in the summary\n\n${rendered.join("\n")}`.slice(
    0,
    GITHUB_BODY_LIMIT,
  );
}

export async function publishPullRequestReview(
  client: GitHubClient,
  target: PublicationTarget,
  snapshot: PullRequestSnapshot,
  result: ReviewResult,
  maxFindings: number,
): Promise<PublicationResult> {
  if (snapshot.headSha.length !== 40) throw new Error("A full immutable head SHA is required");
  const diff = buildDiff(snapshot);
  const findings = filterHighPrecisionFindings(result.findings, { maxFindings });
  const existingComments = await client.paginate(client.rest.pulls.listReviewComments, {
    owner: target.owner,
    repo: target.repo,
    pull_number: target.pullNumber,
    per_page: 100,
  });
  const existing = indexTrackingComments(existingComments, target.expectedAuthorId).findings;
  let inlinePublished = 0;
  let inlineUpdated = 0;
  let duplicatesSkipped = 0;
  let summaryOnly = 0;
  const failures: string[] = [];
  const fallbackFindings = new Set<ReviewFinding>();

  for (const finding of findings) {
    await assertPullRequestSnapshotCurrent(client, target.owner, target.repo, snapshot);
    const location = mapFinding(diff, finding);
    if (location === null) {
      summaryOnly += 1;
      continue;
    }
    const anchorContext = findDiffAnchorContext(diff, location);
    const fingerprint = fingerprintFinding({
      ...finding,
      ...(anchorContext === undefined ? {} : { anchorContext }),
    });
    const body = findingBody(finding, fingerprint);
    const prior = existing.get(fingerprint);
    const priorMatchesLocation =
      prior?.commit_id === snapshot.headSha &&
      prior.path === location.path &&
      prior.line === location.line &&
      prior.side === location.side;
    try {
      if (priorMatchesLocation) {
        if (prior.body === body) {
          duplicatesSkipped += 1;
        } else {
          await client.rest.pulls.updateReviewComment({
            owner: target.owner,
            repo: target.repo,
            comment_id: prior.id,
            body,
          });
          inlineUpdated += 1;
        }
      } else if (prior !== undefined) {
        // GitHub cannot relocate an existing inline thread to another commit.
        // Keep that thread, suppress a duplicate, and surface the current
        // location/prose in the sticky summary instead.
        duplicatesSkipped += 1;
        summaryOnly += 1;
        fallbackFindings.add(finding);
      } else {
        await client.rest.pulls.createReviewComment({
          owner: target.owner,
          repo: target.repo,
          pull_number: target.pullNumber,
          commit_id: snapshot.headSha,
          body,
          path: location.path,
          line: location.line,
          side: location.side,
          ...(location.startLine === undefined
            ? {}
            : { start_line: location.startLine, start_side: location.startSide }),
        });
        inlinePublished += 1;
      }
    } catch (error) {
      summaryOnly += 1;
      fallbackFindings.add(finding);
      failures.push(
        `${sanitizeMarkdownPath(finding.path)}:${String(finding.line)} (${safeBody(finding.title)}): ${error instanceof Error ? safeBody(error.message) : "GitHub API failure"}`,
      );
    }
  }

  const publication: PublicationResult = {
    selected: findings.length,
    inlinePublished,
    inlineUpdated,
    duplicatesSkipped,
    summaryOnly,
    failures,
  };
  await assertPullRequestSnapshotCurrent(client, target.owner, target.repo, snapshot);
  await upsertTrackingComment(
    client,
    { owner: target.owner, repo: target.repo, issueNumber: target.pullNumber },
    target.expectedAuthorId,
    "summary",
    formatSummaryWithDiff(result, findings, publication, target, diff, fallbackFindings),
  );
  return publication;
}
