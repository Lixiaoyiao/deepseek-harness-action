/** Release constants shared by runtime policy and repository contract checks. */
export const ACTION_VERSION = "0.8.0" as const;
export const ACTION_TAG = `v${ACTION_VERSION}` as const;
export const DSH_VERSION = "0.1.1-rc.2" as const;
export const RELEASE_CANARY_VARIABLE = "DSH_RELEASE_CANARY_SHA" as const;

/** Packages loaded by the production launcher or generated controlled Profile. */
export const DSH_RUNTIME_PACKAGES = [
  "@deepseek-ai/dsh",
  "@deepseek-ai/dsh-app-boot",
  "@deepseek-ai/dsh-atomic-write",
  "@deepseek-ai/dsh-authorization",
  "@deepseek-ai/dsh-base",
  "@deepseek-ai/dsh-cmdline",
  "@deepseek-ai/dsh-code-runtime",
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-fs-sandbox",
  "@deepseek-ai/dsh-fs",
  "@deepseek-ai/dsh-headless",
  "@deepseek-ai/dsh-invariants",
  "@deepseek-ai/dsh-launch-environment",
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-output-retention",
  "@deepseek-ai/dsh-permission-presets",
  "@deepseek-ai/dsh-sandbox-policy",
  "@deepseek-ai/dsh-sandbox",
  "@deepseek-ai/dsh-shell",
  "@deepseek-ai/dsh-spill",
  "@deepseek-ai/dsh-subagent",
  "@deepseek-ai/dsh-subagent-spawn-in-process",
  "@deepseek-ai/dsh-subagent-in-process-driver",
  "@deepseek-ai/dsh-tool-bash",
  "@deepseek-ai/dsh-tool-subagent",
  "@deepseek-ai/dsh-tool-web",
  "@deepseek-ai/dsh-timeout",
  "@deepseek-ai/dsh-user-approval",
  "@deepseek-ai/dsh-web",
  "@deepseek-ai/dsh-web-search-deepseek",
  "@deepseek-ai/dsh-workflow",
] as const;

/** Additional DSH packages imported directly by integration and policy tests. */
export const DSH_TEST_PACKAGES = [
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-scope",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-system-prompt",
  "@deepseek-ai/dsh-tools",
] as const;

export const DIRECT_DSH_PACKAGES = [...DSH_RUNTIME_PACKAGES, ...DSH_TEST_PACKAGES] as const;
