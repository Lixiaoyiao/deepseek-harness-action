# Configuration

[README](../README.md) · [Setup](setup.md) · [Usage](usage.md) · [Troubleshooting](troubleshooting.md) · [Security](../SECURITY.md)

This page is the user-facing reference for Action inputs, permissions, tools,
extensions, validation, progress reporting, and outputs. The typed
[`src/action-contract.ts`](../src/action-contract.ts) definition is the source
for public input names, required/default metadata, descriptions, runtime keys,
and the generated tables below. [`action.yml`](../action.yml) remains the
published public interface. For the complete threat model and known limits,
read [`SECURITY.md`](../SECURITY.md); for low-level extension behavior, read
[Extension contracts](extension-contracts.md).

Treat every capability-bearing input as trusted control-plane configuration.
Keep these values literal in a reviewed workflow, or derive them only from a
trusted dispatch input. Do not interpolate pull-request text, issue bodies,
comments, CI logs, repository files, or model output into `prompt`, permission,
validation, image, extension, executable, or credential-routing inputs.

## Inputs

### Credentials and API routing

<!-- BEGIN GENERATED ACTION INPUTS: credentials -->

| Input                 | Required/default                        | Description                                                                                                                                 |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `deepseek-api-key`    | Required                                | DeepSeek API key. Kept by the controller-side credential proxy; never passed to DSH or repository code.                                     |
| `github-token`        | `${{ github.token }}`                   | GitHub token used only by the trusted controller.                                                                                           |
| `base-url`            | `https://api.deepseek.com`              | Trusted credential-routing input. The controller-side proxy forwards DeepSeek requests to this URL; never derive it from untrusted content. |
| `web-search-base-url` | `https://api.deepseek.com/anthropic/v1` | Trusted credential-routing input for the Controller-mediated DeepSeek Anthropic Messages web-search endpoint.                               |
| `bot-user-id`         | `41898282`                              | Numeric ID of the bot account that owns tracking comments. Defaults to github-actions[bot].                                                 |

<!-- END GENERATED ACTION INPUTS: credentials -->

`base-url` and `web-search-base-url` are credential-routing decisions, not
ordinary model data. Review non-default endpoints as carefully as any other
secret recipient.

### Operation and publication

<!-- BEGIN GENERATED ACTION INPUTS: operation -->

| Input                | Required/default | Description                                                                                                                             |
| -------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `allow-write`        | `false`          | Allow trusted same-repository task/fix/implement writes after all trust gates pass.                                                     |
| `command`            | `auto`           | Optional explicit operation: task, review, diagnose, fix, implement, or auto.                                                           |
| `task-access`        | `read`           | Capability requested by an explicit task: read or write. Write still requires allow-write and every policy gate.                        |
| `prompt`             | Empty            | Trusted task prompt. With command=auto on dispatch/schedule events, a non-empty prompt selects generic task mode.                       |
| `task-output-schema` | Empty            | Optional bounded maintainer-owned JSON Schema for a Controller-validated taskOutput. It never replaces result-json or grants authority. |
| `max-findings`       | `20`             | Maximum high-confidence findings to publish.                                                                                            |
| `progress-comment`   | `true`           | Create or update one controller-owned sticky comment at major lifecycle stages, reusing the operation's result marker.                  |

<!-- END GENERATED ACTION INPUTS: operation -->

Writing `@dsh fix`, `@dsh implement`, or `@dsh task --write` is never enough by
itself. An actual mutation also requires trusted origin and actors, suitable
workflow token scopes, `run-tests: "true"`, a non-empty `test-commands` list,
successful Controller validation, and an effective `workspace.edit` grant. A
confirmed no-change task can publish only its answer and performs no mutation.

### Routing, filters, and branch UX

<!-- BEGIN GENERATED ACTION INPUTS: routing -->

