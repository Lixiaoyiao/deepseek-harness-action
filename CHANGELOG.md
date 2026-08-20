# Changelog

Notable user-facing changes are recorded here. This project follows semantic
versioning for published action releases.

## [0.3.0] - Unreleased

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

- All v0.2 inputs remain valid. `command: auto` keeps the established automatic
  review and `workflow_run` diagnose/fix routing; the new task inputs have
  conservative defaults (`task-access: read`, `max-turns: 3`, and no configured
  command tools).
- The v0.2 scalar outputs and schema-v1 `result-json` envelope remain available.
  `task` is an additional `operation` value, and loop metadata is additive.
- Existing released examples remain pinned to the immutable v0.2.0 action SHA.
  The new task-automation example is marked as a planned v0.3 interface and
  must be pinned to the immutable v0.3 release SHA after publication.

### Security

- `--write` and `task-access: write` request a capability; they do not grant it.
  The controller still requires `allow-write: "true"`, a same-repository
  non-`pull_request_target` context, trusted originating actors, and the
  applicable workspace/tool allowlists before any write is possible.
- Fixed command argv is authored by the workflow maintainer, executed in a
  credential-free hardened container, and exposed only when both policy and
  `allowed-tools` permit it. Tool output is untrusted feedback and is redacted
  and bounded before another model turn.
- Generic task automation rebinding checks the default-branch head before
  validation, commit, branch creation and pull-request creation.

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

[0.3.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/releases/tag/v0.1.0
