# Changelog

Notable user-facing changes are recorded here. This project follows semantic
versioning for published action releases.

## Unreleased

### Added

- Added the experimental `dsh-mode` input with `controlled` as the compatible
  default and `native` as an explicit opt-in. Native uses the locked official
  DSH `0.1.1-rc.2` headless composition and leaves DSH in ownership of its
  internal capability graph; it is not a relaxed version of the controlled
  ToolRuntime profile.
- Added mode and composition observability. Controlled runs continue to report
  Controller-owned requested/effective/denied tool policy. Native runs report
  `policyOwner: dsh` and the runtime-observed tool names as `observedTools`
  telemetry, with no Controller `effectiveTools` claim in that audit.
- Added a composition-aware, definition-only native extension schema. Native
  MCP definitions contain transport and owner/process requirements but no
  declared tools, grants, call counts, output budgets, or Action manifests;
  Bundle and Plugin definitions likewise declare only an exact package source,
  owner-level network/workspace-write requirements, and direct-Plugin config.
- Native now composes MCP through official
  `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2`, configured Bundles as official
  Profile layers, and direct Plugins through Cordis. DSH remains responsible
  for discovery, registration, invocation, and the final model-visible
  inventory. Repository `.dsh/skills` and `.agents/skills` are discoverable in
  the Action's `.git`-less workspace, while the locked native Skill, Subagent,
  and Workflow capabilities remain part of the official graph.

### Security and compatibility

- `controlled` remains the default and preserves the v0.7.0 behavior for
  workflows that do not configure `dsh-mode`. `permission-profile` is neither
  reused nor reinterpreted as a composition selector.
- Native is Docker-only and fails closed for host isolation. The worker still
  receives neither the real DeepSeek key nor the real GitHub token; repository
  and actor trust, the Controller GitHub Gateway, validation/revalidation,
  deferred mutation, deadlines, cancellation, and secret redaction remain
  outside the DSH composition.
- Native extension admission still requires trusted workflow configuration and
  Action policy. Third-party packages require an exact semver or immutable
  GitHub commit, install with lifecycle scripts disabled, and pass installed
  identity, lock, and pre-existing runtime-package inventory audits. Extension
  credentials are masked and represented only by value-free authority-source
  records; values and hashes never enter the public audit. The real DeepSeek
  key and Action GitHub token remain forbidden in worker extension config.
- Native MCP and direct Plugin credentials may use explicit `credentialEnv`,
  `credentialHeaders`, and `credentialConfig` maps. Their values are merged into
  only the corresponding extension config, masked regardless of key name, and
  represented only by a value-free owner record. Immediately before Profile
  rendering, admitted definitions are also rescanned against ambient withheld
  GitHub, OIDC, and DeepSeek values so aliasing a Controller credential fails
  closed.
- Native `network` and `workspaceWrite` declarations request process-level
  outer authority. If any admitted native owner needs bridge networking, the
  entire native worker shares that bridge path; a writable repository mount is
  likewise a worker boundary, not a per-tool sandbox or Controller grant.
- Controller-owned `github.*` capabilities remain mode-independent and retain
  GitHub Gateway binding, revalidation, validation, and deferred-mutation
  gates. A user-configured GitHub MCP with its own credential is instead a
  trusted external extension; its direct effects are not protected by those
  Gateway guarantees. No Action-owned GitHub MCP backend is added.

### Deferred and out of scope

- This change does not publish v0.8.0, create or move a release tag, change the
  locked DSH version, add an Action-owned GitHub MCP backend, or implement
  Session/Resume. Full v0.8 qualification remains a separate follow-up.

## [0.7.0] - 2026-08-25

### Changed

- Added the internal `DshComposition` seam around DSH launch construction.
  `ControlledComposition` remains the sole production implementation and keeps
  the existing controlled Profile, Bundle/Cordis, local policy, runtime-asset,
  and Docker preparation behavior.
- Made tool-policy ownership explicit in the public audit. The current
  Controller-owned composition reports canonical requested, effective, and
  denied tools; the distinct DSH-owned shape reserves observed runtime names
  as telemetry rather than mislabeling them as Controller grants.
- Added an additive, value-free `result-json.authority` audit for
  Action-known sources: the Controller-held GitHub and proxied DeepSeek
  credentials, plus effective MCP or direct-plugin owners configured with
  credential-like workflow data. This is bounded observability, not an
  authorization decision or a claim of complete worker authority.