| Input                       | Required/default | Description                                                                                                                                                 |
| --------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger-phrase`            | `@dsh`           | Maintainer-controlled literal used for first-line comment commands. Routing only; it never grants authority.                                                |
| `label-trigger`             | Empty            | Optional exact label that routes Issue tasks or pull request reviews. Empty disables this route.                                                            |
| `assignee-trigger`          | Empty            | Optional exact assignee login that routes Issue tasks or pull request reviews. Empty disables this route.                                                   |
| `allowed-actors`            | `*`              | Comma-separated maintainer routing allowlist for originating actors. \* preserves the default route; authorization remains separate.                        |
| `allowed-bots`              | Empty            | Comma-separated bot allowlist. Empty preserves the fail-closed bot write gate; listed bots still need repository write permission.                          |
| `include-comments-by-actor` | Empty            | Optional comma-separated allowlist for historical comments included as untrusted context. The audited trigger comment is retained.                          |
| `exclude-comments-by-actor` | Empty            | Optional comma-separated deny list for historical comment context. Exclusion wins over inclusion.                                                           |
| `base-branch`               | Empty            | Maintainer-selected base branch for Issue and automation tasks. Empty uses the trusted repository default branch; PR fixes stay bound to their head.        |
| `branch-prefix`             | `dsh/`           | Validated prefix for Controller-created task branches.                                                                                                      |
| `branch-name-template`      | Empty            | Optional deterministic branch template using {{prefix}}, {{key}}, {{operation}}, {{entityType}}, and {{entityNumber}}; {{prefix}} and {{key}} are required. |

<!-- END GENERATED ACTION INPUTS: routing -->

The workflow must subscribe to the matching GitHub event and keep any job-level
`if` expression aligned with a custom trigger. These inputs are trusted
maintainer configuration: never derive them from Issue, PR, comment, repository,
or model content. Rendered branch names are sanitized as Git refs, bounded to
240 UTF-8 bytes, and must retain the Controller operation key. The default
configuration preserves the existing `dsh/<issue>-implement-<key>` and
`dsh/task-<key>` names exactly.

`task-output-schema` accepts only a bounded, root-object JSON Schema subset:
typed object properties, required fields, arrays, scalar constraints, `enum`,
`const`, and supported formats. References, combinators, conditionals, regex
patterns, unknown keywords, dangerous keys, and excessive size or complexity
fail closed. A configured final task must return a valid object; intermediate
tool requests and blocked tasks omit it. The value remains untrusted task data.

### Runtime, isolation, and limits

<!-- BEGIN GENERATED ACTION INPUTS: runtime -->

| Input             | Required/default                                                                                                  | Description                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-mode`        | `controlled`                                                                                                      | DSH composition ownership: controlled preserves the Controller-owned ToolRuntime policy; experimental native uses the official DSH headless Profile, MCP, Bundle, Plugin, Skill, Subagent, and Workflow graph inside the Action's Docker safety boundary. |
| `dsh-version`     | `0.1.1-rc.2`                                                                                                      | Pinned @deepseek-ai/dsh version. The Action accepts only the audited 0.1.1-rc.2 runtime.                                                                                                                                                                  |
| `dsh-executable`  | Empty                                                                                                             | Trusted capability input. Optional absolute path to a preinstalled DSH executable; host mode executes it without a container boundary.                                                                                                                    |
| `isolation`       | `docker`                                                                                                          | Trusted capability input selecting the DSH isolation backend. 'none' removes the OS/container boundary; Docker is required for untrusted review data, writes, and extensions.                                                                             |
| `container-image` | `docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059` | Trusted worker-code input. Every value must be one Docker/OCI image reference and cannot be parsed as a Docker option; extensions and writes require a full name@sha256 digest.                                                                           |
| `timeout-minutes` | `20`                                                                                                              | Overall setup/execution deadline shared by runtime and extension install, DSH turns, command tools, and validation. Fixed short cleanup/finalization grace may run after it.                                                                              |
| `max-turns`       | `3`                                                                                                               | Maximum fresh DSH turns across tool requests and validation repair attempts.                                                                                                                                                                              |

<!-- END GENERATED ACTION INPUTS: runtime -->

Set the job-level `timeout-minutes` a few minutes above the Action input. This
lets the Action stop its worker, publish terminal outputs, attempt an eligible
sticky-comment update, and clean up before GitHub terminates the whole job.
Runtime installation, extension installation, each Agent turn, and validation
have independent caps, each further limited by the remaining overall deadline.

### Composition modes

`controlled` remains the default and preserves the existing Action-managed
`github-action` Profile, positive ToolRuntime policy, canonical tool
intersection, extension construction, and audit behavior. Omitting `dsh-mode`
is therefore equivalent to explicitly selecting `controlled`; existing users
do not opt into a new tool surface accidentally.

`native` is an experimental `NativeComposition` over the locked official DSH
`0.1.1-rc.2` headless composition. DSH owns its internal capability graph and
model-facing inventory. Native is not implemented by deleting a few deny rows
from `ControlledComposition`, and the Action does not present its controlled
ToolRuntime allowlist as authority over DSH's complete native inventory.

Native does **not** mean unsafe or unbounded. It is Docker-only and still uses
the same Action-owned outer boundaries:

- the real DeepSeek key stays in the Controller-side run-scoped proxy and only
  an ephemeral worker credential enters Docker;
- the real `GITHUB_TOKEN` and `GH_TOKEN` never enter the worker;
- actor, repository, event, fork, and immutable-SHA trust decisions are
  unchanged;
- `command.*` and `github.*` remain Controller-owned, with the same typed GitHub
  Gateway, validation/revalidation, deferred mutation, and write gates; and
- overall deadlines, phase timeouts, cancellation, cleanup, bounded outputs,
  and secret redaction remain Action-owned.

Native rejects `isolation: none`, but accepts a separate definition-only native
extension schema. MCP servers load through official
`@deepseek-ai/dsh-mcp-client`; configured Bundles become official Profile
layers; and direct Plugins load through Cordis. The locked base/headless graph
continues to own repository Skills, Subagents, Workflows, discovery,
registration, invocation, and final model-visible inventory. The Action does
not turn those capabilities into controlled providers, manifests, grants, or
per-tool budgets.

Native extension definitions still pass Action-owned outer admission. They
must come from trusted workflow configuration; package sources remain exact
pins; package acquisition disables lifecycle scripts and preserves the runtime
package inventory audit; and real Controller credentials remain forbidden.
Owner-level `network` and `workspaceWrite` fields request process authority. If
one owner requests bridge networking, every capability in the native worker
shares bridge egress. A read/write mount likewise belongs to the complete
worker and follows Action trust/write policy; neither setting is a per-tool
sandbox. Maintainer-defined `command.*` tools and the closed Controller
`github.*` catalog remain a separate execution plane in both compositions.

### Validation

<!-- BEGIN GENERATED ACTION INPUTS: validation -->

