# Extension contracts

## Status in v0.3

v0.3 defines protocol-versioned seams for alternate agent engines, controller
tool providers, extension registration and resumable sessions. The release
wires only the built-in DSH engine, fixed-argv command provider and exact-ID
tool router. Loading a real MCP server, loading third-party plugins, persisting
sessions and resuming a prior DSH conversation are explicitly deferred. No
repository file can activate an extension in v0.3.

These contracts keep future integrations behind the same controller-owned
authorization, isolation and publication boundaries. They are not permission
shortcuts: an extension cannot expand `requestedAccess`, the effective tool set
or GitHub authority selected by the controller.

## Versioning rules

The agent protocol constant and `AgentTurnRequest.schemaVersion` are `1`.
Structured DSH output independently carries `protocolVersion: 1`, and
maintainer tool configuration carries `schemaVersion: 1`. A consumer must reject
an unsupported major protocol or schema version rather than guess how to
interpret it.

An engine has an immutable `id` and `version`. A future extension lock records
each extension's ID, version, content digest and source. Session binding also
records the engine identity and an effective-toolset digest. Changing any of
those values invalidates the old binding; silently loading a same-named but
different implementation is not allowed.

Additive optional observability fields may be introduced within protocol v1.
Changing authorization meaning, tool-call semantics, required fields, session
binding or state transitions requires a new protocol/schema version and an
explicit adapter.

## `AgentEngine`

`AgentEngine<TOutput, TMetadata>` is the provider-neutral turn boundary:

- `id` and `version` identify the implementation used in policy/session locks.
- `runTurn(request)` receives the controller-selected operation,
  `requestedAccess`, trusted operator instructions, bounded context, effective
  tool manifests, the bound `.git`-less workspace and the remaining timeout.
- The response contains structured output, measured duration, engine metadata
  and, only for a future resumable engine, an optional session handle.
- `dispose()` is optional and must release run-scoped resources. Cleanup errors
  are secondary and must not replace the primary outcome.

The controller validates the returned operation, protocol and state before any
tool call, validation, publication or write. `needs_tool`, `final` and `blocked`
are controller state-machine inputs; in particular, `blocked` cannot reach a
write finalizer.

`DshAgentEngine` is the only v0.3 implementation. Its engine version is the
audited, exact DSH package version accepted by the action. Each outer-loop turn
is a fresh headless turn over the same disposable workspace; this is not session
resume.

## `ToolProvider` and tool manifests

A `ToolProvider` exposes:

- a stable provider `id`;
- `manifest()`, returning namespaced exact tool IDs, descriptions, declared
  `read`/`write`/`execute`/`network` permissions and an input schema;
- `invoke(call, context)`, returning an `AgentToolResult`; and
- optional `dispose()` cleanup.

The controller, not the model, creates `callId`. A provider result must return
the exact same `callId` and tool ID. Calls are scoped to the bound workspace and
remaining timeout. Provider output is always untrusted data and must be runtime
validated, redacted and byte-bounded before it is returned to another turn.

The v0.3 `CommandToolProvider` is deliberately narrower than the generic
contract. It accepts only `{}` as input and executes the maintainer's exact argv
in a credential-free container; the model cannot supply argv, shell text,
environment variables or a working directory. `workspaceAccess`, `network`,
per-command call count, timeout and output limits come only from trusted
configuration and remain subject to controller policy.

Future MCP or plugin providers may use structured input only after the
controller implements runtime schema validation and provider-specific policy.
The presence of `inputSchema` in v1 is not an instruction to pass unchecked
model data to a process or remote service.

## `ToolRouter`

`ToolRouter` composes controller tool providers by exact manifest ID. It
validates namespaced provider/tool IDs, prevents a controller provider from
claiming the native `builtin` plane, rejects duplicate IDs at construction,
rejects unknown IDs at invocation, verifies that the returned call/tool IDs
match and disposes all registered providers. The controller catalog sent to an
engine is rebuilt from those actual router manifests rather than trusting a
parallel configured copy.

Native DSH workspace capabilities and controller-invoked tools have different
execution planes. Read/search/edit capabilities are enabled inside the audited
DSH profile; fixed command tools are invoked by the outer controller. Future
registries must preserve that distinction and advertise only tools that the
selected plane can actually route.

Routing does not authorize a tool by itself. Provider registration happens only
after the controller computes the intersection of configured tools, the
maintainer allowlist, requested access and policy capabilities. A router must
never resolve a name by prefix, fuzzy match or model-supplied provider alias.

## `SessionStore`

`SessionStore` reserves the persistence boundary for a future resume feature:

- `load(binding)` returns only a session with an exact binding match;
- `save(session, expectedRevision)` is compare-and-swap persistence; and
- `invalidate(binding)` revokes sessions for that binding.

An `AgentSessionBinding` binds repository ID, target, immutable head SHA, actor
and policy fingerprints, task scope, operation, requested access, engine
identity, effective-toolset digest and the full extension lock. A mismatch in
any field must start a fresh session. The session revision prevents lost updates
and `expiresAt` prevents indefinite reuse.

`resumeToken` is opaque credential material. A future store must encrypt or
otherwise protect it, redact it from logs and outputs, and never expose it to
repository code or a tool provider. Controller-generated tool call IDs and
receipts must also be persisted before stateful calls can safely survive replay;
a resumed turn must not execute the same call ID twice.

v0.3 provides the interface only. It does not save a session, accept a public
resume input or claim continuity between headless DSH turns.

## `ExtensionProvider`

`ExtensionProvider` identifies a future built-in, MCP or plugin contribution by
ID, version and source. Registration produces a candidate provider set; the
controller must verify its immutable extension lock, apply policy, reject tool
ID collisions through `ToolRouter` and own final disposal. Extensions must not
replace built-in providers, mutate an existing manifest after registration or
derive authority from repository content.

There is no active MCP/plugin discovery or loading path in v0.3. Enabling one in
a later release requires, at minimum, an installation trust policy, immutable
version/digest verification, runtime manifest and input/output validation,
credential scoping, timeout/cancellation, egress policy, audit receipts,
collision tests and session-binding integration.
