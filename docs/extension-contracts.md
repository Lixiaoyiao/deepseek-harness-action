# Extension contracts

## Status in v0.5.1

The extension model introduced in v0.4 remains active in v0.5.1 through DeepSeek Harness's
official extension mechanisms. The Action does not define a second plugin
system:

- `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2` owns MCP connection, discovery,
  registration, reconnect, and dispatch.
- DSH Profile and Bundle manifests own Bundle composition. Cordis owns plugin
  loading and configuration.
- The Action Controller validates trusted workflow inputs, computes the
  effective grants, generates the `github-action` Profile and Cordis patch, and
  installs one positive ToolRuntime policy adapter.
- The v0.3 placeholder `ExtensionProvider` seam has been removed. MCP and
  plugin tools are not routed through a parallel Action plugin registry.

Session resume remains deferred. Every outer-loop iteration starts a fresh DSH
headless process over the same run-scoped `.git`-less workspace and persistent
invocation-count files. The Action boots its controlled Profile through the
official `@deepseek-ai/dsh-app-boot@0.1.1-rc.2` public API rather than the
general-purpose CLI path. v0.5.1 adds no Session/Resume input, reusable session
token, Label/Assignee trigger, custom trigger phrase, branch template, Agent
Teams, GitHub App/installer, or other product expansion.

## Versioned configuration

`mcp-config`, `plugin-config`, and `tool-config` currently require
`schemaVersion: 1`. Agent turns and structured DSH output independently use
protocol version 1. Unknown fields and unsupported schema versions fail closed.

The Controller accepts only `@deepseek-ai/dsh@0.1.1-rc.2` and the matching
official package family. Every directly used DSH package is an exact top-level
pin, shipped packages are installed from the committed lockfile, and the
runtime verifies that every installed `@deepseek-ai/dsh*` entry has the audited
rc.2 version. A new DSH version requires a reviewed Profile, native tool
inventory, compatibility tests, and a new accepted pin.

The rc.8-to-rc.2 audit covered app-boot, Profile/Bundle/Plugin composition,
MCP, ToolRuntime, Bash, Web Search, Subagent, receipts, and Docker/path/timeout
behavior. rc.2's relevant runtime contracts remain compatible with the
Action's existing inputs, outputs, and permission semantics; the updated DSH
sandbox also adds its upstream process-namespace hardening. This compatibility
statement applies only to `0.1.1-rc.2` and is not an approval for later release
candidates.

## Run-scoped lifecycle and bounded phases

The runtime controller is separated into process launch, exact package
installation and inventory audit, network selection, Docker policy, Profile
assembly, and receipt reconciliation responsibilities. Their temporary
directories, DSH home, npm cache, sessions, counters, and tool state are bound
to one Action run. Runtime reuse requires the complete audited identity to
match; setup or extension-install failure rolls back partially created state.

Runtime creation and installation, extension installation, each Agent turn,
Controller validation, cleanup, and cancellation finalization each have an
independent cap. A phase always receives the smaller of that cap and the
remaining overall Action deadline, so setup cannot consume the entire task
budget and no local phase budget can extend the total deadline. `SIGTERM` and
`SIGINT` trigger a bounded best-effort abort, worker cleanup, and eligible
sticky-comment finalization. `SIGKILL`, host/runner loss, a process crash, or a
network/GitHub API outage can prevent finalization entirely.

`container-image`, `base-url`, `isolation`, and `dsh-executable` are trusted
capability inputs. They select executable worker code, the destination that
receives controller-proxied DeepSeek requests, or whether a process boundary
exists, so they must never be derived from repository/event/model content.
Every supplied image value is validated as one Docker/OCI reference and cannot
begin with an option or contain argument-breaking whitespace. Extensions and
writes additionally require an immutable full image digest.

