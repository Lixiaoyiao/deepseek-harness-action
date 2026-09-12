import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

interface CanaryStep {
  readonly name: string;
  readonly id?: string;
  readonly if?: string;
  readonly "continue-on-error"?: boolean;
  readonly run?: string;
  readonly env?: Readonly<Record<string, string>>;
}

describe("independent release canary evidence", () => {
  let steps: readonly CanaryStep[];
  let diagnostic: CanaryStep;
  let diagnosticScript: string;

  beforeAll(async () => {
    const workflow = parse(
      await readFile(new URL("../.github/workflows/release-canary.yml", import.meta.url), "utf8"),
    ) as { jobs: { smoke: { steps: readonly CanaryStep[] } } };
    steps = workflow.jobs.smoke.steps;
    const step = steps.find(
      (entry) => entry.name === "Record diagnostics and require both release modes",
    );
    if (step?.run === undefined) throw new Error("Missing release diagnostic gate");
    diagnostic = step;
    const script = /<<'NODE'\r?\n([\s\S]*?)\r?\nNODE(?:\r?\n)?$/u.exec(step.run)?.[1];
    if (script === undefined) throw new Error("Missing executable diagnostic script");
    diagnosticScript = script;
  });

  it("continues after either action or assertion failure, then checks raw outcomes in an unconditional gate", () => {
    for (const id of ["controlled", "controlled_assert", "native", "native_assert"]) {
      expect(steps.find((step) => step.id === id)?.["continue-on-error"]).toBe(true);
      expect(steps.find((step) => step.id === id)?.if).toBeUndefined();
    }
    expect(diagnostic.if).toBe("always()");
    expect(diagnostic["continue-on-error"]).toBeUndefined();
    expect(steps.at(-1)).toBe(diagnostic);
    expect(diagnostic.env?.CONTROLLED_OUTCOME).toBe("${{ steps.controlled.outcome }}");
    expect(diagnostic.env?.CONTROLLED_ASSERTION).toBe("${{ steps.controlled_assert.outcome }}");
    expect(diagnostic.env?.NATIVE_OUTCOME).toBe("${{ steps.native.outcome }}");
    expect(diagnostic.env?.NATIVE_ASSERTION).toBe("${{ steps.native_assert.outcome }}");
    expect(Object.values(diagnostic.env ?? {}).join("\n")).not.toMatch(
      /result-json|error-message|stdout|\.conclusion/iu,
    );
  });

  it.each([
    { name: "both valid", field: "", value: "", expectedStatus: 0 },
    {
      name: "controlled failure",
      field: "CONTROLLED_OUTCOME",
      value: "failure",
      expectedStatus: 1,
    },
    { name: "native failure", field: "NATIVE_OUTCOME", value: "failure", expectedStatus: 1 },
    {
      name: "controlled schema failure",
      field: "CONTROLLED_ASSERTION",
      value: "failure",
      expectedStatus: 1,
    },
    {
      name: "native policy failure",
      field: "NATIVE_ASSERTION",
      value: "failure",
      expectedStatus: 1,
    },
    { name: "native cancellation", field: "NATIVE_OUTCOME", value: "cancelled", expectedStatus: 1 },
    { name: "skipped native", field: "NATIVE_OUTCOME", value: "skipped", expectedStatus: 1 },
    { name: "missing action output", field: "CONTROLLED_OUTCOME", value: "", expectedStatus: 1 },
  ])("records both modes and fails closed for $name", async ({ field, value, expectedStatus }) => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-release-canary-"));
    const summaryPath = join(directory, "summary.md");
    try {
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: diagnosticScript,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          CONTROLLED_OUTCOME: "success",
          CONTROLLED_ASSERTION: "success",
          CONTROLLED_ERROR_CODE: "",
          NATIVE_OUTCOME: "success",
          NATIVE_ASSERTION: "success",
          NATIVE_ERROR_CODE: "",
          ...(field ? { [field]: value } : {}),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(expectedStatus);
      const records = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record.mode)).toEqual(["controlled", "native"]);
      const summary = await readFile(summaryPath, "utf8");
      expect(summary).toContain("| controlled |");
      expect(summary).toContain("| native |");
      if (field.startsWith("CONTROLLED")) expect(records[1]?.action).toBe("success");
      if (expectedStatus !== 0) expect(result.stderr).toContain("Both release modes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds diagnostics and excludes model text, unsafe codes, and arbitrary outcome values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dsh-release-canary-"));
    const summaryPath = join(directory, "summary.md");
    const untrusted = "secret-marker\n::error::injected|";
    try {
      const result = spawnSync(process.execPath, ["--input-type=module"], {
        input: diagnosticScript,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_STEP_SUMMARY: summaryPath,
          CONTROLLED_OUTCOME: "failure",
          CONTROLLED_ASSERTION: "failure",
          CONTROLLED_ERROR_CODE: "DSH_OUTPUT_INVALID",
          NATIVE_OUTCOME: untrusted,
          NATIVE_ASSERTION: "skipped",
          NATIVE_ERROR_CODE: untrusted.repeat(100),
          DSH_RESULT_JSON: untrusted,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('"errorCode":"DSH_OUTPUT_INVALID"');
      expect(result.stdout).toContain('"errorCode":"invalid-code"');
      expect(result.stdout).toContain('"action":"not-run"');
      const summary = await readFile(summaryPath, "utf8");
      expect(result.stdout + result.stderr + summary).not.toContain("secret-marker");
      expect(result.stdout.length + summary.length).toBeLessThan(1_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