| Input                  | Required/default | Description                                                                                                                                                                |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-tests`            | `true`           | Must be true for every code, Git ref, and pull-request mutation. false denies the mutation and is not a validation waiver.                                                 |
| `test-commands`        | `[]`             | Non-empty JSON array of credential-free argv arrays required for every write, e.g. [["npm","test"]]. Every command must pass; Controller credentials in argv are rejected. |
| `validation-integrity` | `warn`           | Controller-owned validation-definition policy: off records, warn reports, strict blocks high-confidence weakening and replays baseline controls when needed.               |

<!-- END GENERATED ACTION INPUTS: validation -->

Validation runs in a disposable, credential-free Docker container after all
trusted-write gates pass. Do not place `GITHUB_TOKEN`, the DeepSeek key, or
another Controller credential in validation argv. Replace example npm commands
with deterministic validation commands for your repository.

### Agent tools and extensions

<!-- BEGIN GENERATED ACTION INPUTS: tools -->

| Input                  | Required/default                                | Description                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permission-profile`   | `strict`                                        | Agent tool preset: strict preserves v0.4 behavior, standard grants trusted coding conveniences, and custom uses the exact allow/deny lists.                                                                                                                                            |
| `allowed-tools`        | `[]`                                            | JSON allowlist of Action/controlled capabilities. controlled accepts workspace.\*, native.\*, command.\*, typed github.\*, mcp.\*, and plugin.\* IDs; native rejects mcp./plugin. grants because DSH owns that inventory.                                                              |
| `disallowed-tools`     | `[]`                                            | JSON deny list using the same exact tool IDs as allowed-tools. Deny always wins after preset expansion.                                                                                                                                                                                |
| `tool-config`          | `{"schemaVersion":1,"commands":[]}`             | Versioned JSON manifest of maintainer-owned fixed-argv command tools. Model-provided argv and controller credentials in argv are rejected; common direct shell executables are also denied.                                                                                            |
| `mcp-config`           | `{"schemaVersion":1,"servers":[]}`              | Versioned maintainer-owned official DSH MCP config. controlled declares exact tools/budgets; native declares the server, owner-level workspaceWrite/network, toolCallTimeoutMs, and explicit credentialEnv/credentialHeaders because DSH discovers tools.                              |
| `plugin-config`        | `{"schemaVersion":1,"bundles":[],"plugins":[]}` | Versioned maintainer-owned DSH Bundle/Plugin config. Native entries are definition-only, with direct-Plugin credentialConfig, and load through official Profile/Cordis composition. Startup executes trusted worker code; every package requires an exact semver or GitHub commit pin. |
| `allow-plugin-install` | `false`                                         | Allow startup of explicitly configured and pinned third-party DSH Bundles/Plugins. Disabled by default because installation and startup execute trusted code.                                                                                                                          |

<!-- END GENERATED ACTION INPUTS: tools -->

All three manifests require `schemaVersion: 1`; unknown fields and unsupported
versions fail closed. In controlled mode, MCP, Bundle, and Plugin configuration
uses the advanced `custom` profile path. `strict` remains accepted for v0.4
compatibility, but `standard` with controlled extension configuration is
rejected. Native uses its separate definition-only schema and does not accept
`mcp.*` or `plugin.*` entries in `allowed-tools` / `disallowed-tools`, because
those would misrepresent DSH-discovered inventory as Controller grants.

## Permission model

Three independent layers must agree:

1. **Workflow token scopes** decide which GitHub APIs the Controller may call.
2. **Execution trust** (`untrusted`, `trusted-read`, or `trusted-write`) comes
   from the event, actor, origin, and bound repository identity.
3. **Agent permissions** come from the selected preset, exact allow/deny lists,
   declared tool requirements, and Controller policy.

A broader setting in one layer cannot override a denial in another. The Agent
never receives the real GitHub token or DeepSeek key, and only the Controller
can comment, commit, push, update a ref, or open a pull request.

### Workflow token scopes

Use the smallest GitHub `permissions` block that supports the workflow:

| Scenario                                    | Typical scopes                                                                                           |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Automatic or fork PR review                 | `contents: read`, `pull-requests: write`                                                                 |
| Read-only task without Issue/PR publication | `contents: read`                                                                                         |
| Task that creates a branch and PR           | `contents: write`, `pull-requests: write`                                                                |
| CI diagnosis                                | `actions: read`, `checks: read`, `contents: read`, `issues: write`, `pull-requests: write`               |
| Commands with fix/implement, or CI auto-fix | `actions: read`, `checks: read`, `contents: write`, `issues: write`, `pull-requests: write`              |
| Selected typed GitHub tools                 | Add only the matching `issues: write`, `pull-requests: write`, `checks: read`, or `statuses: read` scope |

These scopes let the Controller call GitHub; they do not bypass actor, fork,
event, SHA, protected-path, extension, or validation checks. See [Setup](setup.md)
for complete workflow templates.

### Permission profiles

| Profile    | Preset request                                                          | Intended use                                                                                   |
| ---------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `strict`   | `workspace.read`, `workspace.search`, `workspace.edit`                  | Default, review, and v0.4-compatible behavior. Edit remains ineffective outside trusted write. |
| `standard` | `strict` plus `native.bash`, `native.web-search`, and `native.subagent` | Trusted maintainer coding tasks. Bash and subagent still require trusted-write Docker policy.  |
| `custom`   | No preset                                                               | Exact tools, command tools, MCP, Bundle, or Plugin configuration. List every tool explicitly.  |

In controlled mode, `allowed-tools` adds exact requests after preset expansion;
it does not replace a `strict` or `standard` preset. Use `custom` for a minimal
exact set. Exact `disallowed-tools` entries always win. The final set is
intersected with trust, event, actor, workspace, network, extension, and
Controller policy. Unknown, unavailable, omitted, or policy-ineligible IDs fail
closed.