- Isolated the six existing typed GitHub operations behind the transport-only
  `GitHubToolBackend` contract and the production Octokit adapter. Repository,
  entity, head, policy, trust, validation, retry, reconciliation, and receipt
  ownership remain in the Controller-side GitHub tool gateway.

### Security and compatibility

- Existing Action inputs, canonical tool IDs, routing defaults, permission
  gates, and write behavior remain compatible. The structured result adds the
  tool-policy ownership and known-authority audit surfaces described above.
- The audited DSH family remains exactly `0.1.1-rc.2`; the standalone
  `create-deepseek-harness-action@0.1.1` package and its immutable v0.6.0
  Action binding remain unchanged.
- Unit and integration tests cover the seams and audit semantics; metadata and
  Core E2E assertions bind the applicable public tool-policy surface. Standard
  release-contract and reproducible-`dist` checks remain in force, and the
  committed bundle is regenerated from the release source.

### Deferred and out of scope

- This release does not implement `NativeComposition`, a native DSH ecosystem
  mode, a GitHub MCP backend, or Session/Resume. It adds no new GitHub operation
  and does not widen model, worker, extension, credential, or mutation
  authority.

## Installer 0.1.1 - 2026-08-24

- Updated the standalone `create-deepseek-harness-action` package so its
  controlled pack step binds both generated workflows to the immutable v0.6.0
  release commit. The npm package remains versioned independently from the
  Action.
- Preserved credential-free checkout, trusted-base fork review, minimum token
  permissions, Docker isolation, explicit write opt-in, fail-closed validation,
  strict Validation Integrity, and overwrite refusal. No Action runtime or
  v0.6.0 tag content changed.

## [0.6.0] - 2026-08-23

### Added

- Added maintainer-controlled `trigger-phrase`, label/assignee routing,
  actor/bot routing allowlists, and historical-comment include/exclude filters.
  Defaults preserve the exact `@dsh` behavior; routing configuration does not
  grant actor, fork, token, or write authority.
- Added `base-branch`, validated `branch-prefix`, and a deterministic
  `branch-name-template`. The template supports only Controller values, must
  retain `{{prefix}}` and the collision key `{{key}}`, and is sanitized and
  bounded before any ref operation. PR fixes remain bound to their audited head.
- Added six exact Controller-owned GitHub tools for Issue/PR labels and
  assignees, Issue state, comment creation, PR metadata, and check/status reads.
  Repository, entity, and head identity are never model inputs; there is no
  arbitrary REST, GraphQL, raw URL, or credential pass-through.
- Added optional `task-output-schema` and `task-output`. The Controller accepts
  a bounded safe JSON Schema subset from trusted configuration, validates model
  `taskOutput` twice, and adds the value as an optional field inside the
  unchanged schema-v1 `result-json` audit envelope.

### Security and compatibility

- GitHub mutation tool requests are exact-ID and policy-intersected, require
  trusted-write plus `allow-write`, Docker, and Controller validation, and are
  deferred until finalization. Entity revalidation, bounded retries,
  postconditions, ambiguous-failure reconciliation, and bounded receipts apply.
  Confirmed or possible partial external effects are reported as
  `partial-success` rather than as an ordinary retry-safe failure.
- All prior credential, fork/trust/write, Docker, protected-path, validation,
  Validation Integrity, and exact DSH audit gates remain in force. Controller
  credentials are rejected from public branch configuration and task schemas.
- Existing inputs, scalar outputs, default branch names, and fixed
  `result-json` schema version remain compatible. Default branch configuration
  also preserves the exact v0.5.3 task identity and reconciliation key. The
  audited DSH family stays exactly `0.1.1-rc.2`; the standalone installer
  remains unchanged.
- The overall `timeout-minutes` deadline now starts before Controller GitHub
  permission, context, and immutable repository materialization requests. The
  same abort signal reaches every Octokit request, so a stalled pre-agent API
  request fails closed instead of outliving the configured Action deadline.

### Deferred and out of scope

- GitHub image attachments remain disabled. The exact audited DSH headless
  entrypoint exposes only a single text-task contract, so v0.6.0 keeps Markdown
  images inert rather than downloading or forwarding them through an
  unofficial multimodal path.
- Session/Resume, cross-run conversation state, Agent Teams, GitHub App/OAuth,
  commit signing, arbitrary GitHub APIs, and unrelated orchestrator,
  Validation Integrity, or E2E rewrites are not included.

## [0.5.3] - 2026-08-23

### Fixed

