# Security policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting rather than opening a public
issue. Include the affected version, event type, trust boundary and a minimal
reproduction. Do not include live credentials.

## Trust model

The model separates four independent questions: who may request work, which
bytes are instructions, what the worker may do, and which component may mutate
GitHub. A trusted actor never makes repository content trusted.

### 1. Actor and control-plane trust

The checked-in workflow configuration and explicit action inputs are trusted
control-plane configuration. An interactive command is recognized only from
the first line of the triggering comment or review. After authorization, the
parsed first-line remainder and all subsequent command-body lines are treated
as operator instructions. An authorized operator must not paste untrusted
Issue text, logs or third-party output into that command body without accepting
that control-plane promotion.

- Interactive `@dsh` commands require every originating actor to have
  write/maintain/admin repository permission. Permission lookup failures deny
  authority. Bots are not accepted by the default controller configuration.
- A `workflow_run` write checks the receiving actor, the upstream run actor and
  the rerun/triggering actor. Every identity must pass.
- Automatic fork review remains available without trusting the pull request
  author, but it is restricted to the `untrusted` worker profile.
- `allow-write` defaults to `false`. A code, Git ref, or pull-request mutation additionally requires a
  same-repository target, an eligible event, an unchanged bound identity and an
  explicitly pinned validation image. It also requires `run-tests=true`, at
  least one configured `test-commands` argv array, and successful execution of
  every validation command. `run-tests=false` denies the write and is not a
  waiver.
- GitHub workflow token permissions are a separate gate. They grant the
  controller API access but cannot bypass actor, origin, event or policy checks.

For a read-only operation, the controller creates a lifecycle comment only
after the operation is allowed and a pull request or issue target has been
resolved. A denied request therefore cannot use progress tracking to generate
bot comment spam. A write request creates no lifecycle or status comment before
every final Controller validation command succeeds or the Controller confirms
there is no repository change to validate. A failed gate therefore produces no
GitHub comment, commit, ref update or pull request; the bounded failure remains
in Action outputs and the step summary. A confirmed no-change `task --write`
may publish its final answer, but performs no repository mutation.

#### Explicit prompts are trusted control-plane input

The `prompt` action input is deliberately treated as maintainer-authored
instruction. GitHub evaluates `${{ ... }}` expressions before the action starts,
so the action cannot recover the provenance of an interpolated value. Do not put
event-controlled data into `prompt`, for example:

```yaml
with:
  command: task
  prompt: ${{ github.event.issue.body }} # unsafe: issue text becomes instruction
```

The same rule applies to capability-bearing inputs such as `command`,
`task-access`, `allow-write`, `permission-profile`, `allowed-tools`,
`disallowed-tools`, `tool-config`, `mcp-config`, `plugin-config`,
`allow-plugin-install`, `run-tests`, `test-commands`, `validation-integrity`,
`container-image`, `base-url`, `web-search-base-url`, `isolation`, and
`dsh-executable`: keep them literal or derive them only from trusted workflow
configuration. These values select Agent authority, executable worker code,
credential-routing destinations, validation policy, or whether an
operating-system boundary exists. In particular, do not interpolate pull
request titles/bodies, comments, CI output, repository files, a serialized
event or model output into those inputs. Let the action fetch event and
repository context itself; it will place those bytes in the bounded
untrusted-data channel. A prompt cannot change its permission profile, lower
validation integrity, or authorize/install an MCP server, Bundle or plugin.

### 2. Input and data trust

Repository files, diffs, CI logs, README, AGENTS.md, CLAUDE.md, issues, pull
requests, comments, previous model prose and tool output are untrusted data.
They are placed inside bounded untrusted context and never interpreted as
controller instructions.

- Agent output is also untrusted. The controller accepts only one complete JSON
  value and rejects unknown fields, invalid paths, unsafe ranges, oversized
  collections and controller-owned tracking markers.
