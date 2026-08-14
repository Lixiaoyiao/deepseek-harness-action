# Changelog

Notable user-facing changes are recorded here. This project follows semantic
versioning for published action releases.

## [0.2.0] - Unreleased

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
- Until v0.2.0 is published, README and `examples/` action references remain
  pinned to the released v0.1.0 commit SHA.

### Security

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

[0.2.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Lixiaoyiao/deepseek-harness-action/releases/tag/v0.1.0
