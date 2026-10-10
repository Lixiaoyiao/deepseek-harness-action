import { z } from "zod";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

interface DiagnosticStep {
  readonly name: string;
  readonly shell: string;
  readonly env: Readonly<Record<string, string>>;
  readonly run: string;
}

interface DiagnosticWorkflow {
  readonly name: string;
  readonly on: Readonly<Record<string, unknown>>;
  readonly permissions: Readonly<Record<string, string>>;
  readonly jobs: Readonly<
    Record<
      string,
      {
        readonly if: string;
        readonly "timeout-minutes": number;
        readonly steps: readonly DiagnosticStep[];
      }
    >
  >;
}

describe("independent Actions content-read quota diagnostic", () => {
  let source: string;
  let workflow: DiagnosticWorkflow;
  let script: string;
  let parser: string;

  beforeAll(async () => {
    source = await readFile(
      new URL("../.github/workflows/e2e-rate-limit.yml", import.meta.url),
      "utf8",
    );
    workflow = z
      .looseObject({
        name: z.string(),
        on: z.record(z.string(), z.unknown()),
        permissions: z.record(z.string(), z.string()),
        jobs: z.record(
          z.string(),
          z.looseObject({
            if: z.string(),
            "timeout-minutes": z.number(),
            steps: z.array(
              z.looseObject({
                name: z.string(),
                shell: z.string(),
                env: z.record(z.string(), z.string()),
                run: z.string(),
              }),
            ),
          }),
        ),
      })
      .parse(parse(source));
    const step = workflow.jobs.inspect?.steps[0];
    if (step === undefined) throw new Error("Missing quota diagnostic step");
    script = step.run;
    const embeddedParser = /<<'NODE'\r?\n([\s\S]*?)\r?\nNODE(?:\r?\n)?$/u.exec(script)?.[1];
    if (embeddedParser === undefined) throw new Error("Missing quota response parser");
    parser = embeddedParser;
  });

  async function parseResponse(response: string, requestExit: number) {
    const directory = await mkdtemp(join(tmpdir(), "dsh-rate-limit-"));
    try {
      const responsePath = join(directory, "response.txt");
      await writeFile(responsePath, response);
      return spawnSync(
        process.execPath,
        ["--input-type=module", "-", responsePath, String(requestExit)],
        {
          input: parser,
          encoding: "utf8",
        },
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  it("is manually dispatched on main and makes one minimally authorized repository blob GET", () => {
    expect(workflow.name).toBe("Actions content-read quota diagnostic");
    expect(workflow.on).toEqual({
      workflow_dispatch: {
        inputs: {
          blob_sha: {
            description:
              "Existing blob SHA in this repository (40 lowercase hexadecimal characters)",
            required: true,
            type: "string",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(Object.keys(workflow.jobs)).toEqual(["inspect"]);
    expect(workflow.jobs.inspect?.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.jobs.inspect?.["timeout-minutes"]).toBe(2);
    expect(workflow.jobs.inspect?.steps).toHaveLength(1);
    expect(workflow.jobs.inspect?.steps[0]?.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      REPOSITORY: "${{ github.repository }}",
      BLOB_SHA: "${{ inputs.blob_sha }}",
    });
    expect(source).not.toMatch(/uses:|checkout|secrets\.|environment:|Core E2E|deepseek/iu);
    expect(source.match(/inputs\./gu)).toHaveLength(1);
    expect(source).not.toMatch(/actions:|checks:|pull-requests:|write/u);
    expect(script.match(/\bgh api\b/gu)).toHaveLength(1);
    expect(script).toContain('[[ "$BLOB_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(script.indexOf('[[ "$BLOB_SHA"')).toBeLessThan(script.indexOf("gh api"));
    expect(script).toContain(
      'gh api --include --method GET "repos/$REPOSITORY/git/blobs/$BLOB_SHA"',
    );
    expect(script).toContain(
      '2> "$RUNNER_TEMP/dsh-actions-rate-limit-error.txt" || request_exit=$?',
    );
    expect(script).toContain('node --input-type=module - "$response_file" "$request_exit"');
    expect(script).not.toMatch(
      /gh workflow|gh run|gh api.*rate_limit|sleep|while|printenv|set -x/u,
    );
    expect(parser).not.toContain("JSON.parse");
  });

  it.each([200, 403, 429])(
    "preserves HTTP %s quota evidence without printing blob or error content",
    async (status) => {
      const result = await parseResponse(
        [
          `HTTP/2.0 ${String(status)}`,
          "X-Ratelimit-Limit: 1000",
          "X-Ratelimit-Used: 1000",
          "X-Ratelimit-Remaining: 0",
          "X-Ratelimit-Reset: 1790592000",
          "X-Ratelimit-Resource: core",
          "Retry-After: 60",
          "X-Unrelated-Header: private-response-data",
          "",
          JSON.stringify({
            content: "private-base64-blob-data",
            message: "private-error-data",
          }),
        ].join("\r\n"),
        status === 200 ? 0 : 1,
      );
      expect(result.status).toBe(status === 200 ? 0 : 1);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({
        status,
        headers: {
          "x-ratelimit-limit": "1000",
          "x-ratelimit-used": "1000",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1790592000",
          "x-ratelimit-resource": "core",
          "retry-after": "60",
        },
        quota: { limit: 1000, used: 1000, remaining: 0, reset: 1790592000 },
        quotaKnown: true,
        resetAt: "2026-09-28T10:40:00.000Z",
        requestSucceeded: status === 200,
      });
      expect(result.stdout).not.toContain("private");
    },
  );

  it.each(["", "X-Ratelimit-Remaining: invalid", "X-Ratelimit-Remaining: -1"])(
    "fails with unknown counters when quota evidence is absent or malformed (%s)",
    async (header) => {
      const result = await parseResponse(
        ["HTTP/2.0 200 OK", header, "", "private-blob"].join("\r\n"),
        0,
      );
      expect(result.status).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        quota: { limit: "unknown", used: "unknown", remaining: "unknown", reset: "unknown" },
        quotaKnown: false,
        resetAt: "unknown",
      });
      expect(result.stdout).not.toContain("private-blob");
    },
  );

  it("rejects other response statuses without printing their bodies", async () => {
    const result = await parseResponse("HTTP/2.0 404 Not Found\r\n\r\nprivate-error-body", 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Unexpected blob response status");
    expect(result.stderr).not.toContain("private-error-body");
  });
});
