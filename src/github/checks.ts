import type { GitHubClient } from "./client.js";
import { utf8Prefix, utf8Suffix } from "../security/utf8.js";

const MAX_FAILED_RUNS = 20;
const MAX_FAILED_JOBS = 100;
const MAX_FAILED_CHECKS = 100;
const MAX_LOG_BYTES_PER_JOB = 128 * 1024;
const MAX_LOG_BYTES_TOTAL = 512 * 1024;
const MAX_CHECK_SUMMARY_BYTES_PER_CHECK = 8 * 1024;
const MAX_CHECK_SUMMARY_BYTES_TOTAL = 64 * 1024;
const DEFAULT_LOG_DOWNLOAD_TIMEOUT_MS = 15_000;
const DEFAULT_ALLOWED_LOG_HOSTS = [
  "actions.githubusercontent.com",
  "github.com",
  "githubusercontent.com",
  // GitHub Actions currently also serves short-lived job logs from Azure blobs.
  "blob.core.windows.net",
] as const;
const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out"]);

export interface FailedStep {
  readonly name: string;
  readonly number: number;
}

export interface CiJobEvidence {
  readonly runId: number;
  readonly runName: string;
  readonly runUrl: string;
  readonly jobId: number;
  readonly jobName: string;
  readonly jobUrl: string;
  readonly conclusion: string;
  readonly failedSteps: readonly FailedStep[];
  readonly log: string;
  readonly logTruncated: boolean;
}

export interface CiEvidence {
  readonly headSha: string;
  readonly jobs: readonly CiJobEvidence[];
  readonly checkRuns: readonly {
    name: string;
    conclusion: string;
    detailsUrl: string | null;
    summary: string;
  }[];
  readonly truncated: boolean;
}

