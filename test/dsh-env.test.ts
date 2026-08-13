import { describe, expect, it } from "vitest";

import { DshCredentialLeakError, DshEnvironmentError } from "../src/dsh/errors.js";
import {
  assertNoGitHubCredentials,
  assertNoSecretOutput,
  buildDshWorkerEnvironment,
  redactKnownSecrets,
} from "../src/security/env.js";

describe("DSH worker environment", () => {
  it("uses an allowlist and gives the worker only an ephemeral proxy token", () => {
    const environment = buildDshWorkerEnvironment({
      source: {
        PATH: "/bin",
        GITHUB_TOKEN: "github-secret",
        GH_TOKEN: "gh-secret",
        DEEPSEEK_API_KEY: "raw-key",
        ATTACKER_CONTROLLED: "payload",
      },
      dshHome: "/tmp/dsh",
      permissionMode: "read-only",
      proxyBaseUrl: "http://127.0.0.1:1234",
      proxyToken: "ephemeral-proxy-token",
      realDeepSeekApiKey: "raw-key",
    });

    expect(environment).toMatchObject({
      PATH: "/bin",
      DSH_HOME: "/tmp/dsh",
      DSH_PERMISSION_MODE: "read-only",
      DSH_TELEMETRY_DISABLED: "1",
      DSH_TOOLS_MODE: "native",
      DEEPSEEK_API_KEY: "ephemeral-proxy-token",
      DEEPSEEK_BASE_URL: "http://127.0.0.1:1234",
    });
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("ATTACKER_CONTROLLED");
    expect(Object.values(environment)).not.toContain("raw-key");
  });

  it("rejects GitHub credential variables and reusing the raw key", () => {
    expect(() => assertNoGitHubCredentials({ ACTIONS_ID_TOKEN_CUSTOM: "x" })).toThrow(
      DshEnvironmentError,
    );
    expect(() =>
      buildDshWorkerEnvironment({
        source: {},
        dshHome: "/tmp/dsh",
        permissionMode: "read-only",
        proxyBaseUrl: "http://127.0.0.1",
        proxyToken: "same-key",
        realDeepSeekApiKey: "same-key",
      }),
    ).toThrow(DshEnvironmentError);
  });

  it("detects and redacts controller credentials without echoing them in errors", () => {
    expect(() => assertNoSecretOutput("stdout", "leaked raw-key", ["raw-key"])).toThrow(
      DshCredentialLeakError,
    );
    expect(redactKnownSecrets("authorization: Bearer abc raw-key", ["raw-key"])).toBe(
      "authorization: Bearer [REDACTED] [REDACTED]",
    );
  });
});