Third-party Bundle and plugin sources use a different lock boundary. Each
top-level package must be an exact semver or a GitHub `git+https` URL pinned to
a 40-character commit. `latest`, semver ranges, floating Git refs, and attempts
to replace Controller-owned DSH packages are invalid. NPM lifecycle scripts are
disabled during installation, but the resolved transitive graph is still a
trusted supply-chain decision and package startup remains trusted code
execution. Before installation the Controller snapshots every top-level runtime
package identity and version. It reads that inventory again afterwards and
rejects an installation that removed or changed any pre-existing runtime
package before starting DSH.

## One Controller policy, two execution planes

The tool catalog has two deliberately separate execution planes:

1. The Controller `ToolRouter` invokes maintainer-defined `command.*` tools.
   These accept no model arguments and execute fixed complete argv in separate
   credential-free containers.
2. DSH `ToolRuntime` invokes model-routed native workspace, official MCP, and
   Cordis plugin tools inside the DSH worker. An Action-owned Cordis policy
   adapter applies the Controller-generated positive runtime allowlist and
   budgets to those routed invocations.

Both planes use the same Controller-resolved security capabilities and expose
canonical `AgentToolManifest` records to the model. Routing or registration is
not authorization. A configured tool becomes effective only when its canonical
ID is also in `allowed-tools` and every requested permission is allowed by the
current actor/origin/event policy. This limits the model-facing dispatcher; it
does not sandbox already-approved stdio, Bundle, or plugin code that performs
startup, background, or direct process I/O.

Canonical Action IDs are:

- `workspace.read`, `workspace.search`, and `workspace.edit` for audited DSH
  native tools;
- `command.<name>` for fixed-argv Controller tools;
- `mcp.<server-id>.<tool-id>` for MCP tools; and
- `plugin.<extension-id>.<tool-id>` for Bundle or direct plugin tools.

The Action derives MCP's model-facing `mcp__<server>__<raw-tool>` name with the
official normalization and hash contract. Package tools must declare a unique
runtime name beginning with `plugin__<extension-id>__`. A model-facing runtime
name never replaces the canonical Action ID as an authorization key.

## Controlled Profile, Bundle, and Cordis loading

For Docker execution, the Controller generates
`$DSH_HOME/profiles/github-action/package.json`, `cordis.patch.yml`, and
`pnpm-workspace.yaml`. The Profile always composes the reviewed
`@deepseek-ai/dsh-base` and `@deepseek-ai/dsh-headless` Bundles, then adds only
effective third-party Bundles to `dsh.profile.bundles`.

The generated Cordis patch:

- disables unapproved shell, web, skill, subagent, workflow, and code-runtime
  rows from the base Bundle;
- configures the DSH sandbox and filesystem root for the bound workspace;
- inserts only effective official MCP and direct plugin rows;
- inserts the Action-owned workspace and ToolRuntime policy adapters; and
- serializes workflow values as JSON data, preventing a string from becoming a
  new YAML patch row or `!!js` expression.

The Action passes that generated Profile and Cordis patch directly to the
official app-boot API. It does not load workspace or `$DSH_HOME` `.env` files,
and it does not enable the CLI's dynamic user-patch discovery, watch, or hot
reload path. Repository content and files left in DSH home therefore cannot add
an extension row or environment value after Controller validation.

`allow-plugin-install` defaults to `false`. When it is true and at least one
package tool is effective, installation uses the exact top-level source with
NPM lifecycle scripts disabled. After installation the Controller verifies the
package identity and version or Git commit. For a Bundle it also resolves
`dsh.bundle.patch` and rejects a patch path whose real path escapes the
installed package.

These checks and ToolRuntime do not sandbox approved package code. A Bundle
patch and direct plugin execute full trusted worker code in the DSH process
during startup, before any model tool call. The package may continue background
work or perform direct process I/O outside the ToolRuntime call hook. The same
boundary applies to launching an approved stdio MCP executable. Treat enabling it as
trusted worker-code execution and review its source, transitive dependencies,
configuration, filesystem access, and network requirements.

## Official MCP contract

`mcp-config` exposes only transports supported by the official rc.2 client:

- `stdio`, with a bare executable name or absolute container path; or
- `streamable-http`, with an HTTP(S) URL and explicit headers.

