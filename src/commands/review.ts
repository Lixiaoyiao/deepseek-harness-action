import type { DshRunResult } from "../dsh/runner.js";
import type { GitHubClient } from "../github/client.js";
import type { PullRequestSnapshot } from "../github/fetch.js";
import { publishPullRequestReview, type PublicationResult } from "../review/publisher.js";

export async function finishReview(
  client: GitHubClient,
  target: {
    owner: string;
    repo: string;
    pullNumber: number;
    expectedAuthorId: number;
    runUrl: string;
  },
  snapshot: PullRequestSnapshot,
  result: DshRunResult,
  maxFindings: number,
): Promise<PublicationResult> {
  return publishPullRequestReview(
    client,
    target,
    snapshot,
    {
      operation: result.output.operation,
      summary: result.output.summary,
      findings: result.output.findings,
      ...(result.output.diagnosis === undefined ? {} : { diagnosis: result.output.diagnosis }),
      ...(result.output.changePlan === undefined ? {} : { changes: result.output.changePlan }),
      ...(result.output.verification === undefined ? {} : { tests: result.output.verification }),
    },
    maxFindings,
  );
}