- The controlled root Profile repeats that machine-output rule after rc.2
  tool-specific system guidance and binds the JSON `operation` field to the
  exact Controller-selected operation. Markdown citations are allowed only
  inside JSON string fields; they never authorize operation changes, fences,
  prefixes, suffixes or a separate citation list. This section is empty for
  delegated subagents, whose ordinary response is consumed by the root Agent
  rather than the controller.
- A repair turn cannot turn an unresolved Controller validation or Validation
  Integrity failure into a neutral result by returning `blocked`. The original
  failure and integrity audit remain authoritative, and no GitHub mutation is
  attempted.
- CI evidence is selected by repository and immutable head SHA, bounded,
  redacted and explicitly labelled as untrusted before it reaches DSH.
- Comment bodies are stripped of reserved markers and sanitized before
  publication. Tracking comments are indexed only when authored by the
  configured numeric bot user ID, so a forged marker does not gain ownership.
- Failure messages exposed in comments, step summaries and outputs are redacted
  and bounded. The versioned `result-json` envelope is observability data, not
  an authorization input.
- A successful controller tool does not make its stdout or stderr trustworthy.
  Tool results are redacted, byte-bounded, labelled by the controller and fed
  back only as untrusted repair evidence. Repository code may print prompt
  injection text even when the configured command itself is trusted.

### 3. Worker trust and execution profiles

`untrusted`, `trusted-read` and `trusted-write` name effective execution
profiles. They do not classify repository bytes as trustworthy.

| Profile         | Repository access                                       | Worker tools                                                                                                 | Repository code execution                                                            | GitHub authority |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------- |
| `untrusted`     | None                                                    | No filesystem, MCP, plugin, shell, web, repository instructions or subagents                                 | Disabled                                                                             | None             |
| `trusted-read`  | Immutable read-only `.git`-less copy when Docker-backed | Permission-profile tools after Controller intersection; edit, Bash and subagent are denied                   | Disabled except audited extension startup; mediated web may be allowed               | None             |
| `trusted-write` | Read/write `.git`-less copy                             | Permission-profile tools after Controller intersection, including opt-in native Bash/subagent and extensions | Enabled only in credential-free Docker under the selected trusted permission profile | None             |

Trust profiles above answer whether the event and actor may access the
repository. v0.5 permission profiles are a separate, monotonic Agent-tool
dimension:

| Permission profile | Preset request                                                        | Intended use                            |
| ------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| `strict`           | `workspace.read`, `workspace.search`, `workspace.edit`                | v0.4-compatible default and review      |
| `standard`         | strict plus `native.bash`, `native.web-search`, and `native.subagent` | trusted maintainer coding               |
| `custom`           | no preset; every canonical tool ID is explicit                        | precise policy, MCP, Bundle, and Plugin |

Preset expansion does not bypass trust. Exact `disallowed-tools` entries always
win over the preset and `allowed-tools`; the remaining requests are intersected
with event, actor, workspace, network, configured-provider, and Controller
policy. Unknown, unavailable, or policy-ineligible tools fail closed with a
reason in the permission audit. The Agent cannot modify its profile, allow/deny
lists, or policy and cannot approve an extension or permission escalation.

Fork and other untrusted runs require Docker isolation. Trusted writes also
require Docker and a full `name@sha256:<64 lowercase hex>` image reference. The
worker never receives a GitHub client, checkout credential, real GitHub token or
real DeepSeek API key. Every supplied image value is validated as one Docker/OCI
reference before it is appended after Docker's options; leading-option values,
whitespace, and other argument-breaking forms are rejected even on read-only
paths where a mutable tag remains compatible. This prevents Docker option
injection but does not make an operator-selected image trustworthy.