Stdio commands cannot be shells, interpreters, downloaders, package managers,
Git, dynamic runners, relative paths, or executables under `/workspace`.
Optional `cwd` is repository-relative and cannot escape the workspace. Env
names that alter executable lookup, loaders, or interpreter startup are
rejected. Starting the configured executable is full trusted worker-code
execution. Credential-like argv fields and env entries are masked as worker
credentials; ordinary argv and env values are not automatically treated as
secrets. HTTP URLs cannot embed credentials or fragments and cannot override
transport-owned headers. Structured audit output exposes only the URL origin,
not pathname, query, or headers; the public profile digest covers this redacted
audit surface, while a separate Controller-only digest binds the complete
validated server definition.

The real DeepSeek key and configured GitHub token values are rejected from
extension configuration. Names such as `DEEPSEEK_API_KEY`, `GITHUB_TOKEN`,
`GH_TOKEN`, and GitHub Actions OIDC variables are also reserved. An extension
may receive its own explicit env/header secret; it is masked and treated as a
worker credential, not Controller authority.

The Controller-secret rejection scan walks all nested object keys and string
values in both manifests and checks percent-decoded variants, including encoded
URL path and query material. The extension-secret masking set is intentionally
narrower: beyond withheld HTTP URL path/query candidates, only credential-like
stdio argv fields, env/header entries, and plugin configuration values nested
under credential-like keys are included. Ordinary plugin values such as `read`
and `safe-json` are not registered as secrets or masked.

Every selected server starts with `failOnStartupError: true`. Only a tool that
is selected by `allowed-tools` and survives Controller policy to become
effective is required to appear in the runtime inventory; its absence fails
closed. Before restriction, the model-visible inventory must satisfy
`visible ⊆ known` and `allowed ⊆ visible`: every visible tool is in the
Controller-audited inventory, and every allowed tool registered successfully. A
configured but unselected known tool may be absent. After restriction,
`visible == allowed`; any unknown tool, missing allowed tool, or unselected known
tool that remains visible fails closed, including an agent-scoped registration
that the global restriction could not hide. The monotonic ToolRuntime guard also
denies every invocation without an effective Controller rule. MCP results remain
untrusted data even when the server and workflow configuration are trusted.

The official client exposes a server-wide `toolCallTimeoutMs`. The Action sets
it to the largest timeout among that server's effective, allowed tools so a
slower approved tool is not cut off by a faster sibling. The Action-owned
ToolRuntime policy then applies each tool's own timeout as an additional,
potentially tighter upper bound.

## Process-level permission compatibility

`read`, `workspace-write`, and `network` are declared on every extension tool,
but filesystem mounts and network namespaces belong to the whole DSH process.
Every extension tool must include `read`, because all co-hosted extension code
shares the Agent's repository view. The Controller therefore rejects unsafe
co-tenancy rather than pretending to provide per-tool process isolation:

- all configured tools from one MCP server or package must agree on
  `workspace-write`;
- all effective MCP servers, Bundles, and plugins in one worker must agree on
  both network and workspace-write mode;
- a trusted-read worker accepts only read-only owners;
- every owner in a trusted-write worker must declare `workspace-write`; and
- any effective MCP, Bundle, or plugin requires Docker isolation. The host-only
  `dsh-executable` compatibility path never loads extensions.

`network=false` does not mean that the worker has no network path. When no owner
requests network, the worker uses an internal Docker network that blocks
ordinary external egress. The Controller inspects that network's IPv4 gateway
and maps `host.docker.internal` to the inspected address for the Controller LLM
proxy; an invalid or missing inspected gateway fails closed. This host-gateway
route is required for model traffic and is not a port-level allowlist, so runner
firewall policy must protect other host services. When owners request network,
the co-hosted DSH process uses Docker bridge egress. This is not a destination
allowlist. Package acquisition also uses bridge networking even when the
package's later runtime mode is network-disabled.

## ToolRuntime limits and receipts

