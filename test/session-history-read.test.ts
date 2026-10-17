import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const route =
  "repos/octo/repo/actions/workflows/session-auto-e2e.yml/runs?event=workflow_dispatch&per_page=100&page=1";
const projection =
  '{workflow_runs: (.workflow_runs | if type == "array" then map(if type == "object" then {id, path, event, display_title, status, conclusion} else . end) else . end)} + (if has("total_count") then {total_count} else {} end)';
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function largeHistory(count = 78): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => ({
    id: 9000 - index,
    path: ".github/workflows/session-auto-e2e.yml",
    event: "workflow_dispatch",
    display_title: `dsh-session-other-${String(index)}`,
    status: "completed",
    conclusion: "success",
    repository: { full_name: "octo/repo", description: "unused repository metadata ".repeat(600) },
    head_repository: { full_name: "octo/repo", description: "unused metadata ".repeat(300) },
  }));
}

function selectedRun(extra: Record<string, unknown> = {}) {
  return {
    id: 9100,
    run_attempt: 1,
    path: ".github/workflows/session-auto-e2e.yml",
    event: "workflow_dispatch",
    display_title: "dsh-session-history-key",
    status: "completed",
    conclusion: "success",
    head_sha: "d".repeat(40),
    head_branch: "main",
    repository: { full_name: "octo/repo" },
    head_repository: { full_name: "octo/repo" },
    ...extra,
  };
}