- Decoupled stable error identity from the mutable Controller lifecycle phase.
  Known configuration, policy, domain, and runtime errors now carry stable
  `code`, `category`, and `retryable` semantics, while `phase` records only
  where the error surfaced. Extension policy denials raised during context
  preparation now remain `POLICY_DENIED` instead of becoming
  `CONTEXT_PREPARATION_FAILED`; otherwise-unclassified exceptions use the
  phase-independent `ACTION_RUNTIME_FAILED` identity.
- Replaced the unconditional `repositoryPaths()` Git-error fallback with an
  explicit source contract. Git checkouts remain tracked-files-only and fail
  closed on any `git ls-files`, normalization, truncation, or file-limit error;
  only Controller-materialized `.git`-less trees use the bounded filesystem
  walk required by the immutable GitHub tree worker path.

### Security documentation

- Defined Validation Integrity as high-confidence validation weakening
  detection plus baseline replay for supported validation entrypoints, package
  scripts, test/config weakening, lock/toolchain controls, and known
  wrappers/interpreters. It is not complete cross-language dependency
  provenance or a formal integrity proof.
- Documented that validation may use Docker bridge networking and that
  repository code on a self-hosted or corporate-network runner may reach
  services accessible through the runner's network path.

### Compatibility and scope

- Existing scalar Action outputs and the schema-v1 `result-json` envelope remain
  compatible; classified failures add the backward-compatible
  `result-json.error.category` field, and corrected classification may change a
  previously phase-derived error code or status.
- `validation-integrity` still defaults to `warn`. Protected paths, exact DSH
  `0.1.1-rc.2` pins, per-version audit policy, E2E architecture, write gates,
  and installer behavior remain unchanged.
- This release adds no product features. Session/Resume, GitHub Tools, new
  triggers, branch/image/structured-output features, protected globs, and
  installer changes remain out of scope.

## [0.5.2] - 2026-08-23

### Added

- Added the independent `create-deepseek-harness-action` npm package at
  version `0.1.0`. `npm create deepseek-harness-action@latest` can generate a
  safe PR-review workflow, an `@dsh` coding-command workflow, or both without a
  server, database, OAuth flow, or GitHub App.
- Added explicit non-interactive selection for CI and automation. The installer
  creates `.github/workflows/` when needed, reports every created file, and
  refuses to overwrite an existing target workflow.

### Changed

- Made the installer the primary Quick Start while retaining the complete
  manual workflow setup. The coding template leaves repository validation as
  an explicit required replacement instead of assuming an npm project.
- Added installer coverage for Review, Commands, Both, directory creation,
  overwrite refusal, non-interactive execution, YAML parsing, and the generated
  workflow security contract.

### Security and scope

- Generated workflows preserve credential-free checkout, trusted-base-only
  fork review, minimum GitHub permissions, and the existing Controller/worker
  credential boundary. Write-capable commands still require explicit
  `allow-write`, Docker isolation, Controller validation, and strict validation
  integrity.
- The published installer templates bind the Action to the full immutable
  commit SHA resolved from the formal v0.5.2 tag. That SHA is injected only
  after the tag and GitHub Release exist and is verified in the npm tarball;
  no guessed pre-release SHA is shipped.
- This is an installer and onboarding release only. The Agent core, Action
  inputs and outputs, permission semantics, and schema-v1 `result-json` remain
  unchanged. The audited DSH family remains exactly `0.1.1-rc.2`.
- Session/Resume, Label or Assignee triggers, custom trigger phrases, branch
  templates, image support, GitHub App behavior, commit signing, Agent Teams,
  and unrelated feature expansion remain out of scope.

## [0.5.1] - 2026-08-22

### Changed

- Upgraded the audited DeepSeek Harness runtime from `0.1.0-rc.8` to exact
  `0.1.1-rc.2` pins. Every directly used `@deepseek-ai/dsh*` package, including
  app-boot, MCP, native-tool, Profile/Bundle, and supporting runtime packages,
  is a top-level exact pin backed by the committed lockfile. Floating versions,
  `latest`, semver ranges, and floating Git references remain rejected.
- Re-audited rc.2 app-boot, Profile/Bundle/Plugin composition, MCP,
  ToolRuntime, Bash, Web Search, Subagent, receipt, Docker/path/timeout, and
  bundled `dist` behavior. Existing Action inputs, outputs, permission
  semantics, and schema-v1 `result-json` remain compatible.
- Split DSH runner responsibilities into run-scoped process launch, exact
  installation/inventory audit, network and Docker policy, Profile assembly,
  receipt reconciliation, timeout, and cleanup boundaries. Validation
  integrity now separates normalized command-graph discovery and replay
  planning from execution.