DSH receives an ephemeral proxy token. A controller-side proxy injects the real
DeepSeek key only on fixed POST routes: chat completions, plus the exact
Anthropic Messages route when `native.web-search` is effective. For the latter,
the Controller replaces both upstream `Authorization` and `x-api-key`
credentials; it rejects query strings, extra path segments, `web_fetch`, and
arbitrary URLs. The actual backend, workspace access and known limitations are
recorded in the structured isolation report rather than inferred from the
requested profile. Both `base-url` and `web-search-base-url` choose upstreams
that receive the real key, so they are trusted credential-routing inputs, not
untrusted request data.

#### Maintainer-defined controller tools

Command tools, introduced in v0.3, are fixed-argv controller capabilities. A
maintainer defines the executable and every argument in versioned `tool-config`,
then separately allowlists the resulting `command.<name>` ID. The model may
select an advertised ID and give a reason, but this provider rejects
model-supplied arguments and never supplies a shell. Direct shell interpreters
are rejected at configuration parsing as an additional guard; the primary
boundary is that all argv bytes are trusted workflow configuration, not model
output. The separate `native.bash` capability is opt-in through
`standard`/`custom`, requires the trusted-write Docker policy, runs bounded
foreground commands without escalation approval, and cannot share a worker
with a bridge-networked extension.

Each command tool runs in a named, hardened, credential-free container with a
read-only container root, dropped capabilities, `no-new-privileges`, resource
limits and bounded output. The effective tool set is the intersection of the
maintainer configuration, `allowed-tools` and the controller policy:

- `workspaceAccess` defaults to `read`, which mounts the `.git`-less worker copy
  read-only. `write` must be explicit and is unavailable without the
  `modifyWorkspace` capability.
- `network` defaults to `none`. `bridge` must be explicit and is unavailable
  without the controller's network capability. Bridge networking is not a
  destination allowlist and may expose repository contents to arbitrary egress
  destinations permitted by the runner network.
- The real GitHub token and DeepSeek key are never placed in the command
  container. Input validation rejects either controller credential if a trusted
  workflow interpolates it into the task prompt, command-tool argv, or
  validation argv. Immediately before launch, the complete worker prompt, argv,
  and environment are checked again; worker output and receipts also fail
  closed if they contain a withheld credential, without echoing the value.
  Command output remains untrusted even though the argv is trusted.

#### Controlled DSH native, MCP, Bundle, and plugin tools

v0.4 introduced the official DSH extension mechanisms. v0.5.1 re-audits them
against the exact `@deepseek-ai/dsh@0.1.1-rc.2` package family, generates a
controlled Profile, and
loads the approved Bundle and Cordis plugin rows from that Profile. It does not
read extension authorization from the repository or model response and does not
run model-generated `npm`, Git, or plugin-install commands. The generated Cordis
patch serializes workflow values as JSON data so a configured string cannot add
a patch row or become a YAML `!!js` expression; an approved Bundle's own patch
remains trusted package code.

The rc.8-to-rc.2 compatibility audit covered app-boot, Profile/Bundle/Plugin,
MCP, ToolRuntime, Bash, Web Search, Subagent, receipts, Docker/path/timeout
handling, and the packaged `dist` entrypoint. It did not require a change to
the Action's existing input, output, or permission semantics. That conclusion
does not approve any release after `0.1.1-rc.2`.

The Action starts this generated Profile through the official
`@deepseek-ai/dsh-app-boot@0.1.1-rc.2` public API. It does not use the general
CLI path that discovers workspace or `$DSH_HOME` `.env` files, nor does it
enable dynamic user patch discovery, watch or hot reload. The only Profile and
Cordis patch inputs come from the Controller-validated run configuration.

The effective runtime tool set is a positive intersection of the selected
permission preset, exact allow/deny lists, strict configuration manifests, and
Controller policy. Model-routed
DSH native, MCP and plugin calls pass through an Action-owned ToolRuntime policy
adapter; fixed-argv `command.*` calls continue through the controller
ToolRouter. The same capability compiler supplies both enforcement planes:

- Any effective MCP, Bundle or plugin tool requires Docker isolation. The
  local `dsh-executable` compatibility path rejects extension loading.
