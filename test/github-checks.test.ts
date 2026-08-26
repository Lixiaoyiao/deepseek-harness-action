import { ReadableStream } from "node:stream/web";

import { describe, expect, it, vi } from "vitest";

import { fetchCiEvidence } from "../src/github/checks.js";
import type { GitHubClient } from "../src/github/client.js";

const SHA = "a".repeat(40);

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    name: "CI",
    status: "completed",
    conclusion: "failure",
    head_sha: SHA,
    html_url: "https://github.com/octo/repo/actions/runs/10",
    repository: { full_name: "octo/repo" },
    ...overrides,
  };
}

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    name: "test",
    status: "completed",
    conclusion: "failure",
    head_sha: SHA,
    html_url: "https://github.com/octo/repo/actions/jobs/20",
    steps: [{ name: "npm test", number: 2, conclusion: "failure" }],
    ...overrides,
  };
}

function check(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    name: "external check",
    status: "completed",
    conclusion: "failure",
    head_sha: SHA,
    details_url: "https://checks.example.test/30",
    output: { summary: "failed" },
    ...overrides,
  };
}

interface ClientOptions {
  readonly runs?: readonly Record<string, unknown>[];
  readonly jobs?: readonly Record<string, unknown>[];
  readonly checks?: readonly Record<string, unknown>[];
  readonly redirect?: string;
}

function fakeClient(options: ClientOptions = {}) {
  const runs = [...(options.runs ?? [run()])];
  const jobs = [...(options.jobs ?? [job()])];
  const checks = [...(options.checks ?? [check()])];
  const request = vi.fn().mockResolvedValue({
    status: 302,
    headers: {
      location:
        options.redirect ??
        "https://pipelines.actions.githubusercontent.com/logs/job.txt?sig=do-not-expose",
    },
  });
  const client = {
    request,
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({ data: runs[0] }),
        listWorkflowRunsForRepo: vi.fn().mockResolvedValue({
          data: { total_count: runs.length, workflow_runs: runs },
        }),
        listJobsForWorkflowRun: vi.fn().mockResolvedValue({
          data: { total_count: jobs.length, jobs },
        }),
      },
      checks: {
        listForRef: vi.fn().mockResolvedValue({
          data: { total_count: checks.length, check_runs: checks },
        }),
      },
    },
  };
  return { client: client as unknown as GitHubClient, request, rest: client.rest };
}