- Added independent bounded budgets for runtime creation/install, extension
  install, each Agent turn, and Controller validation. Each execution phase is
  also bounded by the remaining overall deadline, so setup cannot consume or
  extend the complete task budget. Cleanup and cancellation finalization use
  separate fixed short best-effort grace periods after the outcome/deadline.
- Generalized the release canary to `DSH_RELEASE_CANARY_SHA`. The canary binds
  its full candidate SHA to the formal v0.5.1 tag and non-draft,
  non-prerelease GitHub Release before using the immutable local checkout. A
  secretless gate also binds execution to the live `main` default-branch SHA;
  the secret-bearing smoke job uses the protected, main-only `core-e2e`
  environment.

### Fixed

- `SIGTERM` and `SIGINT` now abort the active Agent/worker and trigger bounded,
  best-effort resource cleanup and terminal sticky-comment publication. The
  comment attempt begins immediately and may run concurrently with cleanup;
  terminal-state guards reject late progress, while a later authoritative
  failure can correct provisional cancellation. A forced `SIGKILL`, runner/host
  loss, process crash, or network/GitHub API outage still cannot guarantee that
  finalization code runs.
- Runtime setup now rolls back partially created state, and secondary proxy or
  cleanup failures no longer replace the primary task result. Docker command
  cancellation is propagated through the active worker and validation paths.
- Controller credentials are now rejected from the trusted task prompt as well
  as configured validation/tool argv. The final worker prompt, argv, and
  environment are checked again immediately before launch, and worker output or
  receipts containing a withheld credential fail closed without echoing it.
- Validation integrity now follows package-script lifecycle chains and
  interpreter, environment, shell, and package-executor wrappers; treats bound
  toolchain manifest/lock replacement as a control-plane change; and detects
  removed validation keys even when unrelated keys are added. Each reproduced
  bypass has regression coverage and still blocks all GitHub mutation in strict
  mode.
- A repair turn that returns `blocked`, exhausts its turns, or emits malformed
  structured output can no longer downgrade an unresolved Controller validation
  or Validation Integrity failure. The original failure and integrity audit
  remain authoritative until a later finalization actually passes; GitHub
  mutation remains blocked throughout.
- The controlled root Profile now places its single-JSON output protocol after
  rc.2 tool guidance and binds the final `operation` field to the exact
  Controller-selected operation. Web Search Markdown citations must remain
  inside JSON string fields, while inferred operation changes, fences, prose,
  and separate citation suffixes still fail closed; delegated subagents
  continue to return ordinary content to the root.
- Root turns now treat Controller-catalog requests as an immediate
  `needs_tool` boundary instead of attempting to emulate the fixed Controller
  command with DSH runtime tools. This prevents an rc.2 internal tool loop from
  consuming the Agent budget before the Controller can run the requested
  bounded command; delegated subagents remain unaffected.

### Performance and verification

- DSH receipt collection uses ranged reads from the previous byte offset and
  set-based order reconciliation. Repeated multi-turn collection processes new
  receipt records without rescanning the complete file; the public receipt
  schema and security meaning are unchanged. No synthetic percentage claim is
  made for workload-dependent performance.
- Unit and integration coverage is organized around policy/schema/parsing and
  error classification, plus DSH/Profile/MCP/runtime/validation composition.
  Release qualification keeps real E2E focused on the strict, Bash, Web Search,
  native Subagent, MCP allow/deny, Profile/Bundle, validation-integrity,
  validation-failure, trusted-write, no-change, cancellation, and
  credential-free checkout golden paths.

### Security and scope

- The Agent still receives neither the real `GITHUB_TOKEN` nor the real
  DeepSeek key. GitHub mutation remains Controller-only after actor, fork,
  origin, SHA, protected-path, validation, and validation-integrity gates;
  read-only and `.git`-less Docker boundaries are unchanged.
- ToolRuntime limits model-routed calls; it does not sandbox an approved stdio
  MCP executable, Bundle, or Plugin during launch, initialization, background
  work, or direct process I/O. Such extensions remain trusted worker code
  behind exact manifests, inventory audits, Docker isolation, and explicit
  installation/network/workspace gates.
- Session/Resume, Label/Assignee triggers, custom trigger phrases, branch
  templates, Agent Teams, a GitHub App/installer, and other product expansion
  remain out of scope for this maintenance release.

## [0.5.0] - 2026-08-22

### Added

- Agent permission profiles: `strict` preserves the v0.4 safety default,
  `standard` provides the common trusted-maintainer coding set, and `custom`
  starts from an empty preset for exact advanced configuration. The stable
  native autonomy IDs are `native.bash`, `native.web-search`, and
  `native.subagent`.