- `read` requires repository-read capability. MCP/Plugin tools are unavailable
  in the `untrusted` fork profile.
- `workspace-write` additionally requires trusted-write, explicit
  `allow-write`, same-repository origin and actor gates. Protected paths and the
  final validation gate still apply to the resulting file changes.
- `network` must be declared by the server/package and every exposed tool and
  must be allowed by the current policy. A Streamable HTTP MCP server therefore
  always requires network. Network-enabled worker execution is not a
  destination allowlist.
- `native.web-search` is a separate Controller-mediated path to the configured
  DeepSeek Messages endpoint. It exposes neither the real key nor arbitrary URL
  fetch and does not imply general Docker bridge egress. `native.bash` remains
  inside the credential-free trusted-write Docker worker and cannot share a
  worker with a bridge-networked extension.
- A non-bridge worker still reaches the Controller proxy through the inspected
  Docker host gateway. Permission output therefore reports `host-gateway`, not
  physical zero networking; that path is not a port allowlist, so runner firewall
  policy remains responsible for other host services.
- Network namespaces and workspace mounts belong to the whole DSH process. All
  co-hosted extension owners must declare the same network and workspace-write
  mode; every owner in trusted-write must opt into workspace-write. Mixed modes
  are rejected rather than presented as per-tool process isolation.
- Every extension tool must declare `read`: an extension process shares the
  Agent's repository view, so a narrower per-tool read claim would be false.
- Each DSH-native, MCP or plugin tool has a timeout, serialized output limit,
  per-tool invocation limit and owning server/package invocation limit. Counts
  survive the fresh DSH turns in one controller loop. Before restriction, the
  model-visible inventory must satisfy `visible ⊆ known` and
  `allowed ⊆ visible`; after restriction it must satisfy
  `visible == allowed`. A configured but unselected known tool need not
  register, but it must not remain visible after restriction. An unknown tool,
  a missing allowed tool, or an unselected known tool that remains visible
  fails closed. The ToolRuntime guard independently and monotonically denies
  any invocation without an effective Controller rule. Same-process plugin
  timeout cancellation is cooperative; the overall Controller deadline is the
  hard process-stop boundary.
- The official MCP client has one server-wide call timeout. For each effective
  server, the Action sets it to the maximum `timeoutMs` among that server's
  allowed tools, then the Action-owned per-tool policy tightens each invocation
  to that tool's own deadline.
- Tool arguments and results are untrusted model data. The Action-owned worker
  policy records a durable admission event before dispatch and a completion
  event afterwards. The Controller reconciles those two phases into one final
  receipt per call, retains an incomplete receipt after a post-admission crash,
  and aggregates receipts across fresh DSH turns before final Action output.
  Collection reads only the newly appended byte range and uses set membership
  for ordering, avoiding repeated whole-file scans without changing the receipt
  schema or its non-authoritative security role.
  The bounded `tool-receipts` output always includes separate `controller` and
  `dsh` arrays, a `truncated` boolean, and `droppedCount`. Neither a receipt,
  model explanation nor tool success is authorization. Persistent invocation
  state and receipts are telemetry, not tamper-proof security logs;
  already-approved trusted extension code shares the worker process/filesystem
  and can influence them.

ToolRuntime controls calls routed through DSH's model tool dispatcher. It is not
a sandbox for already-approved executable code. A stdio server, Bundle, or
plugin can act during launch or startup, in background work, or through direct
process I/O without waiting for a model-routed tool call. The Docker mount/network
boundary and review of that complete code are therefore authoritative for its
process-level effects.

