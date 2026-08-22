import { describe, expect, it } from "vitest";

import {
  commandUsesPackageManifest,
  analyzeCommandArgv,
  analyzeShellText,
  normalizeWorkspacePath,
  parseShellCommands,
  resolveWorkspacePath,
} from "../src/validation/command-dependencies.js";
import {
  dependencyReplacementReasons,
  lockReplacementReasons,
  manifestControlChanges,
} from "../src/validation/toolchain-integrity.js";

describe("validation command dependency parsing", () => {
  it("tokenizes the supported shell subset and marks dynamic syntax unreliable", () => {
    expect(
      parseShellCommands(
        'node "scripts/first check.mjs" && env FLAG=1 node scripts/second.mjs | true',
      ),
    ).toEqual({
      commands: [
        ["node", "scripts/first check.mjs"],
        ["env", "FLAG=1", "node", "scripts/second.mjs"],
        ["true"],
      ],
      reliable: true,
    });
    expect(parseShellCommands("node $VALIDATOR").reliable).toBe(false);
  });

  it("normalizes workspace-relative paths and rejects escapes or absolute paths", () => {
    expect(normalizeWorkspacePath("./packages/app/check.mjs")).toBe("packages/app/check.mjs");
    expect(resolveWorkspacePath("packages/app", "../shared/check.mjs")).toBe(
      "packages/shared/check.mjs",
    );
    for (const value of ["../outside.mjs", "/tmp/check.mjs", "C:/check.mjs", "a//b.mjs"]) {
      expect(normalizeWorkspacePath(value)).toBeUndefined();
    }
  });

  it("maps Docker /workspace paths back to the audited repository", () => {
    expect(
      analyzeCommandArgv(["node", "/workspace/scripts/check.mjs"], "", {
        knownWorkspacePaths: new Set(["scripts/check.mjs"]),
      }),
    ).toEqual({ entrypoints: ["scripts/check.mjs"], reliable: true });
    expect(
      analyzeCommandArgv(["node", "/tmp/unscoped-check.mjs"], "", {
        knownWorkspacePaths: new Set(["scripts/check.mjs"]),
      }).reliable,
    ).toBe(false);
  });

  it("tracks Node preload modules and the main entrypoint after valued options", () => {
    expect(
      analyzeCommandArgv(
        [
          "node",
          "--require",
          "hooks/register.cjs",
          "--import=./hooks/loader.mjs",
          "--env-file",
          ".env.validation",
          "scripts/check.mjs",
        ],
        "packages/app",
      ),
    ).toEqual({
      entrypoints: [
        "packages/app/hooks/register.cjs",
        "packages/app/hooks/loader.mjs",
        "packages/app/.env.validation",
        "packages/app/scripts/check.mjs",
      ],
      reliable: true,
    });
  });

  it("does not lose an entrypoint behind env options or a changed working directory", () => {
    expect(analyzeCommandArgv(["env", "-u", "NODE_OPTIONS", "node", "scripts/check.mjs"])).toEqual({
      entrypoints: ["scripts/check.mjs"],
      reliable: true,
    });
    expect(
      analyzeCommandArgv(["env", "--chdir", "packages/app", "node", "scripts/check.mjs"]),
    ).toEqual({ entrypoints: ["packages/app/scripts/check.mjs"], reliable: true });
    expect(analyzeCommandArgv(["env", "-S", "node scripts/check.mjs"])).toEqual({
      entrypoints: ["scripts/check.mjs"],
      reliable: true,
    });
  });

  it("tracks combined shell command flags and nested shell commands", () => {
    expect(analyzeCommandArgv(["bash", "-lc", "node scripts/check.mjs"])).toEqual({
      entrypoints: ["scripts/check.mjs"],
      reliable: true,
    });
    expect(
      analyzeShellText("sh -c 'python3 scripts/check.py'; pwsh -File scripts/check.ps1"),
    ).toEqual({
      entrypoints: ["scripts/check.py", "scripts/check.ps1"],
      reliable: true,
    });
  });

  it("tracks entrypoints passed through package executors and command wrappers", () => {
    expect(analyzeCommandArgv(["npx", "tsx", "scripts/check.ts"])).toEqual({
      entrypoints: ["scripts/check.ts"],
      reliable: true,
    });
    expect(analyzeCommandArgv(["command", "--", "node", "scripts/check.mjs"])).toEqual({
      entrypoints: ["scripts/check.mjs"],
      reliable: true,
    });
    expect(analyzeCommandArgv(["exec", "-a", "validator", "node", "scripts/check.mjs"])).toEqual({
      entrypoints: ["scripts/check.mjs"],
      reliable: true,
    });
  });

  it("supports cross-env and corepack wrappers without trusting unknown wrappers", () => {
    const knownWorkspacePaths = new Set(["scripts/check.mjs", "scripts/check.ts"]);
    expect(
      analyzeCommandArgv(["cross-env", "CI=1", "node", "scripts/check.mjs"], "", {
        knownWorkspacePaths,
      }),
    ).toEqual({ entrypoints: ["scripts/check.mjs"], reliable: true });
    expect(
      analyzeCommandArgv(["corepack", "pnpm", "exec", "tsx", "scripts/check.ts"], "", {
        knownWorkspacePaths,
      }),
    ).toEqual({ entrypoints: ["scripts/check.ts"], reliable: true });
    expect(
      analyzeCommandArgv(["mystery-wrapper", "node", "scripts/check.mjs"], "", {
        knownWorkspacePaths,
      }).reliable,
    ).toBe(false);
    expect(
      analyzeCommandArgv(["npx", "--package", "./tools/validator", "vitest"], "", {
        knownWorkspacePaths,
      }).reliable,
    ).toBe(false);
    expect(analyzeCommandArgv(["pnpm", "--filter", "./packages/app", "test"]).reliable).toBe(false);
  });

  it("tracks Python modules and static stdin while rejecting dynamic stdin", () => {
    const knownWorkspacePaths = new Set([
      "pytest.py",
      "scripts/validate.py",
      "scripts/check.mjs",
      "scripts/check.sh",
      "test/input.txt",
    ]);
    expect(
      analyzeCommandArgv(["python", "-m", "scripts.validate"], "", {
        knownWorkspacePaths,
      }),
    ).toEqual({ entrypoints: ["scripts/validate.py"], reliable: true });
    expect(analyzeShellText("bash -s < scripts/check.sh", "", { knownWorkspacePaths })).toEqual({
      entrypoints: ["scripts/check.sh"],
      reliable: true,
    });
    expect(
      analyzeShellText("node scripts/check.mjs < test/input.txt", "", { knownWorkspacePaths }),
    ).toEqual({ entrypoints: ["test/input.txt", "scripts/check.mjs"], reliable: true });
    expect(analyzeCommandArgv(["python", "-m", "pytest"], "", { knownWorkspacePaths })).toEqual({
      entrypoints: ["pytest.py"],
      reliable: true,
    });
    expect(analyzeShellText("bash -s <<EOF\necho ok\nEOF").reliable).toBe(false);
  });

  it("tracks environment hooks and Node execution-control files", () => {
    const knownWorkspacePaths = new Set([
      ".env.validation",
      "hooks/bash-env.sh",
      "hooks/loader.mjs",
      "hooks/register.js",
      "policy.json",
      "scripts/check.mjs",
      "scripts/reporter.js",
    ]);
    expect(
      analyzeShellText(
        "NODE_OPTIONS=--require=./hooks/register BASH_ENV=./hooks/bash-env.sh bash scripts/check.mjs",
        "",
        { knownWorkspacePaths },
      ),
    ).toEqual({
      entrypoints: ["hooks/register.js", "hooks/bash-env.sh", "scripts/check.mjs"],
      reliable: true,
    });
    expect(
      analyzeCommandArgv(
        [
          "node",
          "--loader",
          "./hooks/loader",
          "--test-reporter=./scripts/reporter",
          "--env-file",
          ".env.validation",
          "--experimental-policy=policy.json",
          "scripts/check.mjs",
        ],
        "",
        { knownWorkspacePaths },
      ),
    ).toEqual({
      entrypoints: [
        "hooks/loader.mjs",
        "scripts/reporter.js",
        ".env.validation",
        "policy.json",
        "scripts/check.mjs",
      ],
      reliable: true,
    });
  });

  it("tracks explicit shell startup files", () => {
    const knownWorkspacePaths = new Set(["hooks/bash-rc.sh", "scripts/check.sh"]);
    expect(
      analyzeCommandArgv(["bash", "--rcfile", "hooks/bash-rc.sh", "scripts/check.sh"], "", {
        knownWorkspacePaths,
      }),
    ).toEqual({
      entrypoints: ["hooks/bash-rc.sh", "scripts/check.sh"],
      reliable: true,
    });
  });

  it("fails closed when extensionless module resolution is ambiguous", () => {
    expect(
      analyzeCommandArgv(["node", "--require", "./hooks/register", "scripts/check.mjs"], "", {
        knownWorkspacePaths: new Set([
          "hooks/register.js",
          "hooks/register.cjs",
          "scripts/check.mjs",
        ]),
      }),
    ).toEqual({ entrypoints: [], reliable: false });
  });

  it("identifies commands whose execution is controlled by the nearest package manifest", () => {
    for (const command of [
      ["npx", "vitest", "run"],
      ["npm", "exec", "--", "vitest", "run"],
      ["node", "scripts/check.mjs"],
      ["vitest", "run"],
    ]) {
      expect(commandUsesPackageManifest(command)).toBe(true);
    }
    expect(commandUsesPackageManifest(["python", "-m", "pytest"])).toBe(false);
  });

  it("tracks Python, PowerShell, Ruby, and Perl entrypoints", () => {
    expect(analyzeCommandArgv(["python3", "-W", "ignore", "scripts/check.py"]).entrypoints).toEqual(
      ["scripts/check.py"],
    );
    expect(analyzeCommandArgv(["pwsh", "-File", "scripts/check.ps1"]).entrypoints).toEqual([
      "scripts/check.ps1",
    ]);
    expect(
      analyzeCommandArgv(["ruby", "-r", "./hooks/register.rb", "scripts/check.rb"]).entrypoints,
    ).toEqual(["hooks/register.rb", "scripts/check.rb"]);
    expect(analyzeCommandArgv(["perl", "scripts/check.pl"]).entrypoints).toEqual([
      "scripts/check.pl",
    ]);
  });

  it("fails closed for unsupported wrapper or interpreter option shapes", () => {
    expect(analyzeCommandArgv(["env", "--mystery", "node", "scripts/check.mjs"]).reliable).toBe(
      false,
    );
    expect(analyzeCommandArgv(["node", "--future-valued-option", "value"]).reliable).toBe(false);
  });

  it.each([
    ["Node", ["node", "-e", "require('./scripts/check.mjs')"]],
    ["Python", ["python", "-c", "import scripts.validate"]],
    ["Ruby", ["ruby", "-e", "require './scripts/check.rb'"]],
    ["Perl", ["perl", "-e", "require './scripts/check.pl'"]],
  ])("fails closed for %s inline validation code with workspace imports", (_name, command) => {
    expect(
      analyzeCommandArgv(command, "", {
        knownWorkspacePaths: new Set([
          "scripts/check.mjs",
          "scripts/validate.py",
          "scripts/check.rb",
          "scripts/check.pl",
        ]),
      }).reliable,
    ).toBe(false);
  });

  it("does not reinterpret ordinary validator flags as workspace config paths", () => {
    expect(analyzeCommandArgv(["cargo", "test", "-p", "core"]).reliable).toBe(true);
    expect(analyzeCommandArgv(["go", "test", "-c", "./..."]).reliable).toBe(true);
    expect(
      analyzeCommandArgv(["tsc", "-p", "tsconfig.validation.json"], "", {
        knownWorkspacePaths: new Set(["tsconfig.validation.json"]),
      }),
    ).toEqual({ entrypoints: ["tsconfig.validation.json"], reliable: true });
  });
});