`permission-profile` is not another spelling of `dsh-mode`. Native mode does
not reinterpret `strict`, `standard`, or `custom` as DSH composition choices and
does not use the controlled native-tool allowlist to claim authority over DSH's
complete capability graph. The existing profile and exact canonical IDs still
resolve the Action-owned Controller tool plane and its audit; observation of a
DSH-native tool is not a grant from that profile.

In particular, native `mcp-config` / `plugin-config` entries must not be paired
with `mcp.*` or `plugin.*` allow/deny IDs. Native definitions do not list tools,
so such an ID would be a fabricated Controller inventory and is rejected.
Use `observedTools` after the real DSH graph starts to inspect dynamic native
MCP, Bundle, and Plugin names.

Canonical Action tool IDs are:

- `workspace.read`, `workspace.search`, and `workspace.edit`;
- `native.bash`, `native.web-search`, and `native.subagent`;
- `command.<name>` for Controller fixed-argv tools;
- `github.issue.labels.set`, `github.issue.assignees.set`,
  `github.issue.state.update`, `github.comment.create`,
  `github.pull.metadata.update`, and `github.checks.read`;
- `mcp.<server-id>.<tool-id>` for MCP tools; and
- `plugin.<extension-id>.<tool-id>` for Bundle or direct plugin tools.

For Controller-managed builtin tools, one declarative capability contract binds
each identity to its model permission tags and trust, capability, and isolation
requirements. A generic evaluator intersects those requirements with the
request, exact explicit denies, `SecurityPolicy`, configured providers, and
effective isolation. Native DSH's dynamic inventory is not copied into that
Controller contract.

The controlled DSH runtime may use a different model-facing name; controlled
authorization always uses the canonical Action ID. Native audit instead reports
the actual model-facing names observed from that DSH runtime, such as `read` or
`grep`, without translating them into controlled `workspace.*` grants.

The tool-policy audit uses four deliberately distinct terms:

- `requestedTools` are the canonical capabilities requested by preset expansion
  and `allowed-tools`, including requests later denied.
- `effectiveTools` exist only when `policyOwner` is `controller`. They are the
  exact canonical set the Controller finally granted and exposed to the model
  after every deny, trust, provider, and extension intersection.
- `deniedTools` are requested capabilities that were not granted, paired with
  the Controller's reason. `disallowedTools` remains the narrower raw explicit
  deny input and is not a synonym.
- `observedTools` reports the names actually visible to the root Agent in a
  `policyOwner: dsh` native runtime. Observation is telemetry, not a Controller
  grant, so it is never labeled effective.

`ControlledComposition` reports `policyOwner: controller` with its unchanged
`requestedTools`, `effectiveTools`, and `deniedTools`. Experimental
`NativeComposition` reports `policyOwner: dsh` and `observedTools`; its
`toolPolicy` has no Controller `effectiveTools` field. An observed tool may
still be constrained by the read-only workspace mount, Docker network, missing
credentials, Controller validation, or another outer boundary. Neither audit
shape is an authorization input.

### Known authority sources

The additive top-level `result-json.authority` audit is parallel to
`permissions` and `toolPolicy`. Its `scope` is `action-known-sources`, and its
deterministically ordered `knownSources` distinguish:

- the Controller-owned GitHub credential, whose real token is not exposed to
  the worker;
- the Controller-owned DeepSeek credential, whose real key is not exposed to
  the worker and is mediated through a run-scoped proxy; and
- one generic `extension-credential` record for each controlled-effective or
  native-admitted MCP server or direct plugin configured with credential-like
  explicit workflow data.

Extension entries identify only the admitted owner kind and ID. They never
contain or classify a secret value, hash, header, argv/env value, URL
path/query, or secret count. Controlled owners with no effective tool are not
reported; native has no predicted tool grant, so an admitted definition is the
plan fact. The entry does not prove extension startup or credential use. The
audit is intentionally incomplete: it records only sources the Action knows,
configures, or mediates and does not prove that trusted worker or extension
code lacks network, runner ambient state, or other authority. It is
observability, not authorization.

A user-configured GitHub MCP and its own credential are an external extension
authority. Calls made directly by that extension do not pass through the
Controller `GitHubAuthorityGateway` and do not receive its repository/entity/head
binding, revalidation, Controller validation, deferred mutation, or receipts.
The Action does not provide a GitHub MCP backend.

### Controlled native tool IDs

These canonical IDs apply to `dsh-mode: controlled`:

- `workspace.read` and `workspace.search` operate on the run-scoped `.git`-less
  workspace when repository access is allowed.
- `workspace.edit` requires effective trusted-write authority and is followed by
  actual-change inspection and Controller validation.
- `native.bash` is opt-in through `standard` or `custom`, requires trusted-write
  Docker, runs bounded foreground commands without credentials, and cannot
  share a worker with a bridge-networked extension.
- `native.web-search` is mediated by the Controller through
  `web-search-base-url`. It does not expose the real key, provide arbitrary URL
  fetch, or imply general Docker bridge egress.
- `native.subagent` is available only under eligible trusted-write policy. Its
  ordinary response returns to the root Agent; it does not bypass the Action's
  root structured-output contract.

Native mode does not translate DSH's internal names into this controlled ID
set. Inspect `result-json.toolPolicy.observedTools` for the actual root-Agent
inventory and treat it only as telemetry.

## Controller-owned GitHub tools

The first GitHub tool set is deliberately typed and closed:

