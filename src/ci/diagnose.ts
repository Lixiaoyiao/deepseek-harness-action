import type { CiEvidence } from "../github/checks.js";

export function formatCiEvidence(evidence: CiEvidence): string {
  return JSON.stringify(
    {
      trust: "UNTRUSTED_CI_DATA",
      headSha: evidence.headSha,
      truncated: evidence.truncated,
      checks: evidence.checkRuns,
      failedJobs: evidence.jobs,
    },
    null,
    2,
  );
}
