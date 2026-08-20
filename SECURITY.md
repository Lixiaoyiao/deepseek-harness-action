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
- `allow-write` defaults to `false`. A write additionally requires a
  same-repository target, an eligible event, an unchanged bound identity and an
  explicitly pinned validation image.
- GitHub workflow token permissions are a separate gate. They grant the
  controller API access but cannot bypass actor, origin, event or policy checks.

The controller creates a lifecycle comment only after the operation is allowed
and a pull request or issue target has been resolved. A denied request therefore
cannot use progress tracking to generate bot comment spam.

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
`task-access`, `allow-write`, `allowed-tools`, `tool-config`, `run-tests` and
`test-commands`: keep them literal or derive them only from trusted workflow
configuration. In particular, do not interpolate pull request titles/bodies,
comments, CI output, repository files or a serialized event into those inputs.
Let the action fetch event and repository context itself; it will place those
bytes in the bounded untrusted-data channel.

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

| Profile         | Repository access                                       | Worker tools                                                            | Repository code execution                                                                    | GitHub authority |
| --------------- | ------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `untrusted`     | None                                                    | No filesystem, shell, web, skills, repository instructions or subagents | Disabled                                                                                     | None             |
| `trusted-read`  | Immutable read-only `.git`-less copy when Docker-backed | Read/search only                                                        | Disabled                                                                                     | None             |
| `trusted-write` | Read/write `.git`-less copy                             | Read/search/edit only; shell and web remain disabled                    | Disabled in DSH; fixed-argv tools and final validation run in separate controller containers | None             |

Fork and other untrusted runs require Docker isolation. Trusted writes also
require Docker and a full `name@sha256:<64 lowercase hex>` image reference. The
worker never receives a GitHub client, checkout credential, real GitHub token or
real DeepSeek API key.

DSH receives an ephemeral proxy token. A controller-side proxy injects the real
DeepSeek key only while forwarding the fixed chat-completions endpoint. The
actual backend, workspace access and known limitations are recorded in the
structured isolation report rather than inferred from the requested profile.

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
  container. Command output remains untrusted even though the argv is trusted.

### 4. Controller and commit authority

Only the controller may call GitHub or turn model output into a repository
mutation.

- Forks and `pull_request_target` are review-only. A fork workflow must check
  out only the immutable base SHA and use `persist-credentials: false`.
- Before a write, the controller revalidates actor authorization, repository
  origin, full SHA, branch or issue/PR identity, and the actual changed files.
- Validation commands are fixed workflow argv arrays, never model-provided
  shell text. They run only after all trusted-write gates in a disposable,
  credential-free container. A validation failure or timeout prevents the
  branch update or pull request creation.
- Entity-free automation and issue-backed `task` writes never push directly to
  the repository default branch. They bind the default-branch head as an
  immutable base, then create a controller-owned task branch and pull request.
  A task attached to an existing pull request follows the separately authorized
  same-repository PR-head fix path, which rejects a head ref equal to the
  repository default branch. Merging a task PR into the default branch remains
  a separate repository action.
- The controller owns the `summary`, `diagnosis`, `write` and `task` sticky markers.
  Progress reuses the applicable final-result marker and updates it in place;
  `progress-comment=false` disables lifecycle updates without weakening any
  authorization or validation gate.
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
final result and require no additional token scope.

## Known boundary

The current Docker backend uses bridge networking so the worker can reach the
local credential proxy. The real API key and GitHub token remain outside the
worker, but destination-level worker egress is not yet enforced. Use a dedicated
self-hosted runner/network policy when source confidentiality requires hard
egress control, and pin `container-image` by digest.

The stock DSH `read-only` policy is not a read-containment boundary. This action
does not rely on it for fork isolation. If `isolation=none` is selected for an
eligible trusted-read operation, no operating-system process boundary exists;
use that mode only on a dedicated trusted runner. Untrusted and trusted-write
profiles still require Docker.

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
A marker-level freshness guard is deferred beyond this v0.3.0 release.

v0.3 binds its policy patches to the exact DSH version whose complete native
tool surface was audited. It currently accepts only `@deepseek-ai/dsh`
`0.1.0-rc.6`; another tag, range or exact version is rejected until a matching
profile is reviewed and shipped. DSH is installed inside an ephemeral container
that has no repository mount and no controller credentials. Its audited native
dependency requires install scripts on Linux, and its transitive npm dependency
graph is currently resolved at run time. Production users should mirror the
package in a trusted registry or prebuild and pin a reviewed container image
when supply-chain reproducibility is required.
