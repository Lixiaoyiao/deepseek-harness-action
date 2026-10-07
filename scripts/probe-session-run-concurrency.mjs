import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Compare actual producer execution intervals, never the gate job or workflow queue timestamp. */
export function inspectSessionRunConcurrency(first, second, relation) {
  assert.ok(["same-key", "different-key"].includes(relation), "Invalid expected key relation");
  for (const run of [first, second]) {
    assert.match(run.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
    assert.match(run.headSha, /^[a-f0-9]{40}$/u);
    assert.match(run.title, /^dsh-session-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
    assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
    assert.equal(run.conclusion, "success", "Both qualified runs must finish successfully");
    assert.ok(
      Number.isFinite(Date.parse(run.startedAt)) && Number.isFinite(Date.parse(run.completedAt)),
    );
    assert.ok(Date.parse(run.completedAt) > Date.parse(run.startedAt));
  }
  assert.notEqual(first.id, second.id);
  assert.equal(first.repository, second.repository);
  assert.equal(first.headSha, second.headSha);
  const sameKey = first.title.toLowerCase() === second.title.toLowerCase();
  assert.equal(
    sameKey,
    relation === "same-key",
    "Run titles must prove the requested key relation",
  );
  const overlapMilliseconds =
    Math.min(Date.parse(first.completedAt), Date.parse(second.completedAt)) -
    Math.max(Date.parse(first.startedAt), Date.parse(second.startedAt));
  if (sameKey) assert.ok(overlapMilliseconds <= 0, "Same-key producer jobs overlapped");
  else assert.ok(overlapMilliseconds > 0, "Different-key producer jobs did not overlap");
  return { schemaVersion: 1, qualified: true, relation, overlapMilliseconds, first, second };
}

function readRun(repository, runId) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);
  assert.match(runId, /^[1-9][0-9]*$/u);
  const read = (path) =>
    JSON.parse(
      execFileSync("gh", ["api", "--method", "GET", path], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }).toString("utf8"),
    );
  const run = read(`repos/${repository}/actions/runs/${runId}`);
  assert.equal(run.id, Number(runId));
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository.full_name, repository);
  assert.equal(run.path, ".github/workflows/session-e2e.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.status, "completed");
  const jobs = read(
    `repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  assert.ok(jobs.total_count <= 100);
  const producers = jobs.jobs.filter((job) => job.name === "session");
  assert.equal(producers.length, 1);
  const job = producers[0];
  assert.equal(job.status, "completed");
  assert.equal(job.conclusion, "success");
  assert.equal(job.head_sha, run.head_sha);
  return {
    repository,
    id: run.id,
    attempt: run.run_attempt,
    title: run.display_title,
    headSha: run.head_sha,
    conclusion: run.conclusion,
    jobId: job.id,
    startedAt: job.started_at,
    completedAt: job.completed_at,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repository, firstId, secondId, relation, output] = process.argv.slice(2);
  const evidence = inspectSessionRunConcurrency(
    readRun(repository, firstId),
    readRun(repository, secondId),
    relation,
  );
  if (output) await writeFile(resolve(output), JSON.stringify(evidence, null, 2) + "\n");
  process.stdout.write(JSON.stringify(evidence) + "\n");
}
