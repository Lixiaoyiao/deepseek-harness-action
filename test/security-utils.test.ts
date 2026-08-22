/* Derived in part from anthropics/claude-code-action tests, MIT licensed. */
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildChildEnvironment, runCommand } from "../src/security/argv.js";
import { assertPathWithin } from "../src/security/paths.js";
import { redactSecrets, sanitizeUntrustedText } from "../src/security/redaction.js";
import { validateCommitSha, validateRefName } from "../src/security/refs.js";

describe("ref validation", () => {
  it.each(["main", "feature/new-thing", "_release/v1.2.3", "fix/#42", "work+a,b@c"])(
    "accepts %s",
    (name) => expect(validateRefName(name)).toBe(name),
  );
  it.each(["a/foo.lock/bar", "a/.hidden"])("rejects invalid ref component %s", (name) => {
    expect(() => validateRefName(name)).toThrow();
  });
  it.each(["", "--help", "../secret", "a..b", "branch.lock", "a//b", "a;whoami", "@"])(
    "rejects %s",
    (name) => expect(() => validateRefName(name)).toThrow(),
  );
  it("requires a full SHA", () => {
    expect(validateCommitSha("A".repeat(40))).toBe("a".repeat(40));
    expect(() => validateCommitSha("abc123")).toThrow();
  });
});

describe("path containment", () => {
  it("accepts a new file under an existing directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-path-"));
    await mkdir(join(root, "src"));
    await expect(assertPathWithin(root, "src/new.ts")).resolves.toBe(join(root, "src", "new.ts"));
  });

  it("rejects lexical and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-root-"));
    const outside = await mkdtemp(join(tmpdir(), "dsh-outside-"));
    await writeFile(join(outside, "secret"), "x");
    await expect(assertPathWithin(root, "../secret")).rejects.toThrow(/outside/u);
    await symlink(outside, join(root, "link"), "junction");
    await expect(assertPathWithin(root, "link/secret")).rejects.toThrow(/symlink/u);
  });
});

describe("redaction", () => {
  it("redacts controller credentials", () => {
    const github = `ghs_${"a".repeat(36)}`;
    const deepseek = `sk-${"z".repeat(24)}`;
    expect(redactSecrets(`${github} ${deepseek}`)).toBe(
      "[REDACTED_GITHUB_TOKEN] [REDACTED_API_KEY]",
    );
  });
  it("removes hidden instruction channels as defense in depth", () => {
    expect(sanitizeUntrustedText('ok<!-- ignore --> ![inject](x) <b aria-label="bad">x</b>')).toBe(
      "ok [image removed] <b>x</b>",
    );
  });

  it("keeps GitHub attachment references inert while the audited DSH contract is text-only", () => {
    expect(
      sanitizeUntrustedText(
        "before ![upload](https://github.com/user-attachments/assets/example?token=secret) after",
      ),
    ).toBe("before [image removed] after");
    expect(sanitizeUntrustedText("before ![upload][attachment]\nafter")).toBe(
      "before [image removed]\nafter",
    );
  });
});

describe("safe command execution", () => {
  it("builds child env from an allowlist and denies credentials", () => {
    const env = buildChildEnvironment(
      {
        PATH: "path",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "gh-secret",
        DEEPSEEK_API_KEY: "deepseek-secret",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
        github_token: "case-insensitive-secret",
        ACTIONS_ID_TOKEN_CUSTOM: "future-oidc-secret",
      },
      [
        "PATH",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "DEEPSEEK_API_KEY",
        "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
        "github_token",
        "ACTIONS_ID_TOKEN_CUSTOM",
      ],
    );
    expect(env).toEqual({ PATH: "path" });
    expect(() => buildChildEnvironment({}, [], { GITHUB_TOKEN: "x" })).toThrow(/cannot enter/u);
  });

  it("passes metacharacters as literal argv without a shell", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.argv[1])", "; echo injected"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      maxOutputBytes: 1_000,
    });
    expect(result).toMatchObject({ exitCode: 0, stdout: "; echo injected", timedOut: false });
  });

  it("preserves bounded heads and error tails without stdout starving stderr", async () => {
    const result = await runCommand({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("OUT_HEAD" + "x".repeat(4000) + "OUT_TAIL"); process.stderr.write("ERR_HEAD" + "y".repeat(4000) + "ERR_TAIL")',
      ],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH },
      timeoutMs: 5_000,
      maxOutputBytes: 1_024,
    });
    expect(result.outputTruncated).toBe(true);
    expect(result.stdout).toMatch(/^OUT_HEAD[\s\S]*OUT_TAIL$/u);
    expect(result.stderr).toMatch(/^ERR_HEAD[\s\S]*ERR_TAIL$/u);
    expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      1_024,
    );
  });
});