`mcp-config` supports only the transports implemented by the official client:
`stdio` and `streamable-http`. A stdio command must be a bare executable name or
an absolute container path outside `/workspace`; shells, interpreters,
downloaders, package managers, Git and dynamic runners are rejected. Supply it
through an audited image or another explicitly trusted package, and pin the
image by digest. Starting that executable is full trusted worker-code execution,
even though model-routed individual calls remain ToolRuntime-guarded. HTTP URLs
cannot embed credentials or fragments. The structured extension audit publishes
only an HTTP endpoint's origin; pathname, query, and headers are withheld while
the public profile digest covers that redacted audit surface. A separate
Controller-only digest binds the full validated configuration for runtime reuse. An
extension may receive its own explicit env/header secret, but configuration
rejects the real DeepSeek key and configured GitHub token values, plus their
reserved names and GitHub Actions OIDC variable names.

Controller-credential rejection recursively scans every string value and object
key in the parsed MCP and plugin configuration. It also checks percent-decoded
variants, including encoded URL path or query material, so encoding a Controller
credential does not bypass the check. Extension-secret masking is deliberately
narrower: in addition to withheld HTTP URL path/query material, it includes only
credential-like stdio argv fields, env/header entries, and plugin configuration
values nested under credential-like keys. Ordinary configuration values such as
`read` and `safe-json` are not registered as secrets or masked.

`plugin-config` accepts only an exact npm semver or a GitHub `git+https` source
pinned to a 40-character commit. `latest`, ranges and floating Git refs are
invalid. Installation is disabled by default and requires the independent
`allow-plugin-install=true` gate in trusted workflow configuration.

Third-party Bundle installation and startup are **trusted code execution**.
NPM lifecycle scripts are disabled during acquisition, but package code runs
inside the DSH process before a model asks for a tool, so the ToolRuntime call
allowlist is not a sandbox for plugin initialization or other package side
effects. Enabling installation also permits the runner to obtain the exact
package and its dependency graph; a package's runtime `network: false`
declaration does not make registry acquisition offline. Review the package,
transitive dependencies and Bundle patch, use immutable sources, and apply
runner-level filesystem/network isolation appropriate for trusted code. The
Controller snapshots the full top-level runtime package inventory before
installation and rejects any removal or version change afterwards. It also
verifies the installed extension identity and pin and ensures the declared
Bundle patch stays within its installed package before startup.

#### Validation-definition integrity

Repository validation is meaningful only if the Controller notices when the
candidate also changes its definition. v0.5.1 classifies package scripts, test
sources/configuration, lint, typecheck, build configuration, validation runtime
files, and other effective entrypoints independently from ordinary code changes.
Changing tests with the implementation is supported; a test change is not a
denial by itself.

The audit follows a normalized command graph rather than only the first argv
token. It includes package-script entrypoints and Node wrapper options such as
preload modules, and treats replacement/removal of bound toolchain
manifests/locks or validation keys hidden by unrelated additions as
control-plane changes. Graph construction and replay planning remain separate
from execution; validation and validation integrity must both pass before any
GitHub mutation.

- `off` records the classified changes without blocking them.
- `warn` is the default and reports changed categories and weakening signals.
- `strict` blocks high-confidence weakening and a truncated integrity audit. For
  other control-plane definition changes it validates the candidate code/tests
  in a baseline replay workspace whose validation definitions are restored from
  the bound base revision.

Signals such as newly focused/skipped tests or removing tests without a
replacement are considered in the strict decision. The selected mode is a
trusted Action input, not repository or model data. The Controller records the
integrity audit and disposition in `result-json` and the step summary before any
GitHub mutation.

### 4. Controller and commit authority

Only the controller may call GitHub or turn model output into a repository
mutation.

- Forks and `pull_request_target` are review-only. A fork workflow must check
  out only the immutable base SHA and use `persist-credentials: false`.
- Before a write, the controller revalidates actor authorization, repository
  origin, full SHA, branch or issue/PR identity, and the actual changed files.
- Validation commands are fixed workflow argv arrays, never model-provided
  shell text. Every write requires `run-tests=true`, a non-empty command list,
  and success from every command; `run-tests=false` cannot waive validation.
  They run only after all trusted-write gates in a disposable, credential-free
  container. A validation failure or timeout prevents the commit, push, branch
  update or pull request creation. The validation copy excludes the root `.git`
  and `node_modules` directories because those generated paths are also
  excluded from the publishable change set.