function sanitizeLog(value: string, secrets: readonly string[]): string {
  let sanitized = value
    // eslint-disable-next-line no-control-regex
    .replaceAll(/\u001b\[[0-9;]*m/g, "")
    .replaceAll(/\r/g, "")
    .replaceAll(/^::/gm, "\\::")
    .replaceAll(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s]+/gi, "$1[REDACTED]")
    .replaceAll(/([?&](?:access_token|token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]");
  for (const secret of secrets) {
    if (secret.length >= 4) sanitized = sanitized.replaceAll(secret, "[REDACTED]");
  }
  return sanitized;
}

function boundLog(
  value: string,
  remaining: number,
): { log: string; bytes: number; truncated: boolean } {
  const raw = Buffer.from(value, "utf8");
  const cap = Math.max(0, Math.min(MAX_LOG_BYTES_PER_JOB, remaining));
  if (raw.byteLength <= cap) return { log: value, bytes: raw.byteLength, truncated: false };
  if (cap === 0) return { log: "", bytes: 0, truncated: true };
  const marker = "\n[... log truncated by dsh-action ...]\n";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= cap) {
    const log = utf8Prefix(marker, cap);
    return { log, bytes: Buffer.byteLength(log), truncated: true };
  }
  const contentCap = cap - markerBytes;
  const headSize = Math.floor(contentCap / 3);
  const tailSize = contentCap - headSize;
  const head = utf8Prefix(raw, headSize);
  const tail = utf8Suffix(raw, tailSize);
  const log = head + marker + tail;
  return {
    log,
    bytes: Buffer.byteLength(log),
    truncated: true,
  };
}

function boundSummary(
  value: string,
  remaining: number,
): { summary: string; bytes: number; truncated: boolean } {
  const raw = Buffer.from(value, "utf8");
  const cap = Math.max(0, Math.min(MAX_CHECK_SUMMARY_BYTES_PER_CHECK, remaining));
  if (raw.byteLength <= cap) {
    return { summary: value, bytes: raw.byteLength, truncated: false };
  }
  if (cap === 0) return { summary: "", bytes: 0, truncated: true };
  const marker = "\n[... summary truncated ...]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  const summary =
    markerBytes >= cap ? utf8Prefix(marker, cap) : utf8Prefix(raw, cap - markerBytes) + marker;
  return { summary, bytes: Buffer.byteLength(summary), truncated: true };
}

function isCompletedFailure(status: string | null, conclusion: string | null): boolean {
  return status === "completed" && conclusion !== null && FAILURE_CONCLUSIONS.has(conclusion);
}

function currentRunId(value: number | undefined): number | undefined {
  if (value !== undefined) return value;
  const raw = process.env.GITHUB_RUN_ID;
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isAllowedLogUrl(value: string, allowedHosts: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return allowedHosts.some((candidate) => {
    const allowed = candidate.toLowerCase().replace(/^\*\./, "");
    return hostname === allowed || hostname.endsWith(`.${allowed}`);
  });
}

async function readResponseBody(
  response: Response,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  if (response.body === null) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  try {
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        continue;
      }
      const chunk = new Uint8Array(result.value);
      const remaining = Math.max(0, cap - bytes);
      if (chunk.byteLength > remaining) {
        if (remaining > 0) chunks.push(Buffer.from(chunk.subarray(0, remaining)));
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(chunk));
      bytes += chunk.byteLength;
      if (bytes === cap) {
        const probe = await reader.read();
        truncated = !probe.done;
        break;
      }
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const raw = Buffer.concat(chunks);
  const text = utf8Prefix(raw, raw.byteLength);
  return {
    text,
    truncated: truncated || Buffer.byteLength(text, "utf8") < raw.byteLength,
  };
}

interface DownloadJobLogOptions {
  readonly fetchImpl: typeof fetch;
  readonly timeoutMs: number;
  readonly allowedHosts: readonly string[];
  readonly byteCap: number;
}

async function downloadJobLog(
  client: GitHubClient,
  owner: string,
  repo: string,
  jobId: number,
  options: DownloadJobLogOptions,
): Promise<{ text: string; truncated: boolean }> {
  if (options.byteCap <= 0) return { text: "", truncated: true };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    // Keep the authenticated request on api.github.com and inspect the redirect
    // explicitly. Octokit must never follow it with the Authorization header.
    const response = await client.request("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs", {
      owner,
      repo,
      job_id: jobId,
      request: {
        redirect: "manual",
        parseSuccessResponseBody: false,
        signal: controller.signal,
      },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      throw new Error("unexpected GitHub log response");
    }
    const location = response.headers.location;
    if (location === undefined || !isAllowedLogUrl(location, options.allowedHosts)) {
      throw new Error("untrusted GitHub log redirect");
    }

    // Deliberately pass no headers. In particular, GITHUB_TOKEN must not be
    // forwarded to the signed storage URL.
    const logResponse = await options.fetchImpl(location, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!logResponse.ok) throw new Error("GitHub log download failed");
    return await readResponseBody(logResponse, options.byteCap);
  } finally {
    clearTimeout(timeout);
  }
}

export interface FetchCiEvidenceOptions {
  readonly headSha: string;
  readonly workflowRunId?: number;
  readonly currentRunId?: number;
  readonly secrets?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly logDownloadTimeoutMs?: number;
  readonly allowedLogHosts?: readonly string[];
}

/** Fetches bounded CI evidence in the trusted controller and binds it to owner/repo/headSha. */
export async function fetchCiEvidence(
  client: GitHubClient,
  owner: string,
  repo: string,
  options: FetchCiEvidenceOptions,
): Promise<CiEvidence> {
  const secrets = options.secrets ?? [];
  const ownRunId = currentRunId(options.currentRunId);
  const expectedRepository = `${owner}/${repo}`.toLowerCase();
  let sourceRuns;
  let runResultsTruncated = false;
  if (options.workflowRunId !== undefined) {
    sourceRuns = [
      (
        await client.rest.actions.getWorkflowRun({
          owner,
          repo,
          run_id: options.workflowRunId,
        })
      ).data,
    ];
  } else {
    const response = await client.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: options.headSha,
      status: "completed",
      per_page: 100,
    });
    sourceRuns = response.data.workflow_runs;
    runResultsTruncated = response.data.total_count > sourceRuns.length;
  }

  const eligibleRuns = sourceRuns.filter(
    (run) =>
      run.id !== ownRunId &&
      run.head_sha === options.headSha &&
      run.repository.full_name.toLowerCase() === expectedRepository &&
      isCompletedFailure(run.status, run.conclusion),
  );
  if (options.workflowRunId !== undefined && eligibleRuns.length !== 1) {
    throw new Error(
      "Workflow run is not an eligible completed failure for the target repository and SHA",
    );
  }
  const boundRuns = eligibleRuns.slice(0, MAX_FAILED_RUNS);
  let truncated = runResultsTruncated || eligibleRuns.length > boundRuns.length;

  let usedBytes = 0;
  const jobs: CiJobEvidence[] = [];
  for (const run of boundRuns) {
    if (jobs.length >= MAX_FAILED_JOBS) {
      truncated = true;
      break;
    }
    const response = await client.rest.actions.listJobsForWorkflowRun({
      owner,
      repo,
      run_id: run.id,
      per_page: 100,
    });
    const eligibleJobs = response.data.jobs.filter(
      (job) => job.head_sha === options.headSha && isCompletedFailure(job.status, job.conclusion),
    );
    if (response.data.total_count > response.data.jobs.length) truncated = true;
    for (const job of eligibleJobs) {
      if (jobs.length >= MAX_FAILED_JOBS) {
        truncated = true;
        break;
      }
      let rawLog: string;
      let downloadTruncated = false;
      try {
        const downloaded = await downloadJobLog(client, owner, repo, job.id, {
          fetchImpl: options.fetch ?? globalThis.fetch,
          timeoutMs: options.logDownloadTimeoutMs ?? DEFAULT_LOG_DOWNLOAD_TIMEOUT_MS,
          allowedHosts: options.allowedLogHosts ?? DEFAULT_ALLOWED_LOG_HOSTS,
          byteCap: Math.min(MAX_LOG_BYTES_PER_JOB, MAX_LOG_BYTES_TOTAL - usedBytes),
        });
        rawLog = downloaded.text;
        downloadTruncated = downloaded.truncated;
      } catch {
        // Do not expose signed URLs or transport errors to untrusted model input.
        rawLog = "[log unavailable: secure download failed]";
      }
      const safeLog = sanitizeLog(rawLog, secrets);
      const bounded = boundLog(safeLog, MAX_LOG_BYTES_TOTAL - usedBytes);
      usedBytes += bounded.bytes;
      const logTruncated = downloadTruncated || bounded.truncated;
      truncated ||= logTruncated;
      jobs.push({
        runId: run.id,
        runName: run.name ?? `workflow-${String(run.id)}`,
        runUrl: run.html_url,
        jobId: job.id,
        jobName: job.name,
        jobUrl: job.html_url ?? run.html_url,
        conclusion: job.conclusion ?? "unknown",
        failedSteps: (job.steps ?? [])
          .filter(({ conclusion }) => FAILURE_CONCLUSIONS.has(conclusion ?? ""))
          .map(({ name, number }) => ({ name, number })),
        log: bounded.log,
        logTruncated,
      });
    }
  }

  const checkResponse = await client.rest.checks.listForRef({
    owner,
    repo,
    ref: options.headSha,
    status: "completed",
    per_page: 100,
  });
  const eligibleChecks = checkResponse.data.check_runs.filter(
    (check) =>
      check.head_sha === options.headSha && isCompletedFailure(check.status, check.conclusion),
  );
  const selectedChecks = eligibleChecks.slice(0, MAX_FAILED_CHECKS);
  truncated ||=
    checkResponse.data.total_count > checkResponse.data.check_runs.length ||
    eligibleChecks.length > selectedChecks.length;
  let summaryBytes = 0;
  const checkRuns = selectedChecks.map((check) => {
    const bounded = boundSummary(
      sanitizeLog(check.output.summary ?? "", secrets),
      MAX_CHECK_SUMMARY_BYTES_TOTAL - summaryBytes,
    );
    summaryBytes += bounded.bytes;
    truncated ||= bounded.truncated;
    return {
      name: check.name,
      conclusion: check.conclusion ?? "unknown",
      detailsUrl: check.details_url,
      summary: bounded.summary,
    };
  });

  return { headSha: options.headSha, jobs, checkRuns, truncated };
}
