# Configuration

[README](../README.md) · [Setup](setup.md) · [Usage](usage.md) · [Troubleshooting](troubleshooting.md) · [Security](../SECURITY.md)

This page is the user-facing reference for Action inputs, permissions, tools,
extensions, validation, progress reporting, and outputs. [`action.yml`](../action.yml)
is the authoritative public interface. For the complete threat model and known
limits, read [`SECURITY.md`](../SECURITY.md); for low-level extension behavior,
read [Extension contracts](extension-contracts.md).

Treat every capability-bearing input as trusted control-plane configuration.
Keep these values literal in a reviewed workflow, or derive them only from a
trusted dispatch input. Do not interpolate pull-request text, issue bodies,
comments, CI logs, repository files, or model output into `prompt`, permission,
validation, image, extension, executable, or credential-routing inputs.

## Inputs

### Credentials and API routing

| Input                 | Required/default                        | Purpose                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deepseek-api-key`    | Required                                | DeepSeek API key held by the Controller-side credential proxy. It is not passed to DSH, repository code, tools, extensions, or validation.                                                                                                                                                 |
| `github-token`        | `${{ github.token }}`                   | Token used only by the trusted Controller for authorized GitHub reads and mutations. Workflow `permissions` remain a separate gate.                                                                                                                                                        |
| `base-url`            | `https://api.deepseek.com`              | Trusted upstream for Controller-proxied DeepSeek chat requests. The real DeepSeek key is sent to this destination.                                                                                                                                                                         |
| `web-search-base-url` | `https://api.deepseek.com/anthropic/v1` | Trusted upstream for Controller-mediated DeepSeek Anthropic Messages web search. Controlled mode exposes this route when `native.web-search` is effective; native mode exposes it for the official headless graph. The upstream receives the real key only for an accepted search request. |
| `bot-user-id`         | `41898282`                              | Numeric account ID used to recognize Controller-owned sticky comments. The default is `github-actions[bot]`.                                                                                                                                                                               |

`base-url` and `web-search-base-url` are credential-routing decisions, not
ordinary model data. Review non-default endpoints as carefully as any other
secret recipient.

### Operation and publication

| Input                | Default | Accepted values and behavior                                                                                                                                |
| -------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command`            | `auto`  | `auto`, `task`, `review`, `diagnose`, `fix`, or `implement`. `auto` routes from the event; on dispatch/schedule events a non-empty `prompt` selects `task`. |
| `task-access`        | `read`  | `read` or `write`. A write value requests a capability; it does not authorize a write.                                                                      |
| `prompt`             | Empty   | Trusted task instructions. Required when `command: task`. See [Usage](usage.md) for event routing and command examples.                                     |
| `allow-write`        | `false` | Enables consideration of same-repository writes after every actor, event, origin, SHA, protected-path, tool, and validation gate passes.                    |
| `max-findings`       | `20`    | Maximum number of high-confidence findings to publish; accepted range is 1–100.                                                                             |
| `progress-comment`   | `true`  | Enables eligible read-only lifecycle updates. It does not disable normal final results or inline review comments.                                           |
| `task-output-schema` | Empty   | Optional bounded JSON Schema for a final `taskOutput` object. The Controller validates it; it never changes authority or replaces `result-json`.            |

Writing `@dsh fix`, `@dsh implement`, or `@dsh task --write` is never enough by
itself. An actual mutation also requires trusted origin and actors, suitable
workflow token scopes, `run-tests: "true"`, a non-empty `test-commands` list,
successful Controller validation, and an effective `workspace.edit` grant. A
confirmed no-change task can publish only its answer and performs no mutation.

### Routing, filters, and branch UX

| Input                       | Default | Behavior                                                                                                                                                              |
| --------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger-phrase`            | `@dsh`  | Literal first-line command phrase. A custom phrase changes routing only; the command grammar and every authorization gate remain unchanged.                           |
| `label-trigger`             | Empty   | Exact label for an `issues:labeled` task or `pull_request*:labeled` review. Empty disables the route.                                                                 |
| `assignee-trigger`          | Empty   | Exact assignee login for an `issues:assigned` task or `pull_request*:assigned` review. Empty disables the route.                                                      |
| `allowed-actors`            | `*`     | Comma-separated routing allowlist. It cannot make an actor trusted or bypass the GitHub permission check.                                                             |
| `allowed-bots`              | Empty   | Comma-separated bot allowlist. A listed bot must still have repository write permission; unknown and unlisted bot-like accounts fail the write gate.                  |
| `include-comments-by-actor` | Empty   | Optional comma-separated allowlist for historical comments included as untrusted model context.                                                                       |
| `exclude-comments-by-actor` | Empty   | Optional historical-comment deny list. Exclusion wins; the exact triggering comment remains in the audited snapshot.                                                  |
| `base-branch`               | Empty   | Trusted base for Issue and automation materialization and generated PRs. Empty uses the repository default. PR review/fix remains bound to the audited PR head.       |
| `branch-prefix`             | `dsh/`  | Validated prefix for Controller-created task branches.                                                                                                                |
| `branch-name-template`      | Empty   | Optional deterministic template. It must contain `{{prefix}}` and `{{key}}`; supported values also include `{{operation}}`, `{{entityType}}`, and `{{entityNumber}}`. |

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