describe("validation toolchain replacement classification", () => {
  it("permits dependency additions but blocks replacement, removal, and control changes", () => {
    const baseline = JSON.stringify({
      dependencies: { validator: "1.0.0" },
      devDependencies: { helper: "2.0.0" },
    });
    expect(
      dependencyReplacementReasons(
        baseline,
        JSON.stringify({
          dependencies: { validator: "1.0.0", added: "3.0.0" },
          devDependencies: { helper: "2.0.0" },
        }),
      ),
    ).toEqual([]);
    expect(
      dependencyReplacementReasons(
        baseline,
        JSON.stringify({
          dependencies: { validator: "file:./fake" },
          overrides: { helper: "0.0.0" },
        }),
      ).join(" "),
    ).toMatch(/validator was replaced.*helper was removed.*overrides changed/u);
  });

  it("fails closed for malformed manifests and replaced lock provenance", () => {
    expect(dependencyReplacementReasons('{"dependencies":{}}', "not-json")).toEqual([
      "The validation package manifest could not be parsed reliably",
    ]);
    const baseline = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { validator: "1.0.0" } },
        "node_modules/validator": {
          version: "1.0.0",
          resolved: "https://registry.npmjs.org/validator/-/validator-1.0.0.tgz",
          integrity: "sha512-baseline",
        },
      },
    });
    const candidate = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { validator: "1.0.0", added: "2.0.0" } },
        "node_modules/validator": {
          version: "1.0.0",
          resolved: "https://example.invalid/validator.tgz",
          integrity: "sha512-replaced",
        },
        "node_modules/added": { version: "2.0.0" },
      },
    });
    expect(lockReplacementReasons(baseline, candidate).join(" ")).toMatch(
      /validator changed resolved.*validator changed integrity/u,
    );
  });

  it("audits embedded package validation controls independently of dependencies", () => {
    const baseline = JSON.stringify({
      scripts: { test: "jest" },
      jest: { testMatch: ["<rootDir>/test/**/*.test.js"] },
      type: "module",
    });
    const changes = manifestControlChanges(
      baseline,
      JSON.stringify({
        scripts: { test: "jest" },
        jest: { testMatch: ["<rootDir>/dummy/**/*.test.js"] },
        type: "commonjs",
      }),
    );
    expect(changes.keys).toEqual(["jest", "type"]);
    expect(changes.reasons.join(" ")).toMatch(/jest changed.*type changed/u);
  });

  it.each([
    ["dependencies", { helper: "1.0.0" }, { helper: "2.0.0" }],
    ["optionalDependencies", { optional: "1.0.0" }, {}],
    ["peerDependencies", { peer: "^1.0.0" }, { peer: "*" }],
    ["bin", { validator: "cli.js" }, { validator: "noop.js" }],
    ["hasInstallScript", true, false],
  ])("fails closed when a non-root lock package changes its %s edge", (key, before, after) => {
    const lock = (value: unknown) =>
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { devDependencies: { validator: "1.0.0" } },
          "node_modules/validator": {
            version: "1.0.0",
            resolved: "https://registry.example/validator.tgz",
            integrity: "sha512-validator",
            [key]: value,
          },
        },
      });
    expect(lockReplacementReasons(lock(before), lock(after)).join(" ")).toContain(
      `node_modules/validator changed ${key}`,
    );
  });

  it("fails closed when a nested node is added to an existing toolchain closure", () => {
    const baseline = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { validator: "1.0.0" } },
        "node_modules/validator": {
          version: "1.0.0",
          resolved: "https://registry.example/validator.tgz",
          integrity: "sha512-validator",
        },
      },
    });
    const candidate = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { validator: "1.0.0" } },
        "node_modules/validator": {
          version: "1.0.0",
          resolved: "https://registry.example/validator.tgz",
          integrity: "sha512-validator",
        },
        "node_modules/validator/node_modules/injected": {
          version: "0.0.0",
          resolved: "file:injected",
        },
      },
    });
    expect(lockReplacementReasons(baseline, candidate).join(" ")).toMatch(
      /added nested package .*injected.*existing toolchain/u,
    );
  });

  it("continues to permit an unrelated top-level lock dependency addition", () => {
    const baseline = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { validator: "1.0.0" } },
        "node_modules/validator": { version: "1.0.0" },
      },
    });
    const candidate = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { validator: "1.0.0", added: "2.0.0" } },
        "node_modules/validator": { version: "1.0.0" },
        "node_modules/added": { version: "2.0.0" },
      },
    });
    expect(lockReplacementReasons(baseline, candidate)).toEqual([]);
  });

  it("blocks a hoisted node that newly satisfies an existing optional peer edge", () => {
    const baseline = {
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { validator: "1.0.0" } },
        "node_modules/validator": {
          version: "1.0.0",
          peerDependencies: { "validator-hook": "^1.0.0" },
          peerDependenciesMeta: { "validator-hook": { optional: true } },
        },
      },
    };
    const candidate = {
      lockfileVersion: 3,
      packages: {
        ...baseline.packages,
        "": {
          ...baseline.packages[""],
          dependencies: { "validator-hook": "1.0.0" },
        },
        "node_modules/validator-hook": { version: "1.0.0" },
      },
    };
    expect(
      lockReplacementReasons(JSON.stringify(baseline), JSON.stringify(candidate)).join(" "),
    ).toMatch(/newly materialized peerDependencies validator-hook.*validator/u);

    const unrelated = {
      lockfileVersion: 3,
      packages: {
        ...baseline.packages,
        "": { ...baseline.packages[""], dependencies: { unrelated: "1.0.0" } },
        "node_modules/unrelated": { version: "1.0.0" },
      },
    };
    expect(lockReplacementReasons(JSON.stringify(baseline), JSON.stringify(unrelated))).toEqual([]);
  });
});
