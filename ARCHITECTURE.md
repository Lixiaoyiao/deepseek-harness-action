# Architecture

DeepSeek Harness for GitHub is intentionally split into a trusted Controller
and a disposable DSH worker. The split exists to keep model execution useful
without treating model output, repository content, or extension code as GitHub
authority. The system-level promises are indexed in the
[invariant catalog](docs/invariants.md).

## Ownership

The **Controller** owns GitHub event routing, actor and repository trust,
credential routing, Action input validation, workspace preparation, deadlines,
Controller tools, validation, publication, and every persistent GitHub effect.
It decides what may happen before asking DSH to do work.

**DSH** owns the Agent turn and its composition. It receives bounded context and
only the worker authority selected by the Controller. DSH output remains
untrusted and must pass Controller schemas and policy before it can influence a
persistent effect.

**Validation** is Controller-owned. It runs against the disposable workspace
after an eligible change and before a commit, ref update, pull request, or typed
GitHub mutation is flushed. A model response cannot waive it
([INV-004](docs/invariants.md#inv-004-githubmutationrequiresvalidation)).

## Controlled and native composition

`controlled` is the compatibility default. The Controller builds the
`github-action-controlled` Profile, resolves a positive canonical tool set, and
owns the model-facing ToolRuntime policy.

`native` selects the official `dsh-native-headless` graph. DSH owns discovery
and the model-facing inventory for Profile, MCP, Bundle, Plugin, Skill,
Subagent, and Workflow capabilities. Native is Docker-only
([INV-001](docs/invariants.md#inv-001-nativerequiresdocker)), and its discovered
tool names are observations rather than Controller grants
([INV-005](docs/invariants.md#inv-005-nativeinventoryisobservednotgranted)).

The mode changes composition ownership, not trust. Actor checks, immutable
repository binding, credentials, workspace mounts, Controller tools,
validation, publication, cancellation, and output bounds remain outside DSH in
both modes.

## Tool policy

The Controller owns the Action capability catalog: `workspace.*`, `native.*`,
fixed-argv `command.*`, typed `github.*`, and controlled extension tool IDs.
Permission presets and requested tools are intersected with explicit denies,
trust, capability, isolation, and provider availability. An explicit deny has
deterministic precedence
([INV-002](docs/invariants.md#inv-002-explicitdenywins)).

Native DSH inventory is not copied into this catalog. The Action may report it
as `observedTools`, but telemetry does not become authority.

## GitHub authority

`GitHubAuthorityGateway` is the only Action-owned facade through which typed
GitHub tools execute. It preserves repository/entity/head bindings, queues
mutations, revalidates immediately before effects, reconciles uncertain API
outcomes, and emits bounded receipts.

The Backend is deliberately narrower: it adapts GitHub API transport and does
not decide policy. Keeping retries, postconditions, and revalidation behind the
Gateway prevents callers from accidentally treating a successful API call as
sufficient authorization. A separately configured GitHub MCP is external
extension authority and does not inherit Gateway guarantees.

## Credential and persistence boundaries

The real DeepSeek key remains in a run-scoped Controller proxy. The real GitHub
token remains in the Controller. Neither enters the DSH worker, repository
commands, validation, or model context
([INV-003](docs/invariants.md#inv-003-controllercredentialsneverenterworker)).
Explicit credentials for a trusted extension belong to that extension and do
not widen Controller authority.

Workspace write access changes only the disposable, `.git`-less worker copy.
Persistent GitHub authority is separate: the Controller must inspect the
change, validate it, revalidate the bound entity, and use its own credential to
perform an allowed mutation. A writable mount is therefore never equivalent to
permission to commit, push, comment, or update GitHub metadata.

## Extension points

Supported extension points are intentionally narrow:

- add a Controller capability through the typed catalog, policy requirements,
  provider binding, schemas, receipts, and tests;
- add GitHub transport behavior behind the existing Gateway facade without
  bypassing binding or revalidation;
- add controlled MCP/Bundle/Plugin definitions through the versioned manifests;
  or
- compose native DSH ecosystem definitions through the native admission path.

Extensions do not move credential ownership, create implicit grants, or bypass
the Controller validation and persistence boundaries.
