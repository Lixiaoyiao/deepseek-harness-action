import { readFile } from "node:fs/promises";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  ACTION_INPUT_CONTRACT,
  ACTION_INPUT_DOC_GROUPS,
  actionInputDefault,
  actionInputName,
  type ActionInputRuntimeKey,
} from "../src/action-contract.js";
import type { ActionInputs } from "../src/inputs.js";

describe("typed Action public contract", () => {
  it("has unique public names and runtime keys with a documented group", () => {
    const names = ACTION_INPUT_CONTRACT.map(({ name }) => name);
    const runtimeKeys = ACTION_INPUT_CONTRACT.map(({ runtimeKey }) => runtimeKey);
    const groups = new Set(ACTION_INPUT_DOC_GROUPS.map(({ id }) => id));

    expect(new Set(names).size).toBe(names.length);
    expect(new Set(runtimeKeys).size).toBe(runtimeKeys.length);
    expect(ACTION_INPUT_CONTRACT.every(({ docsGroup }) => groups.has(docsGroup))).toBe(true);
    for (const group of groups) {
      expect(ACTION_INPUT_CONTRACT.some(({ docsGroup }) => docsGroup === group)).toBe(true);
    }
    expectTypeOf<ActionInputRuntimeKey>().toEqualTypeOf<keyof ActionInputs>();
  });

  it("exposes runtime lookup helpers without duplicating names or defaults", () => {
    expect(actionInputName("deepseekApiKey")).toBe("deepseek-api-key");
    expect(actionInputName("dshMode")).toBe("dsh-mode");
    expect(actionInputDefault("dshMode")).toBe("controlled");
    expect(actionInputDefault("deepseekApiKey")).toBeUndefined();
  });

  it("generates the installer subset from the same default", async () => {
    const installerMetadata = await readFile(
      new URL(
        "../packages/create-deepseek-harness-action/src/action-inputs.generated.mjs",
        import.meta.url,
      ),
      "utf8",
    );
    expect(installerMetadata).toContain('name: "dsh-mode"');
    expect(installerMetadata).toContain('defaultValue: "controlled"');
  });

  it("keeps wildcard tool families literal in the generated Markdown table", async () => {
    const documentation = await readFile(
      new URL("../docs/configuration.md", import.meta.url),
      "utf8",
    );
    expect(documentation).toContain("workspace.\\*");
    expect(documentation).not.toContain("workspace._");
  });

  it("keeps generated drift detection in the full CI check", async () => {
    const [manifestText, ci] = await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as {
      readonly scripts: Readonly<Record<string, string>>;
    };

    expect(manifest.scripts["test:generated"]).toBe("node scripts/generate-action-contract.mjs");
    expect(manifest.scripts.check).toContain("npm run test:generated");
    expect(ci).toContain("npm run check");
  });
});
