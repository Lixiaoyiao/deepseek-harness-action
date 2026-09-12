import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { parseTaskOutputSchema, validateTaskOutput } from "../src/dsh/task-output.js";

const script = fileURLToPath(new URL("../.github/e2e/web-search-evidence.mjs", import.meta.url));
const source = { title: "Official documentation", url: "https://example.org/documentation" };
const completedSearch = { id: "native.web-search", completed: true, ok: true };

interface Evidence {
  readonly actionOutcome: string;
  readonly conclusion: string;
  readonly errorCode: string;
  readonly receiptCount: number | null;
  readonly completedWebSearchCount: number | null;
  readonly sourceReported: boolean;
}

async function capture(rawResult: string, outcome = "success", includeSummary = true) {
  const root = await mkdtemp(join(tmpdir(), "dsh-web-evidence-test-"));
  try {
    const evidencePath = join(root, "evidence.json");
    const summaryPath = join(root, "summary.md");
    if (includeSummary) await writeFile(summaryPath, "Existing job summary.\n");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        RESULT_JSON: rawResult,
        WEB_ACTION_OUTCOME: outcome,
        WEB_EVIDENCE: evidencePath,
        ...(includeSummary ? { GITHUB_STEP_SUMMARY: summaryPath } : {}),
      },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (result.error !== undefined) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    const saved = await readFile(evidencePath, "utf8");
    const stdoutValue = JSON.parse(result.stdout) as unknown;
    const value = JSON.parse(saved) as Evidence;
    expect(stdoutValue).toEqual(value);
    expect(Object.keys(value).sort()).toEqual([
      "actionOutcome",
      "completedWebSearchCount",
      "conclusion",
      "errorCode",
      "receiptCount",
      "sourceReported",
    ]);
    const summary = includeSummary ? await readFile(summaryPath, "utf8") : "";
    if (includeSummary) expect(summary).toMatch(/^Existing job summary\.\n/u);
    const artifacts = result.stdout + saved + summary;
    expect(artifacts.length).toBeLessThan(2_048);
    return { value, artifacts };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function taskResult(receipts: readonly unknown[], taskOutput: unknown = source) {
  return { conclusion: "success", taskOutput, loop: { dshToolReceipts: receipts } };
}

describe("bounded Web Search evidence", () => {
  it.each([0, 1, 2])(
    "reports the actual %i successful search receipts despite a success claim",
    async (count) => {
      const result = taskResult(Array.from({ length: count }, () => completedSearch));
      const { value } = await capture(
        JSON.stringify({ ...result, summary: "I searched exactly once successfully." }),
      );
      expect(value).toEqual({
        actionOutcome: "success",
        conclusion: "success",
        errorCode: "none",
        receiptCount: count,
        completedWebSearchCount: count,
        sourceReported: true,
      });
    },
  );

  it("counts only completed, successful, exact native.web-search receipts", async () => {
    const receipts = [
      completedSearch,
      { ...completedSearch, id: "native.web-search-imitation" },
      { ...completedSearch, id: "mcp.web-search" },
      { ...completedSearch, completed: false },
      { ...completedSearch, ok: false },
      { ...completedSearch, completed: "true" },
      { ...completedSearch, ok: "true" },
      null,
      "native.web-search",
    ];
    const { value } = await capture(JSON.stringify(taskResult(receipts)));
    expect(value).toMatchObject({ receiptCount: receipts.length, completedWebSearchCount: 1 });
  });

  it.each([{}, { loop: {} }, { loop: { dshToolReceipts: {} } }])(
    "records zero receipts when a parsed result has no receipt array: %j",
    async (result) => {
      const { value } = await capture(JSON.stringify(result));
      expect(value).toMatchObject({
        receiptCount: 0,
        completedWebSearchCount: 0,
        sourceReported: false,
      });
    },
  );

  it("keeps failed action and typed error diagnostics without manufacturing a search", async () => {
    const { value } = await capture(
      JSON.stringify({ conclusion: "failure", error: { code: "DSH_MALFORMED_OUTPUT" } }),
      "failure",
    );
    expect(value).toEqual({
      actionOutcome: "failure",
      conclusion: "failure",
      errorCode: "DSH_MALFORMED_OUTPUT",
      receiptCount: 0,
      completedWebSearchCount: 0,
      sourceReported: false,
    });
  });

  it.each(["cancelled", "skipped", "not-run"])(
    "preserves the %s action outcome",
    async (outcome) => {
      const { value } = await capture(JSON.stringify({ conclusion: "neutral" }), outcome);
      expect(value).toMatchObject({
        actionOutcome: outcome,
        conclusion: "neutral",
        receiptCount: 0,
        completedWebSearchCount: 0,
      });
    },
  );

  it.each(["", "not-json", "{", "null", "[]", '"not-an-object"'])(
    "keeps unknown receipt counts for an unavailable result: %j",
    async (raw) => {
      const { value } = await capture(raw, "failure");
      expect(value).toEqual({
        actionOutcome: "failure",
        conclusion: "unavailable",
        errorCode: "none",
        receiptCount: null,
        completedWebSearchCount: null,
        sourceReported: false,
      });
    },
  );

  it.each([
    { title: "", url: source.url },
    { title: " \t\n ", url: source.url },
    { title: "x".repeat(513), url: source.url },
    { title: 1, url: source.url },
    { title: source.title, url: "" },
    { title: source.title, url: "/relative/path" },
    { title: source.title, url: "not a URI" },
    { title: source.title, url: "ftp://example.org/source" },
    { title: source.title, url: "https://user:password@example.org/source" },
    { title: source.title, url: "https://user@example.org/source" },
    { title: source.title, url: `https://example.org/${"x".repeat(2_048)}` },
    { title: source.title },
    { url: source.url },
  ])("rejects an invalid or credential-bearing reported source: %j", async (taskOutput) => {
    const { value } = await capture(JSON.stringify(taskResult([completedSearch], taskOutput)));
    expect(value.sourceReported).toBe(false);
    expect(value.completedWebSearchCount).toBe(1);
  });

  it.each(["http://example.org/source", "https://example.org/source"])(
    "accepts a nonempty title and absolute HTTP source %s",
    async (url) => {
      const { value } = await capture(
        JSON.stringify(taskResult([completedSearch], { title: "  Reported title  ", url })),
        "success",
        false,
      );
      expect(value.sourceReported).toBe(true);
    },
  );

  it.each(["lowercase_code", "X".repeat(81), "MODEL_SECRET_ERROR\n::error::injected"])(
    "sanitizes invalid error code %j and excludes all raw model fields",
    async (code) => {
      const privateValues = [
        "PRIVATE_MODEL_SUMMARY_DO_NOT_LOG",
        "PRIVATE_SOURCE_TITLE_DO_NOT_LOG",
        "https://private.example.org/PRIVATE_SOURCE_URL_DO_NOT_LOG",
        "PRIVATE_RECEIPT_BODY_DO_NOT_LOG",
        code,
        "UNTRUSTED_ACTION_OUTCOME_DO_NOT_LOG",
        "UNTRUSTED_CONCLUSION_DO_NOT_LOG",
      ];
      const { value, artifacts } = await capture(
        JSON.stringify({
          conclusion: privateValues[6],
          error: { code, message: privateValues[0] },
          summary: privateValues[0],
          taskOutput: { title: privateValues[1], url: privateValues[2] },
          loop: { dshToolReceipts: [{ ...completedSearch, body: privateValues[3] }] },
        }),
        privateValues[5],
      );
      expect(value).toMatchObject({
        actionOutcome: "not-run",
        conclusion: "unavailable",
        errorCode: "invalid-code",
        receiptCount: 1,
        completedWebSearchCount: 1,
        sourceReported: true,
      });
      for (const privateValue of privateValues) expect(artifacts).not.toContain(privateValue);
    },
  );
});

describe("Web Search workflow task output schema", () => {
  it("validates a real title and URI and rejects missing fields or invalid URIs", async () => {
    interface Workflow {
      readonly jobs: Readonly<
        Record<
          string,
          {
            readonly steps?: readonly {
              readonly id?: string;
              readonly with?: Readonly<Record<string, unknown>>;
            }[];
          }
        >
      >;
    }
    const workflow = parse(
      await readFile(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8"),
    ) as Workflow;
    const web = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .find((step) => step.id === "web");
    const rawSchema = web?.with?.["task-output-schema"];
    if (typeof rawSchema !== "string")
      throw new Error("The real Web Search step must declare task-output-schema");
    const schema = parseTaskOutputSchema(rawSchema);
    if (schema === undefined) throw new Error("Web Search task-output-schema must not be empty");
    expect(validateTaskOutput(source, schema)).toEqual(source);
    for (const invalid of [
      { title: source.title },
      { url: source.url },
      { ...source, url: "not a URI" },
    ]) {
      expect(() => validateTaskOutput(invalid, schema)).toThrow();
    }
  });
});