| Tool ID                       | Bound operation                                                                |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `github.issue.labels.set`     | Replace labels on the current Issue or PR.                                     |
| `github.issue.assignees.set`  | Replace assignees on the current Issue or PR.                                  |
| `github.issue.state.update`   | Open or close the current Issue with a bounded state reason.                   |
| `github.comment.create`       | Create one Controller-marked, mention-safe comment on the current Issue or PR. |
| `github.pull.metadata.update` | Update bounded title/body/state metadata on the current, revalidated PR.       |
| `github.checks.read`          | Read bounded checks and commit statuses for the immutable bound head SHA.      |

No tool accepts an owner, repository, entity number, head SHA, raw URL,
credential, REST route, GraphQL document, or arbitrary request body. The
Controller derives identity from the trusted event snapshot. Read access
requires the matching `readCi` policy. Every mutation requires an explicitly
selected exact ID, `trusted-write`, `allow-write: "true"`, compatible entity
and capability, Docker, and successful Controller-owned validation.

Mutation requests are scheduled during an Agent turn and applied only during
Controller finalization. Malformed/blocked output or failed validation discards
the queue. Immediately before mutation the Controller revalidates entity and
repository identity, then performs bounded API attempts, postcondition checks,
ambiguous-failure reconciliation, and bounded receipts. Model output never
becomes GitHub authority.

If one queued mutation is confirmed or may have taken effect before a later
mutation fails, the failure envelope reports `write.status: partial-success`
and receipts mark the bounded external-effect state. Treat that as a manual
reconciliation signal; do not blindly rerun the model request.

## Maintainer-defined command tools

A `command.*` tool is a complete argv chosen by the workflow maintainer. The
model may select the advertised tool but cannot add arguments.

```yaml
with:
  permission-profile: custom
  allowed-tools: '["workspace.read","workspace.search","command.bundle-syntax"]'
  tool-config: |
    {
      "schemaVersion": 1,
      "commands": [{
        "name": "bundle-syntax",
        "description": "Check the bundled JavaScript syntax",
        "argv": ["node", "--check", "dist/index.js"],
        "timeoutMinutes": 10,
        "maxOutputBytes": 131072,
        "maxCalls": 2,
        "network": "none",
        "workspaceAccess": "read"
      }]
    }
```

The defaults per command are a 10-minute timeout, 128 KiB output, three calls,
no network, and read-only workspace access. Direct shell interpreters are
rejected. A `write` mount or `bridge` network must be explicit and must survive
the same Controller capability intersection. stdout and stderr are bounded,
redacted, and returned to the model only as untrusted data.

## MCP

### Controlled MCP

In controlled mode, `mcp-config` is a strict server-and-tool allowlist for the official DSH MCP
client. Defining a server does not grant any tool. Each selected tool must also
appear in `allowed-tools` as `mcp.<server-id>.<tool-id>` and survive Controller
policy.

```yaml
with:
  permission-profile: custom
  isolation: docker
  allowed-tools: '["workspace.read","workspace.search","mcp.repo-index.lookup"]'
  mcp-config: |
    {
      "schemaVersion": 1,
      "servers": [{
        "id": "repo-index",
        "transport": "stdio",
        "command": "/opt/dsh-extensions/bin/repository-index-mcp",
        "args": ["--stdio"],
        "cwd": ".",
        "network": false,
        "maxCalls": 8,
        "tools": [{
          "id": "lookup",
          "name": "lookup",
          "description": "Search the prebuilt repository index",
          "permissions": ["read"],
          "timeoutMs": 15000,
          "maxOutputBytes": 65536,
          "maxCalls": 4
        }]
      }]
    }
```

Supported transports:

- `stdio`: use a bare executable name or an absolute container path outside
  `/workspace`. Shells, interpreters, downloaders, package managers, Git,
  relative paths, and dynamic runners such as `npx` are rejected. Optional
  `cwd` is repository-relative. Put the audited executable in the digest-pinned
  image; starting it is full trusted worker-code execution.
- `streamable-http`: use an HTTP(S) URL without embedded credentials or a
  fragment. Put credentials in explicit headers. The server and every tool must
  declare network permission.

Each tool declares `permissions`, `timeoutMs`, `maxOutputBytes`, and `maxCalls`;
the server has its own `maxCalls` and reconnect policy. Every extension tool
must declare `read` because the process shares the repository view. Network and
workspace mounts belong to the whole DSH process, so tools owned by one server
must agree on workspace-write mode and the server's network setting. MCP results
remain untrusted data.

See [`examples/controlled-extensions.yml`](../examples/controlled-extensions.yml)
for both configuration families and [Extension contracts](extension-contracts.md)
for identifier normalization, inventory checks, limits, and receipt behavior.

### Native MCP

Native uses the same official rc.2 MCP client but a deliberately different
schema. The workflow defines a server owner and connection; DSH discovers,
registers, and exposes its tools at runtime.

```yaml
with:
  dsh-mode: native
  isolation: docker
  mcp-config: |
    {
      "schemaVersion": 1,
      "servers": [{
        "id": "repo-index",
        "transport": "stdio",
        "command": "/opt/dsh-extensions/bin/repository-index-mcp",
        "args": ["--stdio"],
        "cwd": ".",
        "env": {},
        "credentialEnv": {"SERVICE_VALUE": "${{ secrets.REPO_INDEX_KEY }}"},
        "network": false,
        "workspaceWrite": false,
        "toolCallTimeoutMs": 15000
      }]
    }
```