- Exact `disallowed-tools` support across `workspace.*`, `native.*`,
  `command.<name>`, `mcp.<server>.<tool>`, and
  `plugin.<extension>.<tool>` IDs. Deny entries always win after preset and
  explicit allow expansion.
- Controller-owned `validation-integrity` modes. `off` records validation
  definition changes, `warn` reports them, and `strict` blocks
  high-confidence weakening or replays changed controls against their bound
  baseline. Normal implementation and test changes remain supported.
- Permission observability in Action outputs, `result-json`, and the step
  summary: resolved profile, effective tools, the physical `host-gateway`,
  `mediated-web`, or `bridge` worker path, workspace write, trusted extensions,
  denied tools, and their reasons.
- A lightweight weekly/manual release canary with one read-only smoke job and
  no test matrix or GitHub mutation authority.

### Changed

- Trusted coding workflows can opt into DSH-native Bash, mediated web search,
  and a bounded subagent through `standard`; review remains near-zero
  configuration on `strict`. MCP, Bundle, Plugin, and other precise policies
  use `custom`.
- `native.web-search` is mediated through a Controller proxy. The worker never
  receives the real DeepSeek key, and this path does not grant arbitrary bridge
  egress. Any full bridge network remains an explicit Controller policy choice.
- An authorized `@dsh task --write` that produces no repository change now
  publishes its final answer to the resolved Issue/PR after actual-change
  inspection, while creating no commit, ref, pull request, or release mutation.
- Run-scoped DSH work can reuse only a runtime whose exact version, image,
  isolation, real workspace, chat/search endpoint, host executable identity,
  extension digest, native tools, workspace/network mode, and Profile schema
  binding match. An ephemeral npm cache avoids duplicate acquisition work
  within that bound run; lock and inventory audits remain in force.
- `allowed-tools` is additive after a `strict` or `standard` preset expands.
  Workflows that relied on a smaller exact v0.4 allowlist should select
  `custom`, or add exact `disallowed-tools` entries, instead of assuming that an
  allowlist replaces a preset.
- README, Chinese README, security guidance, and all current examples now start
  new users on v0.5.0. Historical v0.3/v0.4 release behavior remains recorded
  below.

### Security

- Permission profiles govern only Agent tools inside the sandbox. The Agent
  cannot raise its profile, approve extensions, receive the real
  `GITHUB_TOKEN` or DeepSeek key, or perform commit/push/PR/release operations.
  Every GitHub mutation remains Controller-only after actor, origin, identity,
  actual-change, validation, and validation-integrity gates.
- MCP, Bundle, and Plugin startup remains trusted code execution behind exact
  manifests, Docker isolation, positive tool policy, installation opt-in,
  package inventory checks, and immutable pins.
- v0.5.0 deliberately retains exact `@deepseek-ai/dsh@0.1.0-rc.8`,
  `@deepseek-ai/dsh-mcp-client@0.1.0-rc.8`, and the committed dependency lock.
  No DSH or application dependency pin changed for this release.

### Compatibility and deferred work

- The default `strict` profile keeps v0.4 review, diagnose, fix, implement,
  auto/task, multi-turn, sticky-comment, and Controller-owned GitHub write
  behavior. Existing inputs, legacy scalar outputs, and the schema-v1
  `result-json` envelope remain available.
- Session/resume, Label or Assignee triggers, custom trigger phrases, branch
  templates, Agent Teams, and unrelated platform expansion remain out of scope.

## [0.4.0] - 2026-08-21

### Added

- Native MCP integration through the official
  `@deepseek-ai/dsh-mcp-client@0.1.0-rc.8`. Maintainer-owned `mcp-config`
  supports the official `stdio` and `streamable-http` transports, while
  `allowed-tools` separately exposes only selected `mcp.<server>.<tool>` IDs.
- Native DSH Bundle/Profile integration. The Controller validates trusted
  workflow configuration, generates a controlled `github-action` Profile and
  Cordis patch, and loads only explicitly configured Bundles and plugins.
- Strict `plugin-config` validation for exact npm versions or GitHub
  `git+https` sources pinned to a 40-character commit. Third-party installation
  is disabled by default and requires `allow-plugin-install: "true"`.
- A positive Action-owned DSH ToolRuntime policy for native, MCP and plugin
  tools. Read, workspace-write and network capabilities are intersected with
  Controller policy; per-call timeout, serialized output size, per-tool calls
  and per-owner calls are bounded across the multi-turn loop.
