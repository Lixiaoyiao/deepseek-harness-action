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
every final Controller validation command succeeds. A failed gate therefore
produces no GitHub comment, commit, ref update or pull request; the bounded
failure remains in Action outputs and the step summary.

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
`task-access`, `allow-write`, `allowed-tools`, `tool-config`, `mcp-config`,
`plugin-config`, `allow-plugin-install`, `run-tests`, `test-commands`,
`container-image`, `base-url`, `isolation`, and `dsh-executable`: keep them
literal or derive them only from trusted workflow configuration. The latter
four select executable worker code, the destination that receives proxied
DeepSeek requests, or whether an operating-system boundary exists. In
particular, do not interpolate pull request titles/bodies, comments, CI output,
repository files, a serialized event or model output into those inputs. Let the
action fetch event and repository context itself; it will place those bytes in
the bounded untrusted-data channel. A prompt cannot authorize or install a new
MCP server, Bundle or plugin.

### 2. Input and data trust

Repository files, diffs, CI logs, README, AGENTS.md, CLAUDE.md, issues, pull
requests, comments, previous model prose and tool output are untrusted data.
They are placed inside bounded untrusted context and never interpreted as
controller instructions.

- Agent output is also untrusted. The controller accepts only one complete JSON
  value and rejects unknown fields, invalid paths, unsafe ranges, oversized
  collections and controller-owned tracking markers.
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

| Profile         | Repository access                                       | Worker tools                                                                                   | Repository code execution                                                                                     | GitHub authority |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `untrusted`     | None                                                    | No filesystem, MCP, plugin, shell, web, skills, repository instructions or subagents           | Disabled                                                                                                      | None             |
| `trusted-read`  | Immutable read-only `.git`-less copy when Docker-backed | Read/search plus explicitly configured read/network extension tools permitted by Controller    | Disabled unless a trusted workflow explicitly enables audited extension startup                               | None             |
| `trusted-write` | Read/write `.git`-less copy                             | Read/search/edit plus explicitly configured extension tools; unrestricted shell remains denied | Disabled in DSH except explicitly trusted extensions; fixed-argv tools and validation use separate containers | None             |

Fork and other untrusted runs require Docker isolation. Trusted writes also
require Docker and a full `name@sha256:<64 lowercase hex>` image reference. The
worker never receives a GitHub client, checkout credential, real GitHub token or
real DeepSeek API key. Every supplied image value is validated as one Docker/OCI
reference before it is appended after Docker's options; leading-option values,
whitespace, and other argument-breaking forms are rejected even on read-only
paths where a mutable tag remains compatible. This prevents Docker option
injection but does not make an operator-selected image trustworthy.

DSH receives an ephemeral proxy token. A controller-side proxy injects the real
DeepSeek key only while forwarding the fixed chat-completions endpoint. The
actual backend, workspace access and known limitations are recorded in the
structured isolation report rather than inferred from the requested profile.
Because `base-url` chooses the upstream that receives those requests and the
real key, it is a trusted credential-routing input, not untrusted request data.

#### Maintainer-defined controller tools

v0.3 command tools are fixed-argv controller capabilities. A maintainer defines
the executable and every argument in versioned `tool-config`, then separately
allowlists the resulting `command.<name>` ID. The model may select an advertised
ID and give a reason, but the v0.3 command provider rejects model-supplied
arguments and never gives DSH a shell. Direct shell interpreters are rejected at
configuration parsing as an additional guard; the primary boundary is that all
argv bytes are trusted workflow configuration, not model output.

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
  workflow interpolates it into command-tool or validation argv. Command output
  remains untrusted even though the argv is trusted.

#### Controlled DSH native, MCP, Bundle, and plugin tools

v0.4 uses the official DSH extension mechanisms. It pins
`@deepseek-ai/dsh@0.1.0-rc.8` and
`@deepseek-ai/dsh-mcp-client@0.1.0-rc.8`, generates a controlled Profile, and
loads the approved Bundle and Cordis plugin rows from that Profile. It does not
read extension authorization from the repository or model response and does not
run model-generated `npm`, Git, or plugin-install commands. The generated Cordis
patch serializes workflow values as JSON data so a configured string cannot add
a patch row or become a YAML `!!js` expression; an approved Bundle's own patch
remains trusted package code.

The Action starts this generated Profile through the official
`@deepseek-ai/dsh-app-boot@0.1.0-rc.8` public API. It does not use the general
CLI path that discovers workspace or `$DSH_HOME` `.env` files, nor does it
enable dynamic user patch discovery, watch or hot reload. The only Profile and
Cordis patch inputs come from the Controller-validated run configuration.

The effective runtime tool set is a positive intersection of the strict
configuration manifests, `allowed-tools`, and Controller policy. Model-routed
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
  The bounded `tool-receipts` output always includes separate `controller` and
  `dsh` arrays, a `truncated` boolean, and `droppedCount`. Neither a receipt,
  model explanation nor tool success is authorization. Persistent invocation
  state and receipts are telemetry, not tamper-proof security logs;
  already-approved trusted extension code shares the worker process/filesystem
  and can influence them.

ToolRuntime controls calls routed through DSH's model tool dispatcher. It is not
a sandbox for already-approved executable code. A stdio server, Bundle, or
plugin can act during startup, in background work, or through direct process
I/O without waiting for a model-routed tool call. The Docker mount/network
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
  place. Write-task publication is deferred until final validation succeeds.
  `progress-comment=false` disables eligible lifecycle updates without weakening
  any authorization or validation gate.
- Progress publication is secondary UX and cannot mask the primary result.
  Terminal outputs, including the versioned `result-json`, are produced for
  success, neutral and failure outcomes. Stable failure codes distinguish DSH
  timeout/output errors, validation failure/timeout, policy denial and the
  controller phase that failed.

### Workflow token permissions

Use the smallest token permission set that supports the selected entry point.
The supplied templates use the following sets:

| Scenario                                        | Permissions                                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Automatic or fork PR review                     | `contents: read`, `pull-requests: write`                                                    |
| CI diagnosis                                    | `actions: read`, `checks: read`, `contents: read`, `issues: write`, `pull-requests: write`  |
| Interactive commands with fix/implement enabled | `actions: read`, `checks: read`, `contents: write`, `issues: write`, `pull-requests: write` |
| CI auto-fix                                     | Same as the preceding row                                                                   |

Progress comments use the same issue or pull-request comment permission as the
final result and require no additional token scope. Write-task comment APIs are
not called before successful final validation.

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
A marker-level freshness guard remains deferred beyond v0.4.0.

v0.4 binds its generated Profile and positive native-tool policy to the exact
DSH version whose complete tool surface was audited. It accepts only
`@deepseek-ai/dsh@0.1.0-rc.8` and the matching official
`@deepseek-ai/dsh-mcp-client@0.1.0-rc.8`; another tag, range or exact version is
rejected until a matching profile is reviewed and shipped. The Action's DSH
dependency graph is installed from the committed lockfile in an ephemeral
container with no controller credentials. Production users should mirror the
packages in a trusted registry or prebuild and pin a reviewed container image
when supply-chain reproducibility is required. Third-party packages configured
later by a workflow remain a separate, explicitly trusted supply-chain decision.