The positive DSH policy assigns each native, MCP, or plugin runtime tool:

- a per-call `timeoutMs`;
- a serialized `maxOutputBytes` limit;
- a per-tool `maxCalls` limit; and
- a group limit shared by the native workspace group or owning MCP/package.

Invocation counts are Controller-created state stored outside the disposable
DSH process, so fresh turns in one multi-turn loop cannot reset them. Counts are
reserved before dispatch. Crashes and failures therefore still consume an
invocation during normal routed execution. The state file is telemetry, not a
tamper-proof enforcement ledger against trusted code: an already-approved
extension shares the worker process/filesystem and can influence it.

MCP subprocess/HTTP timeout behavior is provided by the official client and the
Action abort signal. A same-process plugin timeout is cooperative: the policy
returns a controlled timeout result, while only the overall Controller deadline
can hard-stop a plugin that ignores cancellation by terminating the worker.

DSH durably records two-phase admission (`started`) and completion (`completed`)
events without arguments or tool output. The Controller reconciles those events
with the persistent tool and owner counters into one final receipt per call; a
worker crash after admission becomes `completed:false`. It aggregates those
final receipts across every fresh DSH turn before Action finalization. Receipt
collection reads only the newly appended byte range after the previous offset
and uses set membership when reconciling receipt order. This keeps repeated
multi-turn collection proportional to new records instead of rescanning the
whole file, without changing the receipt schema or security meaning.
`result-json.loop` separates Controller `toolReceipts` from DSH
`dshToolReceipts`; the bounded `tool-receipts` scalar output always serializes
`{"controller": [...], "dsh": [...], "truncated": false, "droppedCount": 0}`.
When the shared Action-output budget drops receipts, `truncated` becomes `true`
and `droppedCount` reports the exact number omitted; the retained arrays are
also used in `result-json.loop`, which records the same truncation count.
Receipts and extension audit data are observability only and never authorization
input or independent proof. Approved trusted extension code can influence
worker-side state and receipts.

## Repository-mutation validation

Every code, Git ref and pull-request mutation requires `run-tests=true`, at
least one configured `test-commands` argv array, and successful completion of
every Controller validation command. `run-tests=false` denies the mutation and
is not a waiver. This hardening is intentionally stricter than the earlier
compatibility path; no model output, ToolRuntime receipt, or extension result
can replace the final validation gate.

v0.5.1 builds the validation-integrity audit from a normalized command graph,
including package-script entrypoints and Node wrapper options such as preload
modules. Strict mode treats replacement/removal of bound toolchain manifests or
locks, removed validation keys hidden by unrelated additions, and equivalent
wrapper indirection as control-plane changes. The graph and replay planning are
separate from execution, and a detected weakening still prevents every GitHub
mutation.

Controller-owned read-only lifecycle/status comments are publication telemetry
and may follow authorization before repository validation. A write request does
not call any comment API before every final Controller validation command
succeeds. A failed gate therefore produces no GitHub comment, commit, ref update
or pull request; its bounded failure remains in Action outputs and the step
summary.

## `AgentEngine` and deferred sessions

`AgentEngine<TOutput, TMetadata>` remains the provider-neutral outer-turn
boundary. `DshAgentEngine` is the only current implementation. It receives the
Controller-selected operation, requested access, trusted instructions, bounded
untrusted context, effective manifests, bound workspace, and remaining timeout.
The Controller validates the returned protocol, operation, paths, and terminal
state before any validation, publication, or GitHub write.

`SessionStore`, `AgentSessionBinding`, and `AgentSessionHandle` remain reserved
interfaces only. v0.5.1 does not instantiate a store or expose a resume token.
The redacted extension audit digest is included in public task identity and
output audit data, while the Controller-only complete configuration digest binds
runtime reuse. Neither digest is a reusable session credential. Any
future resume feature must additionally bind repository, target, immutable head
SHA, actor, policy, task scope, engine, effective toolset, and extension lock,
and must prevent replay of prior tool call IDs.