- Extension audit identity and bounded receipts in structured results, plus the
  additive `extension-profile-digest` and `tool-receipts` scalar outputs. The
  latter serializes separate `controller` and `dsh` receipt arrays plus explicit
  `truncated` and `droppedCount` metadata.
- A controlled MCP/Profile workflow template in
  `examples/controlled-extensions.yml`.

### Changed

- Upgraded the only accepted DSH runtime from exact
  `@deepseek-ai/dsh@0.1.0-rc.6` to exact `0.1.0-rc.8`, with the matching MCP
  client pinned exactly. Shipped DSH dependencies are installed from the
  committed lockfile rather than a floating `latest` or semver range.
- Replaced the v0.3 extension-provider placeholder with adapters for DSH's
  official Profile, Bundle, Cordis plugin and ToolRuntime mechanisms. The
  Action does not maintain a parallel plugin system.
- The controlled Profile starts through the official
  `@deepseek-ai/dsh-app-boot@0.1.0-rc.8` public API instead of the general CLI path.
  Workspace/`$DSH_HOME` `.env` discovery and dynamic user-patch watch/hot reload
  are skipped.
- DSH-native, MCP and plugin tools now use a positive runtime policy. Only
  selected/effective tools are required to register. Before restriction,
  `visible ⊆ known` and `allowed ⊆ visible`; afterwards,
  `visible == allowed`. A configured but unselected known tool may be absent but
  cannot remain model-visible after restriction. The existing fixed-argv
  `command.*` ToolRouter remains controller-side, and both execution planes are
  compiled from the same fail-closed Controller policy and monotonic call guard.
- MCP's server-wide `toolCallTimeoutMs` is the maximum timeout among that
  server's effective allowed tools; the Action-owned per-tool policy then
  applies each tool's own potentially tighter deadline.
- DSH admission and completion events are reconciled into final per-call
  receipts and aggregated across fresh turns. A post-admission worker crash is
  retained as `completed:false`, and final output bounding reports exactly how
  many receipts were dropped.
- The redacted extension audit digest is bound into public task identity, while
  the Controller-only complete configuration digest separately binds runtime
  reuse. Secret-bearing MCP or plugin configuration is never hashed into a
  public branch name or pull-request marker.
- Repository writes now always require `run-tests=true`, a non-empty
  `test-commands` list, and success from every Controller validation command.
  `run-tests=false` now denies a write instead of waiving validation; this is an
  intentional breaking security hardening.

### Compatibility

- Workflows that leave `mcp-config` and `plugin-config` empty and keep
  `allow-plugin-install=false` retain the v0.3 review, diagnose, fix,
  implement, auto, task, multi-turn, sticky-comment and Controller GitHub-write
  paths, except for mandatory write validation and deferral of write-task
  comments until that validation succeeds.
- Existing v0.2/v0.3 input names, scalar outputs and schema-v1 `result-json`
  remain available. Extension audit and receipt fields are additive.
- DSH rc.8 supplies the official app-boot public API used to start the
  controlled headless Profile; the compatibility work includes the exact
  dependency lock, explicit Profile generation and positive tool policy.

### Security

- Model output, repository files, fork content, issues, pull requests and CI
  logs cannot alter `mcp-config`, `plugin-config`, `allowed-tools` or
  `allow-plugin-install`. Capability-bearing values must come from trusted
  workflow configuration.
- `container-image`, `base-url`, `isolation`, and `dsh-executable` are documented
  as trusted capability inputs because they choose worker code, credential
  routing, or the process boundary. Every image value is validated as one
  Docker/OCI reference before use, preventing it from becoming a Docker option;
  writes and extensions additionally require an immutable digest.
- Fork and other untrusted profiles receive no MCP or plugin tools. Workspace
  write still requires every existing actor/origin/SHA gate, protected-path
  check and successful final validation before any GitHub mutation, including a
  write-task status comment.
- Stdio MCP launch rejects shells, package managers, Git and dynamic runners;
  HTTP MCP requires explicit network authority. Configured extension values
  cannot contain the Controller's GitHub token or real DeepSeek key. The check
  recursively scans keys and string values, including percent-decoded variants
  of URL material. Extension-secret masking covers withheld URL path/query
  candidates and credential-like argv, env, header and nested plugin-config
  fields without masking ordinary values such as `read` or `safe-json`.
  Structured HTTP audit data exposes the endpoint origin but withholds pathname,
  query and headers.
