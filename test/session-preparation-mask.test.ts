import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

const roots: string[] = [];
const memory = "a".repeat(48);
const challenge = "b".repeat(24);
const sessionId = "session-11111111-1111-4111-8111-111111111111";
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Synthetic server data goes through the public preparation CLI and actual Session codec. */
function sourceResponses(automatic: boolean, resume: boolean) {
  const workflow = automatic ? "session-auto-e2e.yml" : "session-e2e.yml";
  const keyHash = hash("mask-key");
  const now = Date.now();
  const payload = Buffer.from(
    [
      sessionFormatCatalog.encodeCurrentHeader(
        {
          version: 4,
          id: sessionId,
          createdAt: now,
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
      ].map((row, seq) => ({ ...row, seq, time: now + seq })),
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );
  const archive = zipSync({
    "manifest.json": Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        repository: { owner: "octo", repo: "repo" },
        workflow: {
          path: `.github/workflows/${workflow}`,
          jobId: "session",
          jobName: "session",
          runId: 10,
          runAttempt: 1,
          sourceSha: "d".repeat(40),
        },
        runtime: { dshVersion: "0.2.0-rc.2", mode: "controlled" },
        session: { sessionId, generation: 1, keyHash },
        payload: { file: "session.jsonl", bytes: payload.length, sha256: hash(payload) },
      }),
    ),
    "session.jsonl": payload,
  });
  const proof = {
    schemaVersion: 1,
    qualified: true,
    phase: "save",
    generation: 1,
    repository: "octo/repo",
    runId: 10,
    runAttempt: 1,
    candidateSha: "c".repeat(40),
    harnessSha: "d".repeat(40),
    dshMode: "controlled",
    keyHash,
    memory,
    challenge,
    sessionId,
    artifactId: 30,
    payloadSha256: hash(payload),
  };
  const proofZip = zipSync({ "proof.json": Buffer.from(JSON.stringify(proof)) });
  const source = {
    id: 10,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    path: `.github/workflows/${workflow}`,
    head_sha: "d".repeat(40),
    head_branch: "main",
    display_title: "dsh-session-mask-key",
    repository: { full_name: "octo/repo" },
    head_repository: { full_name: "octo/repo" },
  };
  return {
    [`repos/octo/repo/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=100&page=1`]:
      {
        total_count: resume ? 1 : 0,
        workflow_runs: resume ? [source] : [],
      },
    "repos/octo/repo/actions/runs/10": source,
    "repos/octo/repo/actions/runs/10/artifacts?per_page=100": {
      total_count: 1,
      artifacts: [
        { id: 31, name: "session-e2e-proof-10-1", size_in_bytes: proofZip.length, expired: false },
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

describe("Session preparation keeps hidden oracle values out of subsequent runner logs", () => {
  it.each([
    { automatic: false, phase: "save" },
    { automatic: false, phase: "resume" },
    { automatic: true, phase: "save" },
    { automatic: true, phase: "resume" },
  ])(
    "registers masks while preserving original same-job outputs ($automatic/$phase)",
    async ({ automatic, phase }) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-session-mask-"));
      roots.push(root);
      const responses = join(root, "responses.json");
      const preload = join(root, "transport.mjs");
      const output = join(root, "github-output");
      await writeFile(responses, JSON.stringify(sourceResponses(automatic, phase === "resume")));
      await writeFile(
        preload,
        `
import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const responses = JSON.parse(readFileSync(process.env.SESSION_TEST_GH_RESPONSES, "utf8"));
childProcess.execFileSync = (command, args) => {
  if (command !== "gh" || args[0] !== "api" || args[1] !== "--method" || args[2] !== "GET")
    throw new Error("Unexpected external transport");
  const value = responses[args[3]];
  if (value === undefined) throw new Error("Unexpected GitHub GET");
  return value.archive === undefined ? Buffer.from(JSON.stringify(value)) : Buffer.from(value.archive, "base64");
};
syncBuiltinESMExports();
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(preload).href,
          resolve(
            `.github/e2e/${automatic ? "session-auto-e2e-proof.mjs" : "session-e2e-proof.mjs"}`,
          ),
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
            GITHUB_RUN_ID: "11",
            GITHUB_RUN_ATTEMPT: "1",
            CANDIDATE_SHA: "c".repeat(40),
            HARNESS_SHA: "d".repeat(40),
            DSH_MODE: "controlled",
            SESSION_KEY: "mask-key",
            DEFAULT_BRANCH: "main",
            PHASE: phase,
            SOURCE_RUN_ID: phase === "resume" ? "10" : "",
            GITHUB_OUTPUT: output,
            SESSION_TEST_GH_RESPONSES: responses,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const expected = z
        .object({ memory: z.string(), challenge: z.string(), phase: z.string() })
        .parse(JSON.parse(await readFile(join(root, "session-e2e", "expected.json"), "utf8")));
      expect(result.stdout).toBe(
        `::add-mask::${expected.memory}\n::add-mask::${expected.challenge}\n`,
      );
      const originalOutput = await readFile(output, "utf8");
      expect(originalOutput).toContain(expected.challenge);
      expect(originalOutput).not.toContain("***");
      expect(expected.phase).toBe(phase);
      if (phase === "resume") {
        expect(expected.memory).toBe(memory);
        expect(originalOutput).not.toContain(memory);
      } else expect(originalOutput).toContain(expected.memory);
      const safeEvidence = await readFile(
        join(root, "session-e2e", "evidence", "preparation.json"),
        "utf8",
      );
      expect(safeEvidence).not.toContain(expected.memory);
      expect(safeEvidence).not.toContain(expected.challenge);
    },
  );
});
