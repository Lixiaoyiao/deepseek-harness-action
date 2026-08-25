import { timingSafeEqual } from "node:crypto";

import { DshCredentialLeakError, DshEnvironmentError } from "../dsh/errors.js";

export const DSH_WORKER_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "Path",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "TZ",
] as const);

const forbiddenGitHubNames = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
]);

function isGitHubCredentialName(name: string): boolean {
  const upper = name.toUpperCase();
  return forbiddenGitHubNames.has(upper) || upper.startsWith("ACTIONS_ID_TOKEN_");
}

function equalSecret(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

export function assertNoGitHubCredentials(environment: NodeJS.ProcessEnv): void {
  const leaked = Object.keys(environment).find(isGitHubCredentialName);
  if (leaked !== undefined) {
    throw new DshEnvironmentError(
      `GitHub credential variable is forbidden in DSH worker env: ${leaked}`,
    );
  }
}

export function assertSecretAbsent(
  environment: NodeJS.ProcessEnv,
  secret: string,
  label = "controller credential",
): void {
  if (secret === "") return;
  const leaked = Object.entries(environment).find(
    ([, value]) => value !== undefined && equalSecret(value, secret),
  );
  if (leaked !== undefined) {
    throw new DshEnvironmentError(`${label} is forbidden in DSH worker env (${leaked[0]})`);
  }
}

export interface DshWorkerEnvironmentOptions {
  readonly source?: NodeJS.ProcessEnv;
  readonly dshHome: string;
  readonly permissionMode: "read-only" | "workspace-write";
  readonly proxyBaseUrl: string;
  /** Ephemeral, run-scoped proxy capability. This must not be the real API key. */
  readonly proxyToken: string;
  readonly realDeepSeekApiKey: string;
}

/** Construct a worker environment from a closed allowlist. */
export function buildDshWorkerEnvironment(options: DshWorkerEnvironmentOptions): NodeJS.ProcessEnv {
  if (options.proxyToken === "" || options.realDeepSeekApiKey === "") {
    throw new DshEnvironmentError("DeepSeek proxy and controller credentials must be non-empty");
  }
  if (equalSecret(options.proxyToken, options.realDeepSeekApiKey)) {
    throw new DshEnvironmentError("The worker proxy token must differ from the real DeepSeek key");
  }

  const source = options.source ?? process.env;
  const environment: NodeJS.ProcessEnv = {};
  for (const name of DSH_WORKER_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }

  Object.assign(environment, {
    CI: "true",
    DSH_HOME: options.dshHome,
    DSH_PERMISSION_MODE: options.permissionMode,
    DSH_TELEMETRY_DISABLED: "1",
    DSH_TOOLS_MODE: "native",
    DEEPSEEK_API_KEY: options.proxyToken,
    DEEPSEEK_BASE_URL: options.proxyBaseUrl,
  });

  assertNoGitHubCredentials(environment);
  assertSecretAbsent(environment, options.realDeepSeekApiKey, "real DeepSeek API key");
  return environment;
}

export function collectControllerSecrets(environment: NodeJS.ProcessEnv): readonly string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      value.length >= 4 &&
      (isGitHubCredentialName(name) || name === "DEEPSEEK_API_KEY")
    ) {
      secrets.push(value);
    }
  }
  return secrets;
}

export function assertNoSecretOutput(
  channel:
    | "prompt"
    | "argv"
    | "environment"
    | "stdout"
    | "stderr"
    | "tool receipt"
    | "native tool observation",
  output: string,
  secrets: readonly string[],
): void {
  if (secrets.some((secret) => secret !== "" && output.includes(secret))) {
    throw new DshCredentialLeakError(channel);
  }
}

export function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.replaceAll(secret, "[REDACTED]");
  }
  return redacted.replace(
    /authorization:\s*bearer\s+[^\s,;]+/giu,
    "authorization: Bearer [REDACTED]",
  );
}