- Third-party Bundle/plugin installation and startup are treated as trusted
  code execution, as is starting an approved stdio MCP executable. Exact
  top-level pins and ToolRuntime call guards constrain model-routed calls but do
  not sandbox initialization, background work, direct process I/O, or replace
  review of transitive dependencies and runner-level network/filesystem
  controls. The Controller snapshots the top-level runtime package inventory
  before installation and rejects any package removal or version change
  afterwards.
- Invocation-count state and receipts are telemetry rather than authorization
  inputs or tamper-proof logs; approved trusted extension code shares the worker
  and can influence them. `network=false` blocks ordinary external egress but
  the Controller still maps `host.docker.internal` to the internal network's
  inspected IPv4 gateway for the LLM proxy. That host-gateway path is not a port
  allowlist, so runner firewall policy remains the boundary for other host
  services; package acquisition separately uses bridge networking.
- The Agent still receives no unrestricted shell, `GITHUB_TOKEN`, real
  DeepSeek API key, commit, push, pull-request or release authority. The
  Controller remains the only code/ref/pull-request writer after validation
  succeeds. Read-only lifecycle comments remain available during execution;
  write-task comments are deferred until final validation succeeds, so a failed
  gate produces no GitHub API write.

### Verification status

- Unit and integration coverage is added for rc.8 compatibility, official MCP
  calls and denial paths, timeout/crash/call limits, package allowlisting and
  pin validation, workspace/network permissions, multi-turn MCP calls,
  untrusted actor/fork escalation attempts, malicious prompt escalation and
  validation-gated GitHub writes.
- Real DeepSeek API, external MCP endpoint and live GitHub write E2E are not
  represented as completed by this development changelog. Their final status
  must be reported from the release candidate verification run.

### Deferred

- Session resume, label and assignee triggers, branch templates and Agent Teams
  remain out of scope for v0.4.0.
- Per-destination network allowlisting and sandboxing of trusted third-party
  startup code are not provided by the tool-call permission model.

## [0.3.0] - 2026-08-21

### Added

- A general `task` operation for natural-language questions, repository
  analysis, and coding work. Interactive commands use `@dsh task --read ...`
  or `@dsh task --write ...`; `--read` is the default when the access flag is
  omitted.
- Explicit-prompt automation for `workflow_dispatch`, `repository_dispatch`
  and `schedule` contexts. With `command: auto`, a non-empty trusted `prompt`
  selects `task`; `command: task` remains available when callers want an
  explicit route.
- A controller-owned multi-turn loop. Fresh DSH turns can request an allowed
  tool, receive bounded/redacted tool output, or repair a change after
  controller validation returns bounded stdout/stderr. `max-turns`, the
  overall deadline, per-tool call limits and no-progress detection bound the
  loop.
- Maintainer-defined command tools through the versioned `tool-config`
  manifest and `allowed-tools` allowlist. Each command has fixed argv,
  timeout, output, call-count, network and workspace-access limits; command
  tools accept no model-provided argv, and common direct shell executables are
  rejected as an additional guard.
- Provider-neutral internal contracts for agent engines, tool providers,
  extension providers and session stores, including repository/head/policy/
  task/toolset bindings for any future resume implementation.
- Loop observability in `result-json`, including turn, tool-call and validation
  retry counts plus bounded tool receipts.

### Changed

- The DSH structured-output protocol is now explicitly versioned and carries a
  terminal state of `final`, `needs_tool` or `blocked`. Tool execution and
  repository validation remain controller-owned; DSH itself still receives no
  shell or GitHub credentials.
- A write-capable generic automation task creates a dedicated `dsh/task-*`
  branch and pull request after controller validation. It does not push
  directly to the default branch.
- `task` has its own controller-owned sticky marker when an Issue or pull
  request supplies a comment target. A read task with no entity target returns
  its answer through the action summary and outputs.

### Compatibility

- The v0.2 input names and defaults remain compatible. `command: auto` keeps
  the established automatic review and `workflow_run` diagnose/fix routing;
  the new task inputs have conservative defaults (`task-access: read`,
  `max-turns: 3`, and no configured command tools).
- The v0.2 scalar outputs and schema-v1 `result-json` envelope remain available.
  `task` is an additional `operation` value, and loop metadata is additive.
- The Quick start and all current examples are pinned to the immutable v0.3.0
  runtime commit exercised by the release checks.
- Configurations that embed controller credentials in configured argv, or
  depend on generated root `.git`/`node_modules` content entering validation,
  now fail closed.

### Security

- `--write` and `task-access: write` request a capability; they do not grant it.
  The controller still requires `allow-write: "true"`, a same-repository
  non-`pull_request_target` context, trusted originating actors, and the
  applicable workspace/tool allowlists before any write is possible.
