import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../.github/e2e/mcp-proof-evidence.mjs", import.meta.url));
const proof = "a1".repeat(24);
const modelText = "model-authored-text-must-not-be-reported";

describe("bounded MCP proof evidence", () => {
  it.each([true, false])(
    "records proofMatches=%s without reporting model text or either proof",
    async (matches) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-mcp-proof-evidence-"));
      try {
        const evidence = join(root, "evidence.json");
        const endpoint = join(root, "endpoint.json");
        const audit = join(root, "audit.jsonl");
        const summary = join(root, "summary.md");
        const returnedProof = matches ? proof : "b2".repeat(24);
        await writeFile(endpoint, JSON.stringify({ expectedProof: proof }));
        await writeFile(
          audit,
          JSON.stringify({ tool: "echo", input: { marker: "rc2-mcp-allow" } }) + "\n",
        );
        const env = {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          MCP_EVIDENCE: evidence,
          MCP_ENDPOINT: endpoint,
          MCP_AUDIT: audit,
          MCP_ACTION_OUTCOME: "success",
          GITHUB_STEP_SUMMARY: summary,
          RESULT_JSON: JSON.stringify({
            conclusion: "success",
            summary: modelText,
            taskOutput: { proof: returnedProof },
            ...(matches ? { loop: { dshToolReceipts: [{ id: "mcp.fixture.echo" }] } } : {}),
          }),
        };
        expect(execFileSync(process.execPath, [script, "capture"], { env, encoding: "utf8" })).toBe(
          "",
        );
        const reported = execFileSync(process.execPath, [script, "report"], {
          env,
          encoding: "utf8",
        });
        expect(JSON.parse(reported)).toEqual({
          actionOutcome: "success",
          conclusion: "success",
          errorCode: "none",
          receiptCount: matches ? 1 : 0,
          echoCalls: 1,
          hiddenCalls: 0,
          proofMatches: matches,
        });
        const artifacts =
          reported + (await readFile(evidence, "utf8")) + (await readFile(summary, "utf8"));
        for (const excluded of [modelText, proof, returnedProof])
          expect(artifacts).not.toContain(excluded);
        expect(artifacts.length).toBeLessThan(2_048);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("preserves unknown counts after a missing result or oversized server audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-mcp-proof-evidence-"));
    try {
      const evidence = join(root, "evidence.json");
      const audit = join(root, "audit.jsonl");
      await writeFile(audit, "x".repeat(64 * 1024 + 1));
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MCP_EVIDENCE: evidence,
        MCP_AUDIT: audit,
        MCP_ACTION_OUTCOME: "failure",
        RESULT_JSON: "not-json",
      };
      execFileSync(process.execPath, [script, "capture"], { env });
      expect(JSON.parse(await readFile(evidence, "utf8"))).toEqual({
        actionOutcome: "failure",
        conclusion: "unavailable",
        errorCode: "none",
        receiptCount: null,
        echoCalls: null,
        hiddenCalls: null,
        proofMatches: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("writes fallback evidence when capture never ran and sanitizes report fields", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-mcp-proof-evidence-"));
    try {
      const evidence = join(root, "evidence.json");
      const env = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        MCP_EVIDENCE: evidence,
        MCP_ACTION_OUTCOME: "failure",
        MCP_ERROR_CODE: "DSH_MALFORMED_OUTPUT",
      };
      const fallback = execFileSync(process.execPath, [script, "report"], {
        env,
        encoding: "utf8",
      });
      expect(JSON.parse(fallback)).toMatchObject({
        actionOutcome: "failure",
        errorCode: "DSH_MALFORMED_OUTPUT",
        receiptCount: null,
        proofMatches: false,
      });
      await writeFile(
        evidence,
        JSON.stringify({
          actionOutcome: modelText,
          conclusion: modelText,
          errorCode: modelText,
          receiptCount: modelText,
          echoCalls: 1_000_000,
          hiddenCalls: -1,
          proofMatches: proof,
          summary: modelText,
          proof,
        }),
      );
      const report = execFileSync(process.execPath, [script, "report"], { env, encoding: "utf8" });
      expect(JSON.parse(report)).toEqual({
        actionOutcome: "not-run",
        conclusion: "unavailable",
        errorCode: "invalid-code",
        receiptCount: null,
        echoCalls: null,
        hiddenCalls: null,
        proofMatches: false,
      });
      expect(report + (await readFile(evidence, "utf8"))).not.toContain(proof);
      expect(report).not.toContain(modelText);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