describe("CI evidence broker", () => {
  it("keeps only completed failure/timed_out evidence bound to repo and SHA, excluding itself", async () => {
    const runs = [
      run({ id: 1, conclusion: "failure" }),
      run({ id: 2, conclusion: "timed_out" }),
      run({ id: 3, conclusion: "cancelled" }),
      run({ id: 4, status: "in_progress", conclusion: null }),
      run({ id: 5, head_sha: "b".repeat(40) }),
      run({ id: 6, repository: { full_name: "octo/other" } }),
    ];
    const jobs = [
      job({ id: 21, conclusion: "failure" }),
      job({ id: 22, conclusion: "timed_out" }),
      job({ id: 23, conclusion: "cancelled" }),
      job({ id: 24, status: "in_progress", conclusion: null }),
      job({ id: 25, head_sha: "b".repeat(40) }),
    ];
    const checks = [
      check({ id: 31, conclusion: "failure" }),
      check({ id: 32, conclusion: "timed_out" }),
      check({ id: 33, conclusion: "action_required" }),
      check({ id: 34, status: "in_progress", conclusion: null }),
      check({ id: 35, head_sha: "b".repeat(40) }),
    ];
    const { client, rest } = fakeClient({ runs, jobs, checks });

    const evidence = await fetchCiEvidence(client, "octo", "repo", {
      headSha: SHA,
      currentRunId: 2,
      fetch: vi.fn().mockResolvedValue(new Response("safe log")),
    });

    expect(evidence.jobs.map(({ jobId }) => jobId)).toEqual([21, 22]);
    expect(evidence.checkRuns.map(({ conclusion }) => conclusion)).toEqual([
      "failure",
      "timed_out",
    ]);
    expect(rest.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
    expect(rest.checks.listForRef).toHaveBeenCalledWith(
      expect.objectContaining({ ref: SHA, status: "completed", per_page: 100 }),
    );
  });

  it("fails closed when an explicitly selected workflow run is not an eligible bound failure", async () => {
    for (const selectedRun of [
      run({ conclusion: "cancelled" }),
      run({ status: "in_progress", conclusion: null }),
      run({ head_sha: "b".repeat(40) }),
      run({ repository: { full_name: "octo/other" } }),
    ]) {
      const { client } = fakeClient({ runs: [selectedRun] });
      await expect(
        fetchCiEvidence(client, "octo", "repo", {
          headSha: SHA,
          workflowRunId: 10,
          fetch: vi.fn(),
        }),
      ).rejects.toThrow("not an eligible completed failure");
    }
  });

  it("uses a manual GitHub redirect then downloads without forwarding credentials", async () => {
    const { client, request } = fakeClient();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("hello\n"));

    const evidence = await fetchCiEvidence(client, "octo", "repo", {
      headSha: SHA,
      fetch: fetchImpl,
    });

    expect(request).toHaveBeenCalledTimes(1);
    const apiCall = request.mock.calls[0];
    expect(apiCall?.[0]).toBe("GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs");
    const apiOptions = apiCall?.[1] as
      | {
          owner?: unknown;
          repo?: unknown;
          job_id?: unknown;
          request?: {
            redirect?: unknown;
            parseSuccessResponseBody?: unknown;
            signal?: unknown;
          };
        }
      | undefined;
    expect(apiOptions).toMatchObject({
      owner: "octo",
      repo: "repo",
      job_id: 20,
      request: { redirect: "manual", parseSuccessResponseBody: false },
    });
    expect(apiOptions?.request?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("pipelines.actions.githubusercontent.com"),
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    const secondRequest = fetchImpl.mock.calls[0]?.[1];
    expect(secondRequest).toBeDefined();
    if (secondRequest === undefined) throw new Error("expected signed log fetch");
    expect(secondRequest.headers).toBeUndefined();
    expect(evidence.jobs[0]?.log).toBe("hello\n");
  });

  it("rejects non-HTTPS and unapproved redirect hosts without exposing their URL", async () => {
    for (const redirect of [
      "http://pipelines.actions.githubusercontent.com/logs?sig=secret",
      "https://actions.githubusercontent.com.evil.example/logs?sig=secret",
      "https://user:pass@actions.githubusercontent.com/logs?sig=secret",
    ]) {
      const { client } = fakeClient({ redirect });
      const fetchImpl = vi.fn();
      const evidence = await fetchCiEvidence(client, "octo", "repo", {
        headSha: SHA,
        fetch: fetchImpl,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(evidence.jobs[0]?.log).toBe("[log unavailable: secure download failed]");
      expect(JSON.stringify(evidence)).not.toContain("sig=secret");
    }
  });

  it("aborts slow signed-log downloads and returns a generic error", async () => {
    const { client } = fakeClient();
    const fetchImpl: typeof fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("secret URL", "AbortError")),
        );
      });
    });
    const evidence = await fetchCiEvidence(client, "octo", "repo", {
      headSha: SHA,
      fetch: fetchImpl,
      logDownloadTimeoutMs: 5,
    });
    expect(evidence.jobs[0]?.log).toBe("[log unavailable: secure download failed]");
  });

  it("streams logs into the byte cap and caps aggregate check summaries", async () => {
    const logChunk = Buffer.concat([
      new Uint8Array(128 * 1024 - 1).fill(97),
      Buffer.from("🙂", "utf8"),
      new Uint8Array(72 * 1024).fill(97),
    ]);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(logChunk);
            controller.close();
          },
        }),
      ),
    );
    const checks = Array.from({ length: 101 }, (_, index) =>
      check({
        id: index,
        name: `check-${String(index)}`,
        output: { summary: "界".repeat(10_000) },
      }),
    );
    const { client } = fakeClient({ checks });

    const evidence = await fetchCiEvidence(client, "octo", "repo", {
      headSha: SHA,
      fetch: fetchImpl,
    });

    expect(Buffer.byteLength(evidence.jobs[0]?.log ?? "", "utf8")).toBeLessThanOrEqual(128 * 1024);
    expect(evidence.jobs[0]?.log).not.toContain("\uFFFD");
    expect(evidence.jobs[0]?.logTruncated).toBe(true);
    expect(evidence.checkRuns).toHaveLength(100);
    expect(
      evidence.checkRuns.reduce((total, item) => total + Buffer.byteLength(item.summary), 0),
    ).toBeLessThanOrEqual(64 * 1024);
    expect(evidence.checkRuns.some(({ summary }) => summary.includes("�"))).toBe(false);
    expect(evidence.truncated).toBe(true);
  });

  it("limits failed runs and failed jobs before further API and log downloads", async () => {
    const runs = Array.from({ length: 25 }, (_, index) => run({ id: 100 + index }));
    const jobs = Array.from({ length: 120 }, (_, index) => job({ id: 1_000 + index }));
    const { client, request, rest } = fakeClient({ runs, jobs, checks: [] });

    const evidence = await fetchCiEvidence(client, "octo", "repo", {
      headSha: SHA,
      fetch: vi.fn().mockResolvedValue(new Response("x")),
    });

    expect(rest.actions.listJobsForWorkflowRun).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(100);
    expect(evidence.jobs).toHaveLength(100);
    expect(evidence.truncated).toBe(true);
  });
});