- Fixed command argv is authored by the workflow maintainer, executed in a
  credential-free hardened container, and exposed only when both policy and
  `allowed-tools` permit it. Tool output is untrusted feedback and is redacted
  and bounded before another model turn.
- Controller credentials are rejected if a maintainer embeds them in command
  tool or validation argv. Validation also excludes generated root `.git` and
  `node_modules` content that cannot be included in the published change.
- Generic task automation rebinding checks the default-branch head before
  validation, commit, branch creation and pull-request creation.
- Issue-backed writes bind the issue's trusted content and state while allowing
  controller-owned sticky-comment updates; specification edits still fail
  closed before publication.

### Deferred

- Real MCP server connections, plugin discovery/installation/execution, and
  cross-run session persistence or resume are **not enabled in v0.3.0**. The
  provider/session interfaces are extension seams only; this release adds no
  public MCP, plugin or resume inputs and emits no reusable session token.

## [0.2.0] - 2026-08-15

### Added

- Controller-owned sticky lifecycle updates for context preparation, DSH
  execution and final publication/write. Progress reuses the existing v1
  `summary`, `diagnosis` or `write` marker instead of creating another comment.
- The `progress-comment` input, enabled by default, for disabling intermediate
  lifecycle updates without disabling normal final review, diagnosis or fix
  publication.
- A versioned `result-json` output on success, neutral and failure paths. The
  schema v1 envelope carries the resolved status and operation plus applicable
  timing, policy/capabilities, isolation, publication, validation, write,
  comment and error details.
- Scalar outputs for `summary`, `commit-sha`, `trust`, `duration-ms`,
  `comment-id`, `error-code` and `error-message`.
- Stable, redacted and bounded failure descriptions with a code, phase, title,
  guidance and retryability signal. Terminal statuses now distinguish timeout,
  validation failure and policy denial from an ordinary failure.
- Typed controller-validation failures that distinguish a non-zero exit from a
  timeout and report whether captured output was truncated. Validation setup
  and container failures are now attributed to the validation phase rather than
  a later repository write.

### Changed

- Failure and neutral paths now produce the same output envelope as successful
  runs, making downstream workflow handling deterministic.
- GitHub Actions step-summary publication is best effort and no longer turns an
  already-completed review or trusted write into a failed/retried mutation.
- Fix results now propagate commit SHA, changed paths and partial-success state
  into the controller outcome. Issue implementation reports its branch and pull
  request in the same structured result model.
- Lifecycle failures update the operation's sticky comment with an actionable
  next step when a comment target is available. Progress API failures remain
  secondary warnings and do not mask the primary operation result.
- README and security guidance now describe actor trust, untrusted input data,
  worker execution profiles, and controller commit authority as four separate
  boundaries.

### Compatibility

- Existing inputs remain valid. `progress-comment` defaults to `true` and may be
  explicitly disabled.
- Existing outputs `conclusion`, `operation`, `review-summary`,
  `findings-count`, `branch-name` and `pull-request-url` remain available.
  `review-summary` is now the backward-compatible alias of the general
  `summary` output.
- Existing controller-owned v1 tracking markers remain the source of sticky
  comment identity; no marker migration is required.
- README and `examples/` action references are pinned to the immutable v0.2.0
  runtime commit exercised by the real E2E release checks.

### Security

- Packaged DSH policy profiles are now resolved relative to the installed
  JavaScript action rather than the caller workspace. Remote
  `uses: owner/action@ref` consumers cannot substitute repository files for a
  controller policy profile.
- Progress starts only after the controller has resolved a PR/Issue target and
  allowed the operation. Only comments owned by the configured numeric bot ID
  are eligible for in-place updates.
- Error fields and user-visible failures are bounded and redacted. Validated
  model-derived strings in the structured result remain untrusted observability
  data; they do not grant capabilities and are never used as authorization
  input.
- Model-reported verification remains separate from controller-executed,
  credential-free validation.

### Deferred

- This slice does not add run/head freshness data to the existing v1 sticky
  markers. Supplied workflows serialize per target with `concurrency`; custom
  workflows should do the same to prevent an older run from overwriting a newer
  sticky state.
- Streaming model-authored progress, high-frequency heartbeats and a new
  permission DSL remain out of scope. Lifecycle updates stay deterministic and
  controller-owned.

## [0.1.0]

- Initial public release with PR review, CI diagnosis, trusted fix and Issue to
  PR workflows, strict structured-output validation, controller-owned tracking
  comments and fail-closed write gates.

[0.7.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/releases/tag/v0.1.0