- Entity-free automation and issue-backed `task` writes never push directly to
  the repository default branch. They bind the default-branch head as an
  immutable base, then create a controller-owned task branch and pull request.
  A task attached to an existing pull request follows the separately authorized
  same-repository PR-head fix path, which rejects a head ref equal to the
  repository default branch. Merging a task PR into the default branch remains
  a separate repository action.
- The controller owns the `summary`, `diagnosis`, `write` and `task` sticky markers.
  Read-only progress reuses the applicable final-result marker and updates it in
  place. Write-task lifecycle publication is deferred until final validation
  succeeds. If actual-change inspection confirms that `task --write` changed no
  repository file, the Controller may publish the final answer without a commit,
  ref update, pull request, or release mutation.
  `progress-comment=false` disables eligible lifecycle updates without weakening
  any authorization or validation gate.
- Progress publication is secondary UX and cannot mask the primary result.
  Terminal outputs, including the versioned `result-json`, are produced for
  success, neutral and failure outcomes. Stable failure codes distinguish DSH
  timeout/output errors, validation failure/timeout, policy denial and the
  controller phase that failed.
- Runtime creation and installation, extension installation, each Agent turn,
  and Controller validation have separate bounded budgets. Each receives the
  smaller of its cap and the remaining overall execution deadline, so setup
  cannot exhaust or extend that deadline. Cleanup and cancellation
  finalization have separate fixed short best-effort grace periods after an
  outcome or deadline; they are bounded but may slightly extend wall-clock
  duration beyond the configured execution deadline.

### Workflow token permissions

Use the smallest token permission set that supports the selected entry point.
The supplied templates use the following sets:

| Scenario                                        | Permissions                                                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Automatic or fork PR review                     | `contents: read`, `pull-requests: write`                                                                                                      |
| CI diagnosis                                    | `actions: read`, `checks: read`, `contents: read`, `issues: write`, `pull-requests: write`                                                    |
| Interactive commands with fix/implement enabled | `actions: read`, `checks: read`, `contents: write`, `issues: write`, `pull-requests: write`                                                   |
| CI auto-fix                                     | Same as the preceding row                                                                                                                     |
| Core E2E gate/read/write/cancellation           | Split per job: read-only gate, `contents`/PR write only for the write golden path, and Issue write only for the isolated cancellation fixture |
| v0.5.1 release canary                           | Secretless `contents: read` gate; the `core-e2e` smoke job also has only `contents: read`                                                     |

Progress comments use the same issue or pull-request comment permission as the
final result and require no additional token scope. Write-task comment APIs are
not called before successful final validation.

The release canary requires repository variable `DSH_RELEASE_CANARY_SHA` to be
the lowercase full 40-character commit SHA referenced by the formal v0.5.1 tag
and its non-draft, non-prerelease GitHub Release. Before any environment secret
is available, a secretless gate requires `refs/heads/main`, requires the
run/workflow SHA to equal the live default-branch SHA, and fails if `main` is no
longer the default branch. The smoke job uses the protected, main-only
`core-e2e` environment, validates that all release identities agree, checks out
the immutable release commit, and runs one `strict` read-only task using
`DEEPSEEK_API_KEY`; it receives no Issue/PR write or repository mutation scope.

The permanent Core E2E workflow is trusted release infrastructure and must be
bootstrapped onto the default branch before it qualifies a candidate. Its gate
has no secret access and requires the dispatch ref, workflow/dispatch SHA, and
live default-branch SHA to agree before it binds the explicit full candidate
SHA, `DSH_E2E_CANDIDATE_SHA`, a write-capable actor, and an open non-draft
same-repository PR targeting the default branch. The three jobs that can access
`DEEPSEEK_API_KEY` all use the `core-e2e` environment; repository operators must
configure that environment with a default-branch-only deployment policy.
Harness/fixture code is checked out at the immutable trusted SHA and candidate
code only at the bound candidate SHA, always without persisted checkout
credentials. Cancellation uses a dedicated temporary Issue and one locked bot
comment ID, then strictly deletes the comment and closes the Issue instead of
touching the candidate PR's sticky comment.