| Input             | Default                                       | Purpose and constraints                                                                                                                                             |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh-mode`        | `controlled`                                  | `controlled` or experimental `native`. This selects composition ownership only; it does not select trust, authorize GitHub, or reinterpret `permission-profile`.    |
| `dsh-version`     | `0.1.1-rc.2`                                  | Exact audited DSH version. v0.7.0 rejects another version, ranges, and `latest`.                                                                                    |
| `dsh-executable`  | Empty                                         | Optional absolute path to a preinstalled DSH executable for eligible controlled host compatibility. Native mode rejects host execution.                             |
| `isolation`       | `docker`                                      | `docker` or `none`. Untrusted review data, writes, and effective controlled extensions require Docker. Experimental native mode always requires Docker.             |
| `container-image` | Digest-pinned Node 24 image from `action.yml` | Trusted worker code. The value must be one Docker/OCI reference. Writes and effective controlled extensions require a full `name@sha256:<64 lowercase hex>` digest. |
| `timeout-minutes` | `20`                                          | Overall setup/execution deadline; accepted range is 1–360. Fixed short cleanup and cancellation-finalization grace may run afterwards.                              |
| `max-turns`       | `3`                                           | Maximum fresh DSH turns shared by tool requests and validation repairs; accepted range is 1–10.                                                                     |

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

Native currently rejects `isolation: none`. It also fails closed when
Action-managed MCP, Bundle, or Plugin configuration is non-empty. Complete
native Skills/Plugin/Bundle/MCP ecosystem compatibility is deliberately
deferred to Codex 6. Maintainer-defined `command.*` tools and the closed
Controller `github.*` catalog are a separate execution plane and are not tied
to either DSH composition.

### Validation

| Input                  | Default | Purpose                                                                                                                                                                            |
| ---------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run-tests`            | `true`  | Must remain `true` for every code, Git ref, pull-request, and write-task comment mutation. `false` denies the mutation; it is not a waiver.                                        |
| `test-commands`        | `[]`    | JSON array of non-empty argv arrays, for example `[["npm","test"],["npm","run","typecheck"]]`. Every configured command must pass before a write. No shell expansion is performed. |
| `validation-integrity` | `warn`  | `off`, `warn`, or `strict`; controls the Controller-owned audit of changes to tests, scripts, lint/typecheck/build configuration, and other validation definitions.                |

Validation runs in a disposable, credential-free Docker container after all
trusted-write gates pass. Do not place `GITHUB_TOKEN`, the DeepSeek key, or
another Controller credential in validation argv. Replace example npm commands
with deterministic validation commands for your repository.

### Agent tools and extensions

| Input                  | Default                                         | Purpose                                                                                                                            |
| ---------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `permission-profile`   | `strict`                                        | Agent tool preset: `strict`, `standard`, or `custom`. This does not grant GitHub authority.                                        |
| `allowed-tools`        | `[]`                                            | JSON array of exact canonical tool IDs requested in addition to preset expansion. Configuration alone does not authorize a tool.   |
| `disallowed-tools`     | `[]`                                            | JSON array of exact canonical tool IDs. Deny always wins.                                                                          |
| `tool-config`          | `{"schemaVersion":1,"commands":[]}`             | Versioned manifest of maintainer-owned, fixed-argv `command.*` tools.                                                              |
| `mcp-config`           | `{"schemaVersion":1,"servers":[]}`              | Versioned allowlist for official DSH MCP servers and their tools.                                                                  |
| `plugin-config`        | `{"schemaVersion":1,"bundles":[],"plugins":[]}` | Versioned allowlist for DSH Bundles and direct Cordis plugins.                                                                     |
| `allow-plugin-install` | `false`                                         | Separate startup gate for an effective third-party Bundle or plugin package. Installation and startup execute trusted worker code. |