The native server fields are `id`, `transport`, the transport connection
fields, owner-level `network` and `workspaceWrite`, server-level
`toolCallTimeoutMs`, reconnect settings, and the explicit `credentialEnv` or
`credentialHeaders` map when that owner needs a credential. There is no `tools` array,
`permissions`, canonical `mcp.*` grant, `maxCalls`, `maxOutputBytes`, or
per-tool timeout. `toolCallTimeoutMs` is an official-client server execution
limit, not an Action grant or prediction of inventory. Adding a native
`mcp.*` ID to `allowed-tools` or `disallowed-tools` fails closed.

Native stdio commands retain the same executable/path restrictions documented
above. A Streamable HTTP definition uses an HTTP(S) `url`, ordinary `headers`,
and an explicit `credentialHeaders` map for credential values,
and always has `network: true`. If any native MCP, Bundle, or Plugin requests
network, Docker bridge egress belongs to the entire native worker, not only to
that server. Likewise, `workspaceWrite: true` requests outer trusted-write
admission but cannot create it; any actual writable mount is shared by the
whole worker.

An MCP server may receive its own explicit credential through `credentialEnv`
or `credentialHeaders`. Those values are merged into the official client's
`env` or `headers`, registered for masking regardless of key name, and emit only
a value-free known-authority record—never a value or hash. Credential-like
legacy values in ordinary fields retain the compatible detector, but new native
definitions should use the explicit channel. The
real DeepSeek key and Action GitHub token remain forbidden. If this is a GitHub
MCP using a user-supplied credential, its direct effects are external extension
authority and are outside the Controller GitHub Gateway's binding,
revalidation, validation, deferred-mutation, and receipt guarantees.

Native MCP names discovered by DSH, including dynamically registered tools,
appear in `result-json.toolPolicy.observedTools`. That inventory is telemetry;
native never produces a Controller `effectiveTools` inventory for it.

## Bundle, Plugin, and Profile loading

### Controlled Bundle and Plugin loading

In controlled mode, `plugin-config` declares DSH Bundles and direct Cordis plugins. There is no
separate user-provided Profile input: after validating trusted workflow inputs,
the Controller generates the run-scoped `github-action` Profile and Cordis patch
and loads only effective entries through the official DSH app-boot API.

```yaml
with:
  permission-profile: custom
  isolation: docker
  allow-plugin-install: "true"
  allowed-tools: '["workspace.read","plugin.repo-audit.scan"]'
  plugin-config: |
    {
      "schemaVersion": 1,
      "bundles": [{
        "id": "repo-audit",
        "package": "@example/dsh-repository-audit-bundle",
        "source": "1.2.3",
        "network": false,
        "tools": [{
          "id": "scan",
          "name": "plugin__repo-audit__scan",
          "description": "Run the audited repository scan",
          "permissions": ["read"],
          "timeoutMs": 30000,
          "maxOutputBytes": 131072,
          "maxCalls": 2
        }]
      }],
      "plugins": []
    }
```

Each package must use an exact semver or
`git+https://github.com/<owner>/<repo>.git#<40-character-commit>`. `latest`,
ranges, floating refs, and replacement of Controller-owned DSH packages are
rejected. Direct plugin entries use the same fields and may additionally carry
a `config` object. Package runtime names must begin with
`plugin__<extension-id>__`; authorization uses
`plugin.<extension-id>.<tool-id>`.

`allow-plugin-install: "true"` is an independent gate; the package tool must
still be selected and policy-eligible. Acquisition disables npm lifecycle
scripts, then verifies the installed identity, immutable source, Bundle patch
path, and the complete pre-existing top-level runtime package inventory.
Package acquisition uses Docker bridge networking even if later runtime
configuration says `network: false`.

> A permitted stdio MCP server, Bundle, or plugin is trusted executable worker
> code. ToolRuntime controls model-routed tool calls; it does **not** sandbox
> package initialization, startup hooks, background work, or direct process I/O.
> Review the complete package and transitive dependency graph, pin it
> immutably, and use runner-level filesystem/network isolation appropriate for
> trusted code.

### Native Bundle, Plugin, Skill, Subagent, and Workflow loading

Native `plugin-config` is definition-only. A Bundle is appended to the locked
official Profile's Bundle layers; a direct Plugin is resolved from its
installed exact package and inserted as a Cordis row. Neither is translated
into an Action provider or controlled tool manifest.

```yaml
with:
  dsh-mode: native
  isolation: docker
  allow-plugin-install: "true"
  plugin-config: |
    {
      "schemaVersion": 1,
      "bundles": [{
        "id": "repo-audit",
        "package": "@example/dsh-repository-audit-bundle",
        "source": "1.2.3",
        "network": false,
        "workspaceWrite": false
      }],
      "plugins": [{
        "id": "lint",
        "package": "@example/dsh-lint-plugin",
        "source": "2.3.4",
        "network": false,
        "workspaceWrite": false,
        "config": {"mode": "safe-json"},
        "credentialConfig": {"connection": "${{ secrets.LINT_SERVICE_KEY }}"}
      }]
    }
```

Native package entries contain no tool names, permission arrays, timeouts,
output/call budgets, or `plugin.*` grants. DSH and Cordis decide what registers
and becomes model-visible; the resulting names can only be audited through
runtime `observedTools`. Package sources still require an exact semver or a
GitHub `git+https` URL pinned to a lowercase 40-character commit, and
`allow-plugin-install: "true"` remains an independent trusted-workflow gate.
Acquisition uses `--ignore-scripts`; after installation the Action verifies the
package identity/pin, lock provenance, and preservation of every pre-existing
top-level runtime package before starting DSH.