/** Real released Session codec/archive; all data is synthetic and contains no credentials. */
function resumableResponses() {
  const memory = "a".repeat(48);
  const challenge = "b".repeat(24);
  const sessionId = "session-11111111-1111-4111-8111-111111111111";
  const createdAt = Date.parse("2026-10-04T01:00:00Z");
  const payload = Buffer.from(
    [
      sessionFormatCatalog.encodeCurrentHeader(
        {
          version: 4,
          id: sessionId,
          createdAt,
          cwd: "/workspace",
          isSeeded: false,
          delegationDepth: 0,
        },
        0,
      ),
      ...[
        { type: "permission/preset", data: { preset: "workspace-write" } },
        { type: "sandbox/mode", data: { mode: "workspace-write" } },
        { type: "approval/policy", data: { policy: "never" } },
        { type: "turn/start", data: { turn: 1 } },
        {
          type: "user/message",
          data: {
            id: "message-1",
            role: "user",
            content: [{ type: "text", text: `${memory} ${challenge}` }],
            source: { kind: "user" },
          },
          surfaceOp: "append",
        },
        { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
      ].map((event, seq) => ({ ...event, seq, time: createdAt + seq })),
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
  );
  const manifest = {
    schemaVersion: 1,
    repository: { owner: "octo", repo: "repo" },
    workflow: {
      path: ".github/workflows/session-auto-e2e.yml",
      jobId: "session",
      jobName: "session",
      runId: 9100,
      runAttempt: 1,
      sourceSha: "d".repeat(40),
    },
    runtime: { dshVersion: "0.2.1-rc.2", mode: "controlled" },
    session: { sessionId, generation: 1, keyHash: hash("history-key") },
    payload: { file: "session.jsonl", bytes: payload.length, sha256: hash(payload) },
  };
  const archive = zipSync({
    "manifest.json": Buffer.from(JSON.stringify(manifest)),
    "session.jsonl": payload,
  });
  const proof = {
    schemaVersion: 1,
    qualified: true,
    phase: "save",
    generation: 1,
    repository: "octo/repo",
    runId: 9100,
    runAttempt: 1,
    candidateSha: "c".repeat(40),
    harnessSha: "d".repeat(40),
    dshMode: "controlled",
    keyHash: hash("history-key"),
    memory,
    challenge,
    sessionId,
    artifactId: 30,
    payloadSha256: hash(payload),
  };
  const proofZip = zipSync({ "proof.json": Buffer.from(JSON.stringify(proof)) });
  return {
    [route]: { total_count: 79, workflow_runs: [selectedRun(), ...largeHistory()] },
    "repos/octo/repo/actions/runs/9100": selectedRun(),
    "repos/octo/repo/actions/runs/9100/artifacts?per_page=100": {
      total_count: 1,
      artifacts: [
        {
          id: 31,
          name: "session-e2e-proof-9100-1",
          size_in_bytes: proofZip.length,
          expired: false,
        },
      ],
    },
    "repos/octo/repo/actions/artifacts/31/zip": {
      archive: Buffer.from(proofZip).toString("base64"),
    },
    "repos/octo/repo/actions/artifacts/30/zip": {
      archive: Buffer.from(archive).toString("base64"),
    },
  };
}

async function prepare(
  responses: Record<string, unknown>,
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "dsh-session-history-read-"));
  roots.push(root);
  const responseFile = join(root, "responses.json");
  const callsFile = join(root, "calls.jsonl");
  await writeFile(responseFile, JSON.stringify(responses));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve("test/fixtures/session-history-gh-preload.mjs")).href,
      resolve(".github/e2e/session-auto-e2e-proof.mjs"),
      "prepare",
    ],
    {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 65_536,
      env: {
        ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
        RUNNER_TEMP: root,
        GITHUB_WORKSPACE: join(root, "workspace"),
        GITHUB_REPOSITORY: "octo/repo",
        GITHUB_RUN_ID: "10000",
        GITHUB_RUN_ATTEMPT: "1",
        CANDIDATE_SHA: "c".repeat(40),
        HARNESS_SHA: "d".repeat(40),
        DSH_MODE: "controlled",
        SESSION_KEY: "history-key",
        DEFAULT_BRANCH: "main",
        PHASE: "auto",
        GITHUB_OUTPUT: join(root, "output"),
        SESSION_TEST_GH_RESPONSES: responseFile,
        SESSION_TEST_GH_CALLS: callsFile,
        ...environment,
      },
    },
  );
  const calls: unknown[] = (await readFile(callsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
  return { root, result, calls };
}

describe("Session history preparation through the public CLI", () => {
  it("prepares a first save when 78 full workflow records exceed the transport buffer", async () => {
    const response = { total_count: 78, workflow_runs: largeHistory() };
    expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(1024 * 1024);
    const value = await prepare({ [route]: response });
    expect(value.result.error).toBeUndefined();
    expect(
      value.result.status,
      JSON.stringify({ stderr: value.result.stderr, calls: value.calls }),
    ).toBe(0);
    expect(value.result.stderr).toBe("");
    const evidence: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/evidence/preparation.json"), "utf8"),
    );
    expect(evidence).toMatchObject({
      phase: "save",
      historyStatus: "first",
      fixtureRequests: { apiCommands: 1, retries: 0 },
    });
    expect(value.calls).toHaveLength(1);
    expect(value.calls[0]).toMatchObject({ maxBuffer: 1024 * 1024, timeout: 30_000 });
  });

  it("retains explicit save and GET arguments for 100 large records without copying repository data", async () => {
    const value = await prepare(
      { [route]: { total_count: 100, workflow_runs: largeHistory(100) } },
      { PHASE: "save" },
    );
    expect(value.result.status).toBe(0);
    expect(value.calls).toEqual([
      {
        args: ["api", "--method", "GET", route, "--jq", projection],
        maxBuffer: 1048576,
        timeout: 30000,
      },
    ]);
    const expected: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/expected.json"), "utf8"),
    );
    expect(expected).toMatchObject({ phase: "save", generation: 1 });
    expect(JSON.stringify(expected)).not.toContain("unused repository metadata");
  });

  it("resumes the selected successful source through full provenance, proof and released checkpoint validation", async () => {
    const value = await prepare(resumableResponses());
    expect(value.result.status, value.result.stderr).toBe(0);
    const expected: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/expected.json"), "utf8"),
    );
    expect(expected).toMatchObject({
      phase: "resume",
      sourceRunId: 9100,
      generation: 2,
      memory: "a".repeat(48),
    });
    const preparation: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/evidence/preparation.json"), "utf8"),
    );
    expect(preparation).toMatchObject({
      historyStatus: "success",
      fixtureRequests: { apiCommands: 5, retries: 0 },
    });
    expect(value.calls.slice(1)).toEqual([
      {
        args: ["api", "--method", "GET", "repos/octo/repo/actions/runs/9100"],
        maxBuffer: 1048576,
        timeout: 30000,
      },
      {
        args: [
          "api",
          "--method",
          "GET",
          "repos/octo/repo/actions/runs/9100/artifacts?per_page=100",
        ],
        maxBuffer: 1048576,
        timeout: 30000,
      },
      {
        args: ["api", "--method", "GET", "repos/octo/repo/actions/artifacts/31/zip"],
        maxBuffer: 4259840,
        timeout: 30000,
      },
      {
        args: ["api", "--method", "GET", "repos/octo/repo/actions/artifacts/30/zip"],
        maxBuffer: 4259840,
        timeout: 30000,
      },
    ]);
  });

  it.each([
    { status: "completed", conclusion: "failure" },
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: null },
  ])(
    "rejects latest unsuccessful history without falling back to an older success: %j",
    async (latest) => {
      const value = await prepare({
        [route]: {
          total_count: 80,
          workflow_runs: [selectedRun({ id: 9101, ...latest }), selectedRun(), ...largeHistory()],
        },
      });
      expect(value.result.status).toBe(1);
      expect(value.result.stderr).toBe("SESSION_E2E_HISTORY_NOT_SUCCESSFUL\n");
      expect(value.calls).toHaveLength(1);
      await expect(readFile(join(value.root, "output"))).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    { id: 9101 },
    { run_attempt: 0 },
    { status: "in_progress" },
    { conclusion: "failure" },
    { event: "push" },
    { path: ".github/workflows/foreign.yml" },
    { head_sha: "e".repeat(40) },
    { head_branch: "foreign" },
    { repository: { full_name: "foreign/repo" } },
    { head_repository: { full_name: "foreign/repo" } },
  ])("rejects independently re-read source identity conflict %j", async (changed) => {
    const value = await prepare({
      [route]: { total_count: 79, workflow_runs: [selectedRun(), ...largeHistory()] },
      "repos/octo/repo/actions/runs/9100": selectedRun(changed),
    });
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toBe("SESSION_E2E_SOURCE_RUN\n");
    expect(value.calls).toHaveLength(2);
  });

  it("ignores foreign workflow, event, key, future/current IDs and invalid non-object headers", async () => {
    const ignored = [
      selectedRun({ path: ".github/workflows/foreign.yml" }),
      selectedRun({ event: "push" }),
      selectedRun({ display_title: "dsh-session-foreign" }),
      selectedRun({ id: 10000 }),
      selectedRun({ id: 10001 }),
      selectedRun({ id: "9100" }),
      null,
      false,
      42,
      [],
    ];
    const value = await prepare({
      [route]: { total_count: 88, workflow_runs: [...ignored, ...largeHistory()] },
    });
    expect(value.result.status, value.result.stderr).toBe(0);
    const evidence: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/evidence/preparation.json"), "utf8"),
    );
    expect(evidence).toMatchObject({ phase: "save", historyStatus: "first" });
  });

  it.each([null, false, 42, {}])(
    "keeps invalid workflow_runs shape %j closed",
    async (workflow_runs) => {
      const value = await prepare({ [route]: { total_count: 0, workflow_runs } });
      expect(value.result.status).toBe(1);
      expect(value.result.stderr).toBe("SESSION_E2E_HISTORY_BOUND\n");
      expect(value.calls).toHaveLength(1);
    },
  );

  it("keeps missing workflow_runs closed", async () => {
    const value = await prepare({ [route]: { total_count: 0 } });
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toBe("SESSION_E2E_HISTORY_BOUND\n");
  });

  it("keeps missing total_count closed instead of normalizing it into a valid empty history", async () => {
    const value = await prepare({ [route]: { workflow_runs: [] } });
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toBe("SESSION_E2E_HISTORY_BOUND\n");
    expect(value.calls).toHaveLength(1);
  });

  it("bases repository provenance on the independent source read rather than ignored list metadata", async () => {
    const responses = resumableResponses();
    responses[route].workflow_runs[0] = selectedRun({
      repository: { full_name: "foreign/repo" },
      head_repository: { full_name: "foreign/repo" },
    });
    const value = await prepare(responses);
    expect(value.result.status, value.result.stderr).toBe(0);
    const expected: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/expected.json"), "utf8"),
    );
    expect(expected).toMatchObject({ phase: "resume", sourceRunId: 9100, generation: 2 });
  });

  it("reads all ten 100-record pages within the original history and request bounds", async () => {
    const responses = Object.fromEntries(
      Array.from({ length: 10 }, (_, page) => [
        route.replace("&page=1", `&page=${String(page + 1)}`),
        { total_count: 1000, workflow_runs: largeHistory(100) },
      ]),
    );
    const value = await prepare(responses);
    expect(value.result.status, value.result.stderr).toBe(0);
    expect(value.calls).toHaveLength(10);
    const evidence: unknown = JSON.parse(
      await readFile(join(value.root, "session-e2e/evidence/preparation.json"), "utf8"),
    );
    expect(evidence).toMatchObject({
      fixtureRequests: { apiCommands: 10, retries: 0 },
      historyStatus: "first",
    });
  });

  it("rejects a declared 1001-run history after one bounded request", async () => {
    const value = await prepare({
      [route]: { total_count: 1001, workflow_runs: largeHistory(100) },
    });
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toBe("SESSION_E2E_HISTORY_BOUND\n");
    expect(value.calls).toHaveLength(1);
  });

  it("does not request an eleventh page when ten pages leave history incomplete", async () => {
    const responses = Object.fromEntries(
      Array.from({ length: 10 }, (_, page) => [
        route.replace("&page=1", `&page=${String(page + 1)}`),
        { total_count: 1000, workflow_runs: largeHistory(99) },
      ]),
    );
    const value = await prepare(responses);
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toBe("SESSION_E2E_HISTORY_BOUND\n");
    expect(value.calls).toHaveLength(10);
  });

  it("still refuses a projected response above 1 MiB with no retry", async () => {
    const value = await prepare({
      [route]: {
        total_count: 1,
        workflow_runs: [selectedRun({ display_title: "x".repeat(1024 * 1024 + 1) })],
      },
    });
    expect(value.result.status).toBe(1);
    expect(value.result.stderr).toBe("SESSION_E2E_GITHUB_READ_FAILED_NO_RETRY\n");
    expect(value.calls).toHaveLength(1);
    expect(value.calls[0]).toMatchObject({ maxBuffer: 1048576, errorCode: "ENOBUFS" });
  });
});