## Known boundary

Network permission is enforced at the DSH worker boundary, not as a
per-destination firewall. `network=false` is not a claim that the worker has no
network path. When no approved extension requests network, the worker uses an
internal controller-owned Docker network, which blocks ordinary external
egress. The Controller inspects that network's IPv4 gateway and maps
`host.docker.internal` to the inspected address for the local LLM credential
proxy. That host-gateway route is required for model traffic and is not a
port-level allowlist; runner-level firewall policy remains the boundary for
other host services. Failure to obtain a valid inspected gateway fails closed.
Package acquisition separately uses bridge networking even if the package's
later runtime declaration is `network=false`. When an approved MCP server,
Bundle or plugin requests network, worker networking is enabled for the
co-hosted DSH process and every trusted package in that process can technically
use that egress. The real API key and GitHub token remain outside the worker,
but destination-level allowlists are not provided. Avoid combining extensions
with different confidentiality assumptions, use a dedicated self-hosted
runner/network policy when source confidentiality requires hard egress control,
and pin `container-image` by digest.

The stock DSH `read-only` policy is not a read-containment boundary. This action
does not rely on it for fork isolation. If `isolation=none` is selected for an
eligible trusted-read operation, no operating-system process boundary exists;
the configured `dsh-executable` then runs as trusted host code. Use that mode
only on a dedicated trusted runner. Untrusted and trusted-write profiles still
require Docker.

The credential-free validation container uses Docker bridge networking for
dependency installation. That is unrestricted destination egress from the
container, not merely registry access, and validation executes untrusted
repository code. Use immutable lockfiles, pinned registries/images and a runner
egress policy when source confidentiality or reproducibility requires it.

Each validation command receives a random container name and `--rm`. On a
launch error or timeout the controller also attempts `docker rm --force`, and
the temporary validation workspace is removed in a `finally` block. Cleanup is
best effort: a hard runner termination or unavailable Docker daemon can leave a
named `dsh-action-validation-*` or `dsh-action-tool-*` container for the runner
operator to reap. Cleanup failure never grants write authority and must not hide
the primary task result.

The v1 sticky marker identifies an operation result kind, not a workflow run or
head SHA. The supplied workflows therefore use a per-PR, per-Issue or per-run
`concurrency` group. Custom workflows should preserve that serialization; without
it, a slow or hard-cancelled older run can overwrite a newer run's sticky state.
A marker-level freshness guard remains deferred in v0.5.1. On `SIGTERM` or
`SIGINT`, the Controller aborts the active worker and immediately starts a
bounded, best-effort terminal comment update while run-scoped cleanup proceeds.
A later authoritative non-cancellation failure can correct a provisional
cancellation, and terminal-state guards prevent queued progress work from
reverting the result to “In progress.” `SIGKILL`, runner/host loss, a process
crash, or a network/GitHub API outage can prevent all finalization code from
running; an “In progress” comment may therefore remain stale. The Actions run
conclusion is authoritative.

v0.5.1 retains the binding of its generated Profile and positive native-tool
policy to the exact DSH version whose complete tool surface was audited. It
accepts only the exact `@deepseek-ai/dsh@0.1.1-rc.2` package family; another
tag, range or exact version is
rejected until a matching profile is reviewed and shipped. The Action's DSH
dependency graph is installed from the committed lockfile in an ephemeral
container with no controller credentials. Production users should mirror the
packages in a trusted registry or prebuild and pin a reviewed container image
when supply-chain reproducibility is required. Third-party packages configured
later by a workflow remain a separate, explicitly trusted supply-chain decision.