For a direct Plugin, `credentialConfig` is merged into its Cordis `config`
object after validation; its top-level keys cannot overlap ordinary `config`.
Every explicit value is masked and represented only by the Plugin owner's
value-free authority record. Use `credentialConfig` even when the Plugin's key
is named something generic such as `connection`.

The locked official base/headless graph also keeps native Skill, Subagent, and
Workflow semantics. In particular, project Skills under `.dsh/skills` and
`.agents/skills` are discovered from the run-scoped `.git`-less Action
workspace. They are not copied into an Action extension registry or wrapped as
controlled providers. Subagent and Workflow capabilities likewise remain DSH
graph capabilities and appear in `observedTools` when visible to the root
Agent.

`network` and `workspaceWrite` are owner-level admission declarations, not
per-tool isolation. One native owner requesting network puts the complete
native worker on Docker bridge networking. A writable mount is also shared by
the entire worker and remains subject to the Action's trusted-write gates.
Bundle patches and Plugin startup are trusted code even with lifecycle scripts
disabled, so review the complete transitive graph and enforce runner-level
filesystem and network controls.

## Docker, workspace, and network

- Workers use a disposable, run-scoped `.git`-less workspace. DSH home, npm
  cache, counters, receipts, and tool state are also run-scoped.
- The worker receives neither checkout credentials nor Controller credentials.
  Keep `persist-credentials: false` on checkout.
- `network: false` for extensions blocks ordinary external egress through an
  internal Docker network, but the worker still reaches the Controller LLM proxy
  through an inspected `host.docker.internal` gateway. This is not a port
  allowlist; runner firewall policy protects other host services.
- A network-enabled extension gives the co-hosted DSH process Docker bridge
  egress. It is not a destination allowlist. In native mode, one requesting
  owner gives that path to every capability in the native worker.
- Network namespaces and mounts apply to the complete DSH process, not one tool.
  Controlled owners must agree on network and workspace-write mode. Native
  owner declarations are outer admission requests; the actual bridge and
  read/write mount remain whole-worker capabilities selected by Action policy.
- The validation container currently uses bridge networking for validation
  commands, including dependency installation. On a self-hosted or
  corporate-network runner, repository validation code may reach services
  available through that Docker bridge path. Apply dedicated runner
  segmentation and egress controls when source confidentiality, reproducibility,
  or internal-network isolation requires them.

The selected `container-image` itself is trusted worker code. An immutable digest
proves identity, not safety; review and maintain the image separately.

### GitHub image attachments

v0.8.1 does not download or forward GitHub image attachments. The exact audited
`@deepseek-ai/dsh-headless@0.1.1-rc.2` entrypoint accepts one text `task` and
constructs one text content block; it exposes no formal multimodal input
contract. Markdown image references therefore remain inert as `[image removed]`.
Reference definitions, HTML image/source elements, and recognized raw GitHub
attachment URLs are removed from every prompt channel as well. Enabling
attachments is deferred until an exact DSH release provides a formal, auditable
contract; the Action does not pass image URLs, bytes, local paths, or Controller
credentials through an unofficial channel.

## Write validation and integrity

Every repository mutation requires all configured `test-commands` to pass in
order. Commands are argv arrays, not shell strings, and execute without the
GitHub token or DeepSeek key. Model-reported verification and ToolRuntime
receipts never replace Controller validation.

`validation-integrity` provides high-confidence validation weakening detection
plus baseline replay. It analyzes supported validation entrypoints, package
scripts, test/config weakening, lock/toolchain controls, and known
wrappers/interpreters to determine whether the proposed change redefines what
“validation passed” means:

- `off` records classified validation-definition changes without blocking;
- `warn` records changed categories and suspicious weakening signals; and
- `strict` blocks high-confidence weakening and truncated audits. For other
  control-plane changes it reruns configured validation against candidate code
  with the bound baseline validation definitions restored.

Changing tests with an implementation is allowed. The Agent cannot lower this
mode, approve an integrity finding, or replace the audit with its own claim.
Validation and integrity must both pass before the Controller performs any
GitHub mutation.

This mechanism is not complete cross-language dependency provenance and is not
a formal integrity proof. Repository-specific controls remain necessary for
unsupported ecosystems, custom dependency resolution, generated inputs, and
unknown wrappers.

## Progress comments

For an authorized read-only operation attached to a pull request or issue, the
Controller can reuse one bot-owned sticky marker while work progresses and when
it publishes the result:

| Operation           | Marker      |
| ------------------- | ----------- |
| `task`              | `task`      |
| `review`            | `summary`   |
| `diagnose`          | `diagnosis` |
| `fix` / `implement` | `write`     |

Write requests publish no lifecycle/status comment until final validation
succeeds, or until actual-change inspection confirms a no-change task. A
no-change write can publish its final answer but creates no commit, ref, pull
request, or release mutation. `progress-comment: "false"` disables intermediate
lifecycle updates only.

Comment updates are best effort. `SIGTERM` and `SIGINT` trigger a bounded
cancellation update, but `SIGKILL`, runner/host loss, process crashes, and
GitHub API outages can prevent finalization and leave “In progress” stale. The
Actions run conclusion is authoritative. Preserve per-target workflow
`concurrency` to prevent older runs from overwriting newer sticky state.

## Outputs

The Action writes outputs on success, neutral completion, and failure paths.