All three manifests require `schemaVersion: 1`; unknown fields and unsupported
versions fail closed. MCP, Bundle, and Plugin configuration uses the advanced
`custom` profile path. `strict` remains accepted for v0.4 compatibility, but
`standard` with extension configuration is rejected.

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

Canonical Action tool IDs are:

- `workspace.read`, `workspace.search`, and `workspace.edit`;
- `native.bash`, `native.web-search`, and `native.subagent`;
- `command.<name>` for Controller fixed-argv tools;
- `github.issue.labels.set`, `github.issue.assignees.set`,
  `github.issue.state.update`, `github.comment.create`,
  `github.pull.metadata.update`, and `github.checks.read`;
- `mcp.<server-id>.<tool-id>` for MCP tools; and
- `plugin.<extension-id>.<tool-id>` for Bundle or direct plugin tools.

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
- one generic `extension-credential` record for each effective MCP server or
  direct plugin configured with credential-like explicit workflow data.

Extension entries identify only the effective owner kind and ID. They never
contain or classify a secret value, hash, header, argv/env value, URL
path/query, or secret count. A configured extension with no effective tool is
not reported. The entry records an accepted configuration plan, not observed
extension startup or credential use. The audit is intentionally incomplete: it
records only sources the Action knows, configures, or mediates and does not
prove that trusted worker or extension code lacks network, runner ambient
state, or other authority. It is observability, not authorization.

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

This section applies to controlled mode. Native currently rejects any non-empty
`mcp-config` rather than claiming compatibility with DSH's full native MCP
ecosystem.

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

## Bundle, Plugin, and Profile loading

This section applies to controlled mode. Native currently rejects non-empty
Bundle or Plugin configuration; support remains deferred to Codex 6.

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
  egress. It is not a destination allowlist.
- Network namespaces and mounts apply to the complete DSH process, not one tool.
  All co-hosted extension owners must agree on network and workspace-write mode.
- The validation container currently uses bridge networking for validation
  commands, including dependency installation. On a self-hosted or
  corporate-network runner, repository validation code may reach services
  available through that Docker bridge path. Apply dedicated runner
  segmentation and egress controls when source confidentiality, reproducibility,
  or internal-network isolation requires them.

The selected `container-image` itself is trusted worker code. An immutable digest
proves identity, not safety; review and maintain the image separately.

### GitHub image attachments

v0.7.0 does not download or forward GitHub image attachments. The exact audited
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
| `network-access`           | Effective `host-gateway`, `mediated-web`, `bridge`, or unresolved `none` worker path.                                                                                        |
| `workspace-write`          | Whether the effective Agent tools can modify the disposable workspace.                                                                                                       |
| `trusted-extensions`       | JSON array of Controller-approved MCP, Bundle, and Plugin owners loaded for the run.                                                                                         |
| `duration-ms`              | Total Controller duration in milliseconds.                                                                                                                                   |
| `comment-id`               | Sticky progress/result comment ID when tracking was available.                                                                                                               |
| `error-code`               | Stable failure code; empty on success or neutral completion.                                                                                                                 |
| `error-message`            | Redacted and bounded failure message.                                                                                                                                        |
| `extension-profile-digest` | SHA-256 digest of the redacted Controller-generated extension audit Profile; empty when unavailable.                                                                         |
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
audit, effective controlled-extension audit, bounded receipts,
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
native DSH inventory. A validated task may add an optional `taskOutput` field without
changing the fixed envelope or schema version. `status` is one of `success`, `neutral`, `failed`, `timed_out`,
`validation_failed`, or `denied`. Known errors expose stable `error.code`,
`error.category`, and `error.retryable` identity. `error.phase` separately
records the Controller lifecycle location where the error surfaced; it does not
reclassify a known error.

Failed steps set outputs before failing. Read them from a later `always()` step
without interpolating model-derived text into a shell command:

```yaml
- uses: Lixiaoyiao/deepseek-harness-action@v0.7.0
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
