import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DSH_VERSION } from "../src/release.js";

const script = fileURLToPath(new URL("../scripts/upstream-canary.mjs", import.meta.url));

function invoke(name: string, ...args: readonly unknown[]): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url"; const {name,args}=JSON.parse(readFileSync(0,"utf8")); const module=await import(pathToFileURL(process.argv[1]).href); process.stdout.write(JSON.stringify(await module[name](...args)));',
        script,
      ],
      { encoding: "utf8", input: JSON.stringify({ name, args }), stdio: ["pipe", "pipe", "pipe"] },
    ),
  ) as unknown;
}

function inventory(...versions: readonly string[]): object {
  return { versions: Object.fromEntries(versions.map((version) => [version, { version }])) };
}

const candidate = "0.1.5-rc.2";
const graph = {
  "@deepseek-ai/dsh": {
    name: "@deepseek-ai/dsh",
    version: candidate,
    dependencies: { "@deepseek-ai/cordis": "^4.0.2" },
  },
  "@deepseek-ai/dsh-agent": {
    name: "@deepseek-ai/dsh-agent",
    version: candidate,
    peerDependencies: { "@deepseek-ai/cordis": "^4.0.2" },
  },
};

describe("DSH upstream compatibility canary", () => {
  it("is advisory, non-release-gating, and leaves production pins unchanged", async () => {
    const workflow = await readFile(
      new URL("../.github/workflows/dsh-upstream-canary.yml", import.meta.url),
      "utf8",
    );

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("schedule:");
    expect(workflow).not.toMatch(/^\s+(?:pull_request|push|release):/mu);
    expect(workflow).toContain("continue-on-error: true");
    expect(workflow).toContain("fail-fast: false");
    expect(workflow).toContain("channel: [stable, rc]");
    expect(workflow).toContain('node scripts/upstream-canary.mjs run "$CANDIDATE_CHANNEL"');
    expect(workflow).toContain('node scripts/upstream-canary.mjs report "$CANDIDATE_CHANNEL"');
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain("actions/upload-artifact@");
    expect(workflow).toContain(
      "git diff --exit-code -- package.json package-lock.json src/release.ts action.yml",
    );
    expect(workflow).not.toContain("git commit");
    expect(workflow).not.toContain("git push");

    const implementation = await readFile(script, "utf8");
    expect(implementation).toContain("https://registry.npmjs.org/");
    expect(implementation).toContain('"--strict-peer-deps"');
    expect(implementation).toContain('"--ignore-scripts"');
    expect(implementation).not.toContain('"--force"');
    expect(implementation).not.toContain('"--legacy-peer-deps"');
    expect(implementation).not.toContain("overrides:");
    expect(implementation).toContain("test/dsh-composition.test.ts");
    expect(implementation).toContain("test/native-ecosystem.integration.test.ts");
    expect(implementation).toContain(
      "This advisory probe does not upgrade production or declare support.",
    );
  });

  it("selects the newest stable and RC despite unordered inventory, alpha builds, and stale tags", () => {
    const published = {
      ...inventory(
        DSH_VERSION,
        "0.1.2-alpha.2",
        "0.1.6-rc.2",
        "0.1.5",
        "0.1.6-rc.10",
        "0.1.3",
        "0.2.0-alpha.1",
      ),
      "dist-tags": { latest: "0.1.3", next: "0.1.2-alpha.2" },
    };
    expect(invoke("selectCandidates", published, DSH_VERSION)).toEqual({
      stable: "0.1.5",
      rc: "0.1.6-rc.10",
    });
  });

  it("tracks the current official RC when no stable release exists", () => {
    expect(
      invoke(
        "selectCandidates",
        inventory(DSH_VERSION, "0.1.2-alpha.2", "0.1.5-rc.1", candidate),
        DSH_VERSION,
      ),
    ).toEqual({ stable: null, rc: candidate });
  });

  it("uses npm's supported media type for inventory and exact-version metadata endpoints", () => {
    expect(invoke("metadataRequest", "@deepseek-ai/dsh")).toEqual({
      url: "https://registry.npmjs.org/%40deepseek-ai%2Fdsh",
      accept: "application/vnd.npm.install-v1+json",
    });
    expect(invoke("metadataRequest", "@deepseek-ai/dsh-app-boot", candidate)).toEqual({
      url: `https://registry.npmjs.org/%40deepseek-ai%2Fdsh-app-boot/${candidate}`,
      accept: "application/json",
    });
  });

  it("does not repeat older RCs superseded by a stable release or deprecated candidates", () => {
    expect(
      invoke(
        "selectCandidates",
        {
          versions: {
            [DSH_VERSION]: {},
            "0.1.5": {},
            "0.1.5-rc.9": {},
            "0.1.6-rc.1": { deprecated: "withdrawn candidate" },
            "0.1.7": { deprecated: "withdrawn release" },
          },
        },
        DSH_VERSION,
      ),
    ).toEqual({ stable: "0.1.5", rc: null });
    expect(
      invoke("selectCandidates", inventory(DSH_VERSION, "0.1.0", "0.1.2-alpha.2"), DSH_VERSION),
    ).toEqual({ stable: null, rc: null });
  });

  it("fails selection explicitly when the audited production package cannot be verified", () => {
    expect(() => invoke("selectCandidates", inventory(candidate), DSH_VERSION)).toThrow(
      "The audited DSH version is absent",
    );
  });

  it("builds a complete isolated DSH and Cordis candidate without changing production or invoking its scripts", () => {
    const production = {
      dependencies: {
        "@deepseek-ai/dsh": DSH_VERSION,
        "@deepseek-ai/cordis": "4.0.1",
        "@deepseek-ai/cordis-plugin-group": "1.0.1",
        zod: "4.4.3",
      },
      devDependencies: { "@deepseek-ai/dsh-agent": DSH_VERSION, vitest: "4.1.10" },
      scripts: { preinstall: "must not run", check: "must not run" },
    };
    const before = JSON.stringify(production);
    expect(
      invoke("candidateManifest", production, candidate, graph, {
        "@deepseek-ai/cordis-plugin-group": "1.0.2",
      }),
    ).toEqual({
      name: "dsh-upstream-compatibility-probe",
      version: "0.0.0",
      private: true,
      type: "module",
      dependencies: {
        "@deepseek-ai/dsh": candidate,
        "@deepseek-ai/dsh-agent": candidate,
        "@deepseek-ai/cordis": "^4.0.2",
        "@deepseek-ai/cordis-plugin-group": "1.0.2",
        zod: "4.4.3",
        vitest: "4.1.10",
      },
    });
    expect(JSON.stringify(production)).toBe(before);
  });

  it("rejects incomplete candidate packages before installing or running tests", () => {
    expect(() =>
      invoke(
        "candidateManifest",
        { dependencies: { "@deepseek-ai/dsh-missing": DSH_VERSION } },
        candidate,
        graph,
        {},
      ),
    ).toThrow("Candidate graph is missing required package");
    expect(() =>
      invoke(
        "candidateManifest",
        {},
        candidate,
        {
          ...graph,
          "@deepseek-ai/dsh-old": { name: "@deepseek-ai/dsh-old", version: DSH_VERSION },
        },
        {},
      ),
    ).toThrow("Candidate graph identity mismatch");
  });

  it("rejects a mixed transitive DSH graph or multiple Cordis runtimes before the smoke", () => {
    const packages = {
      "node_modules/@deepseek-ai/dsh": { version: candidate },
      "node_modules/@deepseek-ai/dsh-agent": { version: candidate },
      "node_modules/@deepseek-ai/cordis": { version: "4.0.2" },
    };
    expect(invoke("verifyInstalledGraph", { packages }, candidate, graph)).toEqual({
      "@deepseek-ai/cordis": ["4.0.2"],
      "@deepseek-ai/dsh": [candidate],
      "@deepseek-ai/dsh-agent": [candidate],
    });
    expect(() =>
      invoke(
        "verifyInstalledGraph",
        {
          packages: {
            ...packages,
            "node_modules/plugin/node_modules/@deepseek-ai/dsh-agent": { version: DSH_VERSION },
          },
        },
        candidate,
        graph,
      ),
    ).toThrow("Mixed DSH graph");
    expect(() =>
      invoke(
        "verifyInstalledGraph",
        {
          packages: {
            ...packages,
            "node_modules/plugin/node_modules/@deepseek-ai/cordis": { version: "4.0.1" },
          },
        },
        candidate,
        graph,
      ),
    ).toThrow("one matching Cordis runtime");
  });

  it("preserves passed and interface failures, reports interrupted installs, and never turns untested into success", () => {
    for (const status of ["passed", "interface-incompatible", "install-failed"]) {
      expect(invoke("interruptedReport", { status, phase: "complete" })).toEqual({
        status,
        phase: "complete",
      });
    }
    expect(
      invoke("interruptedReport", { status: "not-tested", phase: "installation" }),
    ).toMatchObject({
      status: "install-failed",
      detail: expect.stringContaining("tests were not run") as unknown,
    });
    expect(invoke("interruptedReport", { status: "not-tested", phase: "testing" })).toMatchObject({
      status: "not-tested",
      detail: expect.stringContaining("no completed compatibility result") as unknown,
    });
    expect(invoke("interruptedReport", { status: "not-tested", phase: "selection" })).toMatchObject(
      { status: "not-tested" },
    );
  });

  it("distinguishes completed interface checks from test spawn failure, timeout, and cancellation", () => {
    const completed = { started: true, timedOut: false, signal: null, exitCode: 0 };
    expect(invoke("compatibilityStatus", completed)).toBe("passed");
    expect(invoke("compatibilityStatus", { ...completed, exitCode: 1 })).toBe(
      "interface-incompatible",
    );
    expect(
      invoke("compatibilityStatus", {
        ...completed,
        started: false,
        exitCode: null,
        spawnError: "ENOENT",
      }),
    ).toBe("not-tested");
    expect(invoke("compatibilityStatus", { ...completed, timedOut: true })).toBe("not-tested");
    expect(invoke("compatibilityStatus", { ...completed, signal: "SIGTERM", exitCode: null })).toBe(
      "not-tested",
    );
  });
});