| Output                     | Meaning                                                                                                                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conclusion`               | `success`, `neutral`, or `failure`.                                                                                                                                          |
| `operation`                | Resolved `task`, `review`, `diagnose`, `fix`, `implement`, or `none`.                                                                                                        |
| `summary`                  | Validated final summary for any operation, or a safe failure summary.                                                                                                        |
| `review-summary`           | Backward-compatible alias of `summary`.                                                                                                                                      |
| `findings-count`           | Selected review findings, or validated Agent findings for another operation.                                                                                                 |
| `branch-name`              | Created or updated Controller task branch; empty when not applicable.                                                                                                        |
| `pull-request-url`         | Created pull request URL; empty when not applicable.                                                                                                                         |
| `commit-sha`               | Commit created by a successful fix; empty when not applicable.                                                                                                               |
| `trust`                    | Resolved `untrusted`, `trusted-read`, `trusted-write`, or `none` execution trust.                                                                                            |
| `dsh-mode`                 | Resolved `controlled`, `native`, or `none` composition mode.                                                                                                                 |
| `dsh-composition`          | Stable composition identity: `github-action-controlled`, `dsh-native-headless`, or `none`.                                                                                   |
| `permission-profile`       | Resolved `strict`, `standard`, `custom`, or `none` Agent profile.                                                                                                            |
| `effective-tools`          | Backward-compatible JSON array from Action permission resolution. In native mode it is not the DSH inventory; use `result-json.toolPolicy.observedTools` for that telemetry. |
| `network-access`           | Effective `host-gateway`, `mediated-web`, `bridge`, or unresolved `none` worker path. A native `bridge` path belongs to the whole worker.                                    |
| `workspace-write`          | Whether Action policy enables a writable disposable workspace. In native mode the mount is a whole-worker boundary, not a per-tool grant.                                    |
| `trusted-extensions`       | JSON array of Action-admitted MCP, Bundle, and Plugin owners. Native network/write values describe shared worker authority, not per-tool grants.                             |
| `duration-ms`              | Total Controller duration in milliseconds.                                                                                                                                   |
| `comment-id`               | Sticky progress/result comment ID when tracking was available.                                                                                                               |
| `error-code`               | Stable failure code; empty on success or neutral completion.                                                                                                                 |
| `error-message`            | Redacted and bounded failure message.                                                                                                                                        |
| `extension-profile-digest` | SHA-256 digest of the redacted controlled extension Profile or native admission audit; empty when unavailable.                                                               |
| `tool-receipts`            | JSON object with bounded Controller/DSH receipt arrays and truncation metadata. Receipts are telemetry, never authorization.                                                 |
| `task-output`              | JSON-encoded Controller-validated value for a configured task schema; otherwise empty.                                                                                       |
| `result-json`              | Versioned structured envelope described below.                                                                                                                               |

The older scalar outputs remain available. A missing branch, commit, PR, or
comment value is often expected for read-only, denied, failed, entity-free, or
no-change outcomes. The step summary records the same resolved DSH mode and
composition as `dsh-mode`, `dsh-composition`, and `result-json.dsh`.

### `result-json`

`result-json` is a `schemaVersion: 1` envelope containing the applicable status,
operation, summary, selected DSH mode and composition at `.dsh.mode` and
`.dsh.composition`, policy and permission
audit, composition-aware extension admission audit, bounded receipts,
loop timing/counts, actual isolation report, publication, Controller validation,
validation integrity, write result, comment ID, and error. The additive
top-level `authority` audit records the Action-known
Controller and effective worker-extension credential sources described above,
without credential material or a completeness guarantee. When permissions
resolve, the additive top-level `toolPolicy` audit is discriminated by owner.
Controlled mode has `policyOwner: controller` with its current
`requestedTools`, `effectiveTools`, and `deniedTools`, and no `observedTools`.
Native mode has `policyOwner: dsh`, the runtime-derived `observedTools`
telemetry, and no Controller `effectiveTools` claim. The existing `permissions`
object and scalar `permission-profile` and `effective-tools` outputs retain
their backward-compatible Action-policy shape; they must not be read as the
native DSH inventory. Native extension audit entries record admitted owners and
their whole-worker network/write requests; they do not predict tool inventory
or grant a capability. A validated task may add an optional `taskOutput` field without
changing the fixed envelope or schema version. `status` is one of `success`, `neutral`, `failed`, `timed_out`,
`validation_failed`, or `denied`. Known errors expose stable `error.code`,
`error.category`, and `error.retryable` identity. `error.phase` separately
records the Controller lifecycle location where the error surfaced; it does not
reclassify a known error.

Failed steps set outputs before failing. Read them from a later `always()` step
without interpolating model-derived text into a shell command:

```yaml
- uses: Lixiaoyiao/deepseek-harness-action@v0.8.1
  id: dsh
  with:
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}

- name: Inspect DSH result
  if: ${{ always() && steps.dsh.outputs['result-json'] != '' }}
  env:
    DSH_RESULT_JSON: ${{ steps.dsh.outputs['result-json'] }}
  run: printf '%s\n' "$DSH_RESULT_JSON" | jq .
```

Model-derived summaries, paths, receipts, and extension telemetry remain
untrusted data. Do not splice them into commands or treat `result-json`, a
receipt, or the public extension digest as a tamper-proof security log or an
authorization decision.

## See also

- [Setup](setup.md)
- [Usage](usage.md)
- [Troubleshooting](troubleshooting.md)
- [Extension contracts](extension-contracts.md)
- [Security policy](../SECURITY.md)
