# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[中文](README.zh-CN.md)

Run DeepSeek Harness directly from GitHub pull requests, issues, and failed CI jobs.

```text
GitHub PR / Issue / CI  →  DeepSeek Harness  →  Review / Diagnose / Fix / Issue → PR
```

It belongs to the same category of GitHub integration as [Claude Code Action](https://github.com/anthropics/claude-code-action): GitHub events start a coding agent, and the action writes reviews, diagnoses, or code changes back to the repository. This project uses DeepSeek Harness.

Pull requests can receive automatic inline reviews. Failed CI runs can receive a diagnosis. Once you explicitly enable write access, `@dsh` can also fix code or turn an issue into a pull request.

This is a community project. It is not an official DeepSeek or GitHub product.

Maintained by [@Lixiaoyiao](https://github.com/Lixiaoyiao).

## Live runs

These are public runs from this repository. You can inspect the comments and Actions logs directly.

| Scenario                                                | Run                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR review, including a rerun without duplicate comments | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| Diagnosis based on failed checks and logs               | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| Fix and validation in trusted write mode                | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| Issue implementation followed by a pull request         | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## Quick start

Add `DEEPSEEK_API_KEY` under **Settings → Secrets and variables → Actions** in your repository.

Then create `.github/workflows/dsh-review.yml`:

```yaml
name: DSH review

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
          fetch-depth: 1
      - uses: Lixiaoyiao/deepseek-harness-action@8eaaa7777a4756c5e519e791b6613b302fc0a92e # v0.3.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

Open a non-draft pull request. The action reads the diff and repository context, then posts a review summary. When it finds a concrete problem, it also comments on the relevant line.

See [`examples/fork-review.yml`](examples/fork-review.yml) for the complete template. This workflow uses `pull_request_target`, checks out only the trusted base SHA, and never runs code from the fork.

> v0.4.0 is released. The compatibility Quick start above intentionally remains pinned to the immutable v0.3.0 runtime commit. To use controlled MCP or Plugin/Profile extensions, start from [`examples/controlled-extensions.yml`](examples/controlled-extensions.yml) and replace its release tag with the immutable commit SHA from the v0.4.0 release before production use. See [`CHANGELOG.md`](CHANGELOG.md) for the release notes.

## What it does

| Entry point                                                | Result                                                               |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| PR `opened` / `synchronize` / `ready_for_review`           | Automatic review with a summary and inline comments                  |
| `@dsh task --read <question or task>`                      | General Q&A, code reading, and repository analysis                   |
| `@dsh task --write <coding task>`                          | Change, validate, and deliver code after every write gate passes     |
| An explicit non-empty `prompt` in a dispatch/schedule flow | Run a general automation task                                        |
| `@dsh review`                                              | Review the current pull request again                                |
| `@dsh diagnose`                                            | Read failed checks and logs, then identify the cause                 |
| `@dsh fix`                                                 | Change code and run validation in trusted write mode                 |
| `@dsh implement` on an issue                               | Understand the issue, change code, validate, and open a pull request |

The command must be on the first line of the comment. Ready-to-copy workflows are included:

- [`examples/commands.yml`](examples/commands.yml) for `@dsh` commands, fixes, and Issue → PR
- [`examples/ci-diagnose.yml`](examples/ci-diagnose.yml) for failed CI diagnosis
- [`examples/ci-auto-fix.yml`](examples/ci-auto-fix.yml) for trusted CI auto-fix
- [`examples/task-automation.yml`](examples/task-automation.yml) for v0.3 explicit-prompt automation
- [`examples/controlled-extensions.yml`](examples/controlled-extensions.yml) for v0.4 controlled MCP and DSH Bundle/Profile configuration

Writing `@dsh fix` or `@dsh implement` does not grant write access by itself. The workflow must also set `allow-write: "true"`, keep `run-tests: "true"`, and provide at least one `test-commands` argv array. See [`action.yml`](action.yml) for all inputs.

## General tasks and explicit automation

`task` is not limited to the review, diagnose, fix, or implement templates. It can answer natural-language questions, inspect a repository, or carry out a coding task:

```text
@dsh task --read Explain why this pull request needs a two-phase commit
@dsh task --write Add empty-input coverage to the parser and run validation
```

The command must start on the first line of the comment; later lines may continue the instructions. `--read` is the default for `task`. `--write` requests a capability but does not authorize it. The workflow still needs `allow-write: "true"`, `run-tests: "true"`, a non-empty validation command list, a same-repository context that is not `pull_request_target`, write/maintain/admin permission for every originating actor, and `workspace.edit` in the effective tool allowlist. A fork pull request can never be upgraded to write mode this way.

On `workflow_dispatch`, `repository_dispatch`, or `schedule` automation events, `command: auto` plus a non-empty `prompt` routes to a general `task`. You may instead set `command: task`, in which case `prompt` is required. `task-access` defaults to `read`:

```yaml
with:
  command: auto
  prompt: "Check the dependency boundary, add tests if needed, and explain the result"
  task-access: read
```

`prompt` is trusted control-plane configuration. Populate it only from a maintainer-authored workflow or a trusted dispatch input; do not silently promote issue bodies, pull-request content, logs, or other untrusted data into `prompt`. The same provenance rule applies to capability inputs, especially `container-image`, `base-url`, `isolation`, and `dsh-executable`: they choose worker code, credential routing, or the process boundary. See [`examples/task-automation.yml`](examples/task-automation.yml) for a complete read/write dispatch template pinned to the immutable v0.3.0 compatibility runtime.

A read-only automation task without an issue or pull-request entity returns its answer through the step summary and outputs. A write task with no entity, or one targeting an issue, creates a dedicated `dsh/task-*` branch and pull request; the controller never pushes general automation changes directly to the default branch. An authorized task on a same-repository pull request can affect only the target branch that the controller bound and revalidated.

## Multi-turn edit, validation, and repair loop

The controller loop introduced in v0.3 is unchanged in v0.4. It belongs to the Action controller, not to a shell inside DSH. Every iteration is a fresh DSH turn constrained by the same task anchor and capability policy:

```text
DSH turn
  ├─ needs_tool → controller runs one allowed tool → bounded/redacted untrusted result → next turn
  ├─ final → controller validation fails → stdout/stderr as untrusted feedback → next edit turn
  ├─ final → validation passes → controller publishes, commits, or opens a pull request
  └─ blocked → stop safely with a neutral result
```

The built-in Agent toolset has no unrestricted shell, and DSH holds neither GitHub nor real DeepSeek credentials. An explicitly allowed third-party extension is trusted worker code and can have the process-level side effects described below. The controller owns fixed-argv tool execution, validation, actual-change inspection, and the final GitHub mutation. `max-turns` (default 3) bounds all DSH turns consumed by tool requests and validation repairs; `timeout-minutes` is the deadline for the complete controller loop. If the same workspace revision produces the same validation failure twice, no-progress detection stops the loop. Turn/tool/validation-retry counts and bounded tool receipts are recorded under `result-json.loop`.

## Maintainer-defined safe command tools

The model cannot assemble arbitrary shell commands. A maintainer defines the complete fixed argv for each command in a versioned `tool-config` manifest, then exposes its ID separately through `allowed-tools`:

```yaml
with:
  allowed-tools: '["workspace.read","workspace.search","workspace.edit","command.bundle-syntax"]'
  tool-config: |
    {
      "schemaVersion": 1,
      "commands": [{
        "name": "bundle-syntax",
        "description": "Check the bundled JavaScript syntax without installing dependencies",
        "argv": ["node", "--check", "dist/index.js"],
        "timeoutMinutes": 10,
        "maxOutputBytes": 131072,
        "maxCalls": 2,
        "network": "none",
        "workspaceAccess": "read"
      }]
    }
```

Replace the sample argv with a deterministic command for your repository. A command tool accepts no model arguments. Common direct shell executables are rejected as an additional guard; undefined tools, calls beyond `maxCalls`, and network/workspace access that exceeds the current policy also fail. The primary boundary is maintainer-fixed complete argv, no model-added arguments, and a credential-isolated container pinned by full digest. Controller credentials are rejected if a workflow interpolates them into command-tool or validation argv. stdout/stderr is bounded and redacted, then returned only as untrusted feedback. A manifest entry alone grants nothing: its ID must also appear in `allowed-tools`, and the current security policy must allow the required execute/write/network capability.

## Official MCP, Bundle, and Profile integration

v0.4 upgrades the audited runtime from `@deepseek-ai/dsh@0.1.0-rc.6` to the exact `0.1.0-rc.8` release and uses the official `@deepseek-ai/dsh-mcp-client@0.1.0-rc.8`. It does not introduce a parallel MCP client or plugin loader. The controller validates trusted workflow configuration, generates a controlled DSH `github-action` Profile, lists the approved Bundles in the Profile manifest, adds approved plugin and MCP rows to its Cordis patch, and starts that Profile through the official `@deepseek-ai/dsh-app-boot@0.1.0-rc.8` public API. This controlled boot skips workspace and `$DSH_HOME` `.env` discovery and the general CLI's dynamic user-patch watch/hot-reload path. All shipped DSH dependencies are exact lockfile pins; `latest`, semver ranges, floating Git refs, and legacy MCP SSE are rejected.

The official MCP client supports the transports exposed here:

- `stdio`: the command must be a bare executable name or absolute container path outside `/workspace`. Shells, interpreters, downloaders, package managers, Git, and dynamic runners such as `npx` are rejected. `cwd` is repository-relative. Starting the approved executable grants full trusted worker-code execution inside the container; it is not merely a tool schema.
- `streamable-http`: the URL must use HTTP(S), cannot contain embedded credentials or a fragment, and the server and each exposed tool must explicitly request `network`. Structured audit output and its public profile digest expose only the URL origin; pathname, query, and headers are withheld. A separate Controller-only digest binds the complete validated configuration for runtime reuse.

`mcp-config` is a versioned, strict server-and-tool allowlist. Defining a server is not enough: every exposed tool must also appear in `allowed-tools` as `mcp.<server-id>.<tool-id>`. The controller derives the official DSH model-facing `mcp__...` name itself, so a prompt cannot add servers, rename tools, or expand their permissions. For example:

```yaml
with:
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

The sample executable is intentionally image-provided: build and audit it into the digest-pinned `container-image`; do not download a server from the model turn. Any effective MCP, Bundle, or plugin tool requires `isolation: docker`; the local `dsh-executable` compatibility path cannot load extensions. [`examples/controlled-extensions.yml`](examples/controlled-extensions.yml) also shows the `streamable-http` shape and the controlled Profile/Bundle path.

`plugin-config` uses the official Bundle/Profile mechanism. Each Bundle or plugin needs an explicit package name, an exact semver or `git+https://github.com/...git#<40-character-commit>` source, declared tools, and declared network behavior. Package tools use the action ID `plugin.<extension-id>.<tool-id>` and a namespaced DSH runtime name beginning with `plugin__<extension-id>__`. Third-party package installation is disabled until a trusted workflow sets `allow-plugin-install: "true"`.

> A third-party Bundle or plugin executes full trusted worker code during DSH startup. NPM lifecycle scripts are disabled during acquisition, but tool-call allowlists do not sandbox package initialization, background work, or direct process I/O. Review the package and its transitive dependency graph, pin it immutably, use a dedicated runner or image when appropriate, and grant network/workspace access as if you were authorizing code execution on that worker. `allow-plugin-install` is never inferred from a prompt, PR, Issue, repository file, or model output.

Before installing an effective third-party package, the Controller snapshots the complete top-level runtime package inventory. It verifies the inventory again after installation and aborts if any pre-existing package was removed or its version changed, then separately verifies the configured extension's package identity and exact version or commit.

All tool families are compiled from the same controller policy and fail closed:

| Limit             | Enforcement                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `read`            | Requires repository-read capability; unavailable to the untrusted fork profile                                       |
| `workspace-write` | Requires trusted-write, `allow-write: "true"`, same-repository origin, actor checks, and final controller validation |
| `network`         | Must be declared by the owner and each tool and allowed by the effective controller policy                           |
| `timeoutMs`       | Bounds one invocation; same-process plugin cancellation is cooperative, while the overall deadline hard-stops DSH    |
| `maxOutputBytes`  | Bounds serialized tool output before it is returned as untrusted model feedback                                      |
| `maxCalls`        | Bounds a tool and its owning server/package across the controller's multi-turn loop                                  |

The Action-owned policy adapter applies this positive runtime allowlist to model-routed DSH native, official MCP, and plugin tool invocations. The existing controller `ToolRouter` continues to execute fixed-argv `command.*` tools. Both planes use the same controller-resolved capabilities, limits, audit identity, and bounded receipts. This controls what the model can route; it cannot contain an actively malicious already-approved stdio server, Bundle, or plugin that performs startup, background, or direct process I/O. The Agent itself gets no unrestricted shell, `GITHUB_TOKEN`, real DeepSeek key, or commit/push/PR authority.

Before restriction, every visible runtime tool must belong to the Controller-audited inventory and every selected tool must be present; a configured but unselected tool is not required to register. After restriction, the model-visible inventory must equal the selected allowlist exactly. Unknown tools, missing selected tools, and agent-scoped tools that survive outside the allowlist all fail closed, while the monotonic ToolRuntime guard independently denies every call without an effective Controller rule.

Network and workspace mounts apply to the whole DSH process, not one tool. Every extension tool must therefore declare `read`, because its process shares the Agent's repository view. All effective MCP servers/packages in a turn must declare the same network and workspace-write mode. A trusted-read worker accepts only read-only owners; every owner co-hosted in a trusted-write worker must explicitly declare `workspace-write`. Mixed modes are rejected instead of being presented as per-tool isolation. `network: false` means the internal Docker network blocks ordinary external egress, not that the worker has no network path: DSH still reaches the controller-side LLM proxy by mapping `host.docker.internal` to the network's inspected IPv4 gateway. That host-gateway path is not a port allowlist, runner firewall policy governs access to other host services, and package acquisition separately uses bridge networking.

See [`docs/extension-contracts.md`](docs/extension-contracts.md) for the exact Profile composition, identifier mapping, process-level compatibility rules, receipt shape, and deferred session boundary.

### Compatibility

If `mcp-config` and `plugin-config` keep their empty defaults and `allow-plugin-install` remains `false`, v0.4 follows the v0.3 review, diagnose, fix, implement, auto, task, multi-turn, sticky-comment, and GitHub-write paths. Existing input names, scalar outputs, and the schema-v1 `result-json` envelope remain compatible. The two intentional security hardenings are mandatory validation for every write and deferring write-task comments until that validation succeeds. v0.4 does not add session resume, label or assignee triggers, branch templates, or Agent Teams.

## Progress and structured outputs

When an authorized read-only operation resolves to a pull request or issue, the controller updates one sticky comment while it prepares bounded context, runs DSH, and publishes the result. A write request deliberately publishes no lifecycle or status comment before every final Controller validation command succeeds; after the validated mutation, its final result may reuse the same controller-owned v1 marker. Progress therefore does not create a second status comment:

| Operation           | Reused sticky marker |
| ------------------- | -------------------- |
| `task`              | `task`               |
| `review`            | `summary`            |
| `diagnose`          | `diagnosis`          |
| `fix` / `implement` | `write`              |

On success, the detailed review, diagnosis, or validated write result replaces that same comment. A read-only failure can update it with a stable error code, phase, redacted bounded message, and next step. A write request that is blocked, produces no change, or fails before/during final validation emits only Action outputs and a step summary, with no GitHub API write. Only markers authored by the expected numeric bot ID are updated; user-forged markers are ignored. Eligible lifecycle comment updates are best effort, so a temporary GitHub comments API failure does not hide the real agent, validation, or write outcome.

`progress-comment` defaults to `true`. Disable intermediate lifecycle updates with:

```yaml
with:
  progress-comment: "false"
```

This disables lifecycle updates only. It does not disable normal inline review comments, review summaries, CI diagnoses, or final fix status publication.

Keep the job-level `timeout-minutes` a few minutes above the action input of the same name. This gives the internal DSH watchdog time to stop the worker and finalize failure outputs, the step summary, and any eligible read-only sticky comment.

The action sets `result-json` on success, neutral, and failure paths. This is a `schemaVersion: 1` JSON envelope containing the applicable `status`, operation, summary, timing, policy/capabilities, effective extension audit, bounded tool receipts, actual isolation report, publication statistics, controller validation, write result, sticky comment ID, and error. `status` is one of `success`, `neutral`, `failed`, `timed_out`, `validation_failed`, or `denied`. `validation_failed` covers both invalid DSH structured output and controller validation failure; `error.code` distinguishes them. A failure object carries stable `code`, `phase`, `title`, `message`, `guidance`, and `retryable` fields.

All scalar outputs are:

| Output                     | Meaning                                                                          |
| -------------------------- | -------------------------------------------------------------------------------- |
| `conclusion`               | `success`, `neutral`, or `failure`                                               |
| `operation`                | `task`, `review`, `diagnose`, `fix`, `implement`, or `none`                      |
| `summary`                  | Validated summary for any operation, or a safe failure summary                   |
| `review-summary`           | Backward-compatible alias of `summary`                                           |
| `findings-count`           | Selected review findings, or validated agent findings for other operations       |
| `branch-name`              | Created DSH branch, empty when not applicable                                    |
| `pull-request-url`         | Created pull request URL, empty when not applicable                              |
| `commit-sha`               | Commit created by a successful fix, empty when not applicable                    |
| `trust`                    | `untrusted`, `trusted-read`, `trusted-write`, or `none` before policy resolution |
| `duration-ms`              | Total controller duration in milliseconds                                        |
| `comment-id`               | Sticky progress/result comment ID when available                                 |
| `error-code`               | Stable failure code; empty on success or neutral completion                      |
| `error-message`            | Redacted and bounded failure message                                             |
| `extension-profile-digest` | SHA-256 digest of the redacted effective Profile audit; empty when unavailable   |
| `tool-receipts`            | JSON object with bounded `controller`/`dsh` arrays plus truncation metadata      |
| `result-json`              | The versioned JSON envelope described above                                      |

The v0.1.0 outputs `conclusion`, `operation`, `review-summary`, `findings-count`, `branch-name`, and `pull-request-url` remain available, so existing workflows do not need to be rewritten. Model-reported `verification` and controller-executed validation are different data; `result-json` exposes the latter separately under `validation`.

A failed action step still writes its outputs first. Use `always()` in a later step and pass the value through an environment variable instead of interpolating model-derived text into a script:

```yaml
# First give the DeepSeek Harness step id: dsh
- name: Inspect DSH result
  if: ${{ always() && steps.dsh.outputs['result-json'] != '' }}
  env:
    DSH_RESULT_JSON: ${{ steps.dsh.outputs['result-json'] }}
  run: printf '%s\n' "$DSH_RESULT_JSON" | jq .
```

Summaries, paths, and other model-derived strings inside `result-json` remain untrusted data. The envelope, invocation-count state, and receipts are telemetry only, not authorization or tamper-proof security logs. Approved extension code shares the worker process/filesystem and can influence that telemetry, so do not splice output strings directly into shell commands or treat them as independent proof.

## Write mode

`allow-write` defaults to `false`. Every code, Git ref, pull-request, and write-task comment mutation requires `run-tests: "true"`, at least one `test-commands` argv array, and successful completion of every validation command. `run-tests: "false"` denies the mutation; it is not a waiver. This is an intentional v0.4 security hardening from earlier behavior. Before that gate succeeds, a write request produces no GitHub comment, commit, ref update, or pull request. Mutations remain limited to trusted actors working in the same repository, and fork pull requests are always review-only. Validation commands are argv arrays and are not expanded by a shell:

```yaml
with:
  allow-write: "true"
  run-tests: "true"
  test-commands: '[["npm","ci","--ignore-scripts"],["npm","test"],["npm","run","typecheck"]]'
  container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
```

Write mode and any effective extension require a complete Docker image digest. Every image value, including tag-compatible read-only paths, is validated as one Docker/OCI reference and cannot begin with an option or contain argument-breaking whitespace. The image itself is trusted worker code. Docker must be available on the runner.

## Security

The security model has four separate layers so that a trusted actor is never confused with trusted repository content:

1. **Actor / control plane:** interactive `@dsh` commands require every originating actor to pass the write/maintain/admin check. Writes additionally require explicit `allow-write: "true"` and mandatory successful validation. Capability-bearing inputs such as `container-image`, `base-url`, `isolation`, and `dsh-executable` must come only from trusted workflow configuration. Workflow token scopes only determine which GitHub APIs the controller may call; they cannot bypass actor or policy gates.
2. **Input data:** repository files, diffs, CI logs, README/AGENTS/CLAUDE files, issues, pull requests, and comments always remain untrusted. Model output receives no authority directly and must pass strict schema, path, size, and marker validation.
3. **Worker:** `untrusted`, `trusted-read`, and `trusted-write` are execution profiles; they do not make repository content trusted. Forks receive no repository tools, the read profile gets read/search over an immutable copy, and the write profile gets read/search/edit over a `.git`-less copy without shell or direct GitHub access.
4. **Controller / commit authority:** only the controller holds the GitHub client and real credentials. It rebinds SHA and issue/PR identity, runs credential-free validation, checks actual file changes, and finally comments, commits, pushes, or opens a pull request.

Workflow permissions used by the supplied templates are:

| Scenario                                 | Workflow token permissions                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| Automatic or fork PR review              | `contents: read`, `pull-requests: write`                                                    |
| Read-only general task                   | `contents: read`; add the matching write scope only when an Issue/PR sticky comment is used |
| Automation task that creates a branch/PR | `contents: write`, `pull-requests: write`                                                   |
| CI diagnosis                             | `actions: read`, `checks: read`, `contents: read`, `issues: write`, `pull-requests: write`  |
| Commands that support fix / implement    | `contents: write`, `actions: read`, `checks: read`, `issues: write`, `pull-requests: write` |
| CI auto-fix                              | Same as the preceding row                                                                   |

Progress comments reuse the same permissions as final result comments and require no new scope. `GITHUB_TOKEN` remains in the controller, while the controller-side proxy injects the DeepSeek key; neither credential enters the DSH workspace, MCP/Plugin configuration, or validation commands. See [`SECURITY.md`](SECURITY.md) for the full trust model, known limitations, and vulnerability reporting. v0.4.0 accepts only the audited `@deepseek-ai/dsh@0.1.0-rc.8` and `@deepseek-ai/dsh-mcp-client@0.1.0-rc.8` lock; another version requires a matching policy/profile review.

## Architecture

```text
GitHub event
    ↓
Action controller: route task/review/diagnose/fix/implement → resolve target → authorize
    ↓
Controller-owned sticky progress for read-only operations → bounded workspace / context
    ↓
Fresh DSH turn in Docker
    ├─ DSH native / official MCP / Plugin tool → positive Action policy → receipt
    ├─ needs_tool → controller fixed-argv tool ──────────────────────────┐
    └─ final → controller validation failure ────────────────────────────┤ bounded untrusted feedback
                                                                         └→ next DSH turn (max-turns/deadline)
    ↓
Action controller: final schema + validation → publish / commit / branch + PR
                                      (write-task comments begin only here)
    ↓
Action outputs: legacy scalars + versioned result-json
```

The DSH worker does not hold a GitHub client. Model output must pass schema validation before the controller maps it to diff lines or invokes an authorized tool. Read-only tracking comments remain Controller-owned; write-task comments and every trusted write additionally wait for successful final repository validation. The controlled Profile is generated only from trusted workflow inputs after Controller validation; repository content and model output cannot modify the MCP/Bundle/Plugin set.

## Development

Node.js 24 is required.

```bash
npm ci
npm run check
```

The `dist/` bundle used by GitHub Marketplace is committed with each release. See [`BUNDLED_DEPENDENCIES.md`](BUNDLED_DEPENDENCIES.md) for dependency and bundling details.

## License

[MIT](LICENSE). Third-party licenses are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) provides the headless runtime, MCP client, Bundle/Profile loading, and Cordis configuration used by this project.
- The GitHub event routing, permission checks, and tracking model are adapted from the MIT-licensed [Claude Code Action](https://github.com/anthropics/claude-code-action). The exact upstream commit and license text are recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- The structured-output and execution/publication permission separation also draw on the design of [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action); this project retains its own controller/worker trust boundary and result protocol.
