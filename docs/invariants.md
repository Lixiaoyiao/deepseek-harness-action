# Architecture invariant catalog

This catalog gives the small set of system-level invariants stable identifiers.
It is an index, not a second policy engine: production code remains the source
of enforcement, and tests exercise public behavior without importing a shared
decision implementation merely to reproduce its answer.

## INV-001 NativeRequiresDocker

Native composition is rejected unless effective isolation is Docker; a host
`dsh-executable` is controlled-mode compatibility only.

Evidence: `test/inputs.test.ts`, `test/security-invariant-matrix.test.ts`, and
`test/dsh-composition.test.ts`.

## INV-002 ExplicitDenyWins

An exact `disallowed-tools` entry takes precedence over preset expansion,
requested grants, trust eligibility, and provider availability. Its denial is
reported as an explicit deny before lower-precedence reasons.

Evidence: `test/permission-profile.test.ts`, `test/tools.test.ts`, and the
six-axis matrix in `test/security-invariant-matrix.test.ts`.

## INV-003 ControllerCredentialsNeverEnterWorker

The Controller's DeepSeek and GitHub credentials must not enter worker
environment variables, argv, prompts, extension configuration, validation, or
result channels. The worker receives only mediated or extension-owned authority.

Evidence: `test/dsh-env.test.ts`, `test/extensions.test.ts`,
`test/security-invariant-matrix.test.ts`, and `test/authority.test.ts`.

## INV-004 GithubMutationRequiresValidation

An Action-owned GitHub mutation is deferred until the applicable Controller
validation and final revalidation succeed. Cancellation or validation failure
must leave the mutation queue unflushed.

Evidence: `test/github-tools.test.ts`, `test/orchestrator-no-change.test.ts`,
`test/fix.test.ts`, `test/implement.test.ts`, and `test/task.test.ts`.

## INV-005 NativeInventoryIsObservedNotGranted

Native DSH-discovered tool names are emitted only as `observedTools`. They are
never represented as Controller `requestedTools`, `effectiveTools`, or
`deniedTools`, and observation is not an authorization input.

Evidence: `test/dsh-composition.test.ts`, `test/dsh-runner.test.ts`,
`test/native-ecosystem.integration.test.ts`, and
`test/security-invariant-matrix.test.ts`.
