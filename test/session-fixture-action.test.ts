import { spawnSync } from "node:child_process";
import type { ArtifactClient } from "@actions/artifact";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { smokeSessionArtifactTransport } from "../.github/e2e/session-history-fixture.mjs";
import { historicalHarnessPaths } from "../.github/e2e/session-history-fixture-proof.mjs";

const roots: string[] = [];
type SmokePort = Pick<ArtifactClient, "uploadArtifact" | "getArtifact" | "deleteArtifact">;
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("private Session fixture JavaScript Action", () => {
  it("rejects missing SDK runtime context at the real CLI before reading model proof or artifact data", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-fixture-action-"));
    roots.push(root);
    const result = spawnSync(
      process.execPath,
      [resolve(".github/e2e/session-history-fixture.mjs")],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 65_536,
        env: {
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
          RUNNER_TEMP: root,
          GITHUB_WORKSPACE: join(root, "workspace"),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("SESSION_FIXTURE_RUNTIME_CONTEXT");
  });

  it("checks the current-job SDK upload/get digest and deletes only its own smoke artifact, with no Session qualification", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-fixture-smoke-test-"));
    roots.push(root);
    const transportCalls: string[] = [];
    let name = "";
    const receipt = await smokeSessionArtifactTransport({
      env: {
        RUNNER_TEMP: root,
        GITHUB_WORKSPACE: join(root, "workspace"),
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_JOB: "test",
      },
      artifactClient: {
        uploadArtifact: async (artifactName, files, directory, options) => {
          name = artifactName;
          transportCalls.push("upload");
          expect(files).toHaveLength(1);
          expect(directory).toContain(root);
          expect(options?.retentionDays).toBe(1);
          const file = files[0];
          if (file === undefined) throw new Error("Missing smoke file");
          expect(await readFile(file, "utf8")).toBe("GitHub artifact SDK transport smoke\n");
          return { id: 501, size: 256, digest: "a".repeat(64) };
        },
        getArtifact: (artifactName, options) => {
          transportCalls.push("get");
          expect(artifactName).toBe(name);
          expect(options).toBeUndefined();
          return Promise.resolve({
            artifact: { id: 501, name, size: 256, digest: `sha256:${"a".repeat(64)}` },
          });
        },
        deleteArtifact: (artifactName, options) => {
          transportCalls.push("delete");
          expect(artifactName).toBe(name);
          expect(options).toBeUndefined();
          return Promise.resolve({ id: 501 });
        },
      },
    });
    expect(transportCalls).toEqual(["upload", "get", "delete"]);
    expect(receipt).toEqual({
      schemaVersion: 1,
      operation: "artifact-sdk-smoke",
      sessionQualification: false,
      runId: 1234,
      runAttempt: 2,
      artifactId: 501,
      artifactName: name,
      archiveSha256: "a".repeat(64),
      uploadedBytes: 256,
      metadataDigestObserved: true,
      metadataDigestCompared: true,
      deleted: true,
    });
    expect(receipt.artifactName).toMatch(/^session-fixture-smoke-1234-2-[a-f0-9]{24}$/u);
    expect(await readdir(root)).toEqual([]);
  });

  it("executes seed and model-free CI smoke through the same natural node24 Action whose metadata is historically bound", async () => {
    const metadataPath = ".github/e2e/session-history-fixture-action/action.yml";
    const metadata = z
      .object({ runs: z.object({ using: z.string(), main: z.string() }) })
      .parse(parseYaml(await readFile(metadataPath, "utf8")));
    expect(metadata.runs).toEqual({ using: "node24", main: "../session-history-fixture.mjs" });
    const step = z.object({
      name: z.string().optional(),
      run: z.string().optional(),
      uses: z.string().optional(),
      env: z.record(z.string(), z.unknown()).optional(),
    });
    const workflow = z.object({ jobs: z.record(z.string(), z.object({ steps: z.array(step) })) });
    const automatic = workflow.parse(
      parseYaml(await readFile(".github/workflows/session-auto-e2e.yml", "utf8")),
    );
    const producer = automatic.jobs.session?.steps.find(
      (value) => value.name === "Create a current-run diagnostic Session history artifact",
    );
    expect(producer?.uses).toBe("./.github/e2e/session-history-fixture-action");
    expect(producer?.run).toBeUndefined();
    const ci = workflow.parse(parseYaml(await readFile(".github/workflows/ci.yml", "utf8")));
    const steps = ci.jobs.test?.steps ?? [];
    const smokeIndex = steps.findIndex((value) => value.env?.SESSION_FIXTURE_OPERATION === "smoke");
    expect(steps[smokeIndex]?.uses).toBe(producer?.uses);
    expect(smokeIndex).toBeGreaterThan(steps.findIndex((value) => value.run === "npm ci"));
    expect(smokeIndex).toBeLessThan(steps.findIndex((value) => value.run === "npm run check"));
    expect(historicalHarnessPaths).toContain(metadataPath);
    expect(historicalHarnessPaths).toHaveLength(5);
  });

  it("accepts the SDK's optional absent metadata digest and states that it was not observed or compared", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-fixture-smoke-optional-digest-"));
    roots.push(root);
    const calls: string[] = [];
    let name = "";
    const receipt = await smokeSessionArtifactTransport({
      env: {
        RUNNER_TEMP: root,
        GITHUB_WORKSPACE: join(root, "workspace"),
        GITHUB_RUN_ID: "1234",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_JOB: "test",
      },
      artifactClient: {
        uploadArtifact: (value) => {
          name = value;
          calls.push("upload");
          return Promise.resolve({ id: 501, size: 256, digest: "a".repeat(64) });
        },
        getArtifact: () => {
          calls.push("get");
          return Promise.resolve({ artifact: { id: 501, name, size: 256 } });
        },
        deleteArtifact: () => {
          calls.push("delete");
          return Promise.resolve({ id: 501 });
        },
      },
    });
    expect(receipt).toMatchObject({
      archiveSha256: "a".repeat(64),
      metadataDigestObserved: false,
      metadataDigestCompared: false,
      deleted: true,
      sessionQualification: false,
    });
    expect(calls).toEqual(["upload", "get", "delete"]);
    expect(await readdir(root)).toEqual([]);
  });

  it.each(["wrong-id", "wrong-digest"])(
    "refuses an unverified artifact without deleting or retrying it (%s)",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-fixture-smoke-denied-"));
      roots.push(root);
      const calls: string[] = [];
      let name = "";
      const artifactClient: SmokePort = {
        uploadArtifact: (value) => {
          name = value;
          calls.push("upload");
          return Promise.resolve({ id: 501, size: 256, digest: "a".repeat(64) });
        },
        getArtifact: () => {
          calls.push("get");
          return Promise.resolve({
            artifact: {
              id: failure === "wrong-id" ? 999 : 501,
              name,
              size: 256,
              digest: failure === "wrong-digest" ? "b".repeat(64) : "a".repeat(64),
            },
          });
        },
        deleteArtifact: () => {
          calls.push("delete");
          return Promise.resolve({ id: 999 });
        },
      };
      await expect(
        smokeSessionArtifactTransport({
          env: {
            RUNNER_TEMP: root,
            GITHUB_WORKSPACE: join(root, "workspace"),
            GITHUB_RUN_ID: "1234",
            GITHUB_RUN_ATTEMPT: "1",
            GITHUB_JOB: "test",
          },
          artifactClient,
        }),
      ).rejects.toThrow("SESSION_FIXTURE_SMOKE_OWN_ARTIFACT");
      expect(calls).toEqual(["upload", "get"]);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it("fails an uncertain deletion without retry or success receipt and still removes private local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-fixture-smoke-uncertain-"));
    roots.push(root);
    const calls: string[] = [];
    let name = "";
    const artifactClient: SmokePort = {
      uploadArtifact: (value) => {
        name = value;
        calls.push("upload");
        return Promise.resolve({ id: 501, size: 256, digest: "a".repeat(64) });
      },
      getArtifact: () => {
        calls.push("get");
        return Promise.resolve({ artifact: { id: 501, name, size: 256, digest: "a".repeat(64) } });
      },
      deleteArtifact: () => {
        calls.push("delete");
        return Promise.reject(new Error("Unconfirmed external transport"));
      },
    };
    await expect(
      smokeSessionArtifactTransport({
        env: {
          RUNNER_TEMP: root,
          GITHUB_WORKSPACE: join(root, "workspace"),
          GITHUB_RUN_ID: "1234",
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_JOB: "test",
        },
        artifactClient,
      }),
    ).rejects.toThrow("Unconfirmed external transport");
    expect(calls).toEqual(["upload", "get", "delete"]);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects smoke runtime context without echoing a provided value at the real CLI", () => {
    const marker = "synthetic-private-runtime-marker";
    const result = spawnSync(
      process.execPath,
      [resolve(".github/e2e/session-history-fixture.mjs")],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 65_536,
        env: {
          ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
          SESSION_FIXTURE_OPERATION: "smoke",
          ACTIONS_RUNTIME_TOKEN: marker,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("SESSION_FIXTURE_RUNTIME_CONTEXT");
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(marker);
  });
});
