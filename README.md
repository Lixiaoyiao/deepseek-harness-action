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
      - uses: Lixiaoyiao/deepseek-harness-action@50580590de152abcc3bd81c07b26dd632b76360b # v0.2.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

Open a non-draft pull request. The action reads the diff and repository context, then posts a review summary. When it finds a concrete problem, it also comments on the relevant line.

See [`examples/fork-review.yml`](examples/fork-review.yml) for the complete template. This workflow uses `pull_request_target`, checks out only the trusted base SHA, and never runs code from the fork.

> v0.2.0 is released. The Quick start above and the existing v0.2 templates remain pinned to the immutable runtime commit exercised by the real E2E release checks; that SHA does not include the v0.3 features described below. The new [`examples/task-automation.yml`](examples/task-automation.yml) is explicitly marked as a planned v0.3 interface. Replace its tag with the immutable release commit after publication. See [`CHANGELOG.md`](CHANGELOG.md) for the complete release notes.

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
- [`examples/task-automation.yml`](examples/task-automation.yml) for the planned v0.3 explicit-prompt automation interface

Writing `@dsh fix` or `@dsh implement` does not grant write access by itself. The workflow must also set `allow-write: "true"` and define validation commands. See [`action.yml`](action.yml) for all inputs.

## General tasks and explicit automation (v0.3.0 development preview)

`task` is not limited to the review, diagnose, fix, or implement templates. It can answer natural-language questions, inspect a repository, or carry out a coding task:

```text
@dsh task --read Explain why this pull request needs a two-phase commit
@dsh task --write Add empty-input coverage to the parser and run validation
```

The command must start on the first line of the comment; later lines may continue the instructions. `--read` is the default for `task`. `--write` requests a capability but does not authorize it. The workflow still needs `allow-write: "true"`, a same-repository context that is not `pull_request_target`, write/maintain/admin permission for every originating actor, and `workspace.edit` in the effective tool allowlist. A fork pull request can never be upgraded to write mode this way.

On `workflow_dispatch`, `repository_dispatch`, or `schedule` automation events, `command: auto` plus a non-empty `prompt` routes to a general `task`. You may instead set `command: task`, in which case `prompt` is required. `task-access` defaults to `read`:

```yaml
with:
  command: auto
  prompt: "Check the dependency boundary, add tests if needed, and explain the result"
  task-access: read
```

`prompt` is trusted control-plane configuration. Populate it only from a maintainer-authored workflow or a trusted dispatch input; do not silently promote issue bodies, pull-request content, logs, or other untrusted data into `prompt`. See [`examples/task-automation.yml`](examples/task-automation.yml) for a complete read/write dispatch template. It uses a planned `@v0.3` interface placeholder and must be pinned to an immutable commit SHA after the release.

A read-only automation task without an issue or pull-request entity returns its answer through the step summary and outputs. A write task with no entity, or one targeting an issue, creates a dedicated `dsh/task-*` branch and pull request; the controller never pushes general automation changes directly to the default branch. An authorized task on a same-repository pull request can affect only the target branch that the controller bound and revalidated.

## Multi-turn edit, validation, and repair loop

The v0.3 loop belongs to the Action controller, not to a shell inside DSH. Every iteration is a fresh DSH turn constrained by the same task anchor and capability policy:

```text
DSH turn
  ├─ needs_tool → controller runs one allowed tool → bounded/redacted untrusted result → next turn
  ├─ final → controller validation fails → stdout/stderr as untrusted feedback → next edit turn
  ├─ final → validation passes → controller publishes, commits, or opens a pull request
  └─ blocked → stop safely with a neutral result
```

DSH cannot run a shell directly and holds neither GitHub nor DeepSeek credentials. The controller owns tool execution, validation, actual-change inspection, and the final GitHub mutation. `max-turns` (default 3) bounds all DSH turns consumed by tool requests and validation repairs; `timeout-minutes` is the deadline for the complete controller loop. If the same workspace revision produces the same validation failure twice, no-progress detection stops the loop. Turn/tool/validation-retry counts and bounded tool receipts are recorded under `result-json.loop`.

## Maintainer-defined safe command tools

The model cannot assemble arbitrary shell commands. A maintainer defines the complete fixed argv for each command in a versioned `tool-config` manifest, then exposes its ID separately through `allowed-tools`:

```yaml
with:
  allowed-tools: '["workspace.read","workspace.search","workspace.edit","command.unit-tests"]'
  tool-config: |
    {
      "schemaVersion": 1,
      "commands": [{
        "name": "unit-tests",
        "description": "Run the repository unit-test command",
        "argv": ["npm", "test"],
        "timeoutMinutes": 10,
        "maxOutputBytes": 131072,
        "maxCalls": 2,
        "network": "none",
        "workspaceAccess": "read"
      }]
    }
```

Replace the sample argv with a deterministic command for your repository. A command tool accepts no model arguments. Common direct shell executables are rejected as an additional guard; undefined tools, calls beyond `maxCalls`, and network/workspace access that exceeds the current policy also fail. The primary boundary is maintainer-fixed complete argv, no model-added arguments, and a credential-isolated container pinned by full digest. stdout/stderr is bounded and redacted, then returned only as untrusted feedback. A manifest entry alone grants nothing: its ID must also appear in `allowed-tools`, and the current security policy must allow the required execute/write/network capability.

## v0.3 extension seams and v0.2 compatibility

v0.3 fixes the internal protocol-v1 shapes for `AgentEngine`, `ToolProvider`, `ExtensionProvider`, `SessionStore`, and session bindings. A future resume implementation can bind a session to repository/head, actor, policy, task scope, engine, toolset, and extension lock so it cannot be reused across repositories, SHAs, or capability policies.

These are extension seams only: **v0.3.0 does not enable real MCP servers, plugin discovery/installation/execution, or cross-workflow session persistence/resume**. There are no MCP, plugin, or resume action inputs today, and the action emits no reusable session token. Provider type names are not a claim that those user-facing features are available.

See [`docs/extension-contracts.md`](docs/extension-contracts.md) for protocol versioning, tool routing, session binding, and the security responsibilities future providers must satisfy.

Existing v0.2 inputs, scalar outputs, and the schema-v1 `result-json` envelope remain valid. `command: auto` preserves automatic review and `workflow_run` diagnose/fix routing. v0.3 only adds the `task` operation and optional loop metadata; `task-access: read`, `max-turns: 3`, and an empty command manifest are the defaults, so existing workflows do not need to opt into the new capabilities. The v0.2.0 SHA shown above still represents v0.2.0 only.

## Progress and structured outputs

When an authorized operation resolves to a pull request or issue, the controller updates one sticky comment at three major stages: preparing bounded context, running DSH and validating its structured output, and publishing the result or applying the trusted write. It reuses the existing controller-owned v1 marker, so progress does not create a second status comment:

| Operation           | Reused sticky marker |
| ------------------- | -------------------- |
| `task`              | `task`               |
| `review`            | `summary`            |
| `diagnose`          | `diagnosis`          |
| `fix` / `implement` | `write`              |

On success, the detailed review, diagnosis, or write result replaces that same comment. On failure, it shows a stable error code, the failing phase, a redacted and bounded message, and an actionable next step. Only markers authored by the expected numeric bot ID are updated; user-forged markers are ignored. Lifecycle comment updates are best effort, so a temporary GitHub comments API failure does not hide the real agent, validation, or write outcome.

`progress-comment` defaults to `true`. Disable intermediate lifecycle updates with:

```yaml
with:
  progress-comment: "false"
```

This disables lifecycle updates only. It does not disable normal inline review comments, review summaries, CI diagnoses, or final fix status publication.

Keep the job-level `timeout-minutes` a few minutes above the action input of the same name. This gives the internal DSH watchdog time to stop the worker and finalize failure outputs, the step summary, and the sticky comment.

The action sets `result-json` on success, neutral, and failure paths. This is a `schemaVersion: 1` JSON envelope containing the applicable `status`, operation, summary, timing, policy/capabilities, actual isolation report, publication statistics, controller validation, write result, sticky comment ID, and error. `status` is one of `success`, `neutral`, `failed`, `timed_out`, `validation_failed`, or `denied`. `validation_failed` covers both invalid DSH structured output and controller validation failure; `error.code` distinguishes them. A failure object carries stable `code`, `phase`, `title`, `message`, `guidance`, and `retryable` fields.

All scalar outputs are:

| Output             | Meaning                                                                          |
| ------------------ | -------------------------------------------------------------------------------- |
| `conclusion`       | `success`, `neutral`, or `failure`                                               |
| `operation`        | `task`, `review`, `diagnose`, `fix`, `implement`, or `none`                      |
| `summary`          | Validated summary for any operation, or a safe failure summary                   |
| `review-summary`   | Backward-compatible alias of `summary`                                           |
| `findings-count`   | Selected review findings, or validated agent findings for other operations       |
| `branch-name`      | Created DSH branch, empty when not applicable                                    |
| `pull-request-url` | Created pull request URL, empty when not applicable                              |
| `commit-sha`       | Commit created by a successful fix, empty when not applicable                    |
| `trust`            | `untrusted`, `trusted-read`, `trusted-write`, or `none` before policy resolution |
| `duration-ms`      | Total controller duration in milliseconds                                        |
| `comment-id`       | Sticky progress/result comment ID when available                                 |
| `error-code`       | Stable failure code; empty on success or neutral completion                      |
| `error-message`    | Redacted and bounded failure message                                             |
| `result-json`      | The versioned JSON envelope described above                                      |

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

Summaries, paths, and other model-derived strings inside `result-json` remain untrusted data. The envelope is observability/output data, not an authorization signal; do not splice its strings directly into shell commands.

## Write mode

`allow-write` defaults to `false`. Writes are limited to trusted actors working in the same repository; fork pull requests are always review-only. Validation commands are argv arrays and are not expanded by a shell:

```yaml
with:
  allow-write: "true"
  run-tests: "true"
  test-commands: '[["npm","ci","--ignore-scripts"],["npm","test"],["npm","run","typecheck"]]'
  container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
```

Write mode requires a complete Docker image digest. Docker must be available on the runner.

## Security

The security model has four separate layers so that a trusted actor is never confused with trusted repository content:

1. **Actor / control plane:** interactive `@dsh` commands require every originating actor to pass the write/maintain/admin check. Writes additionally require explicit `allow-write: "true"`. Workflow token scopes only determine which GitHub APIs the controller may call; they cannot bypass actor or policy gates.
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

Progress comments reuse the same permissions as final result comments and require no new scope. `GITHUB_TOKEN` remains in the controller, while the controller-side proxy injects the DeepSeek key; neither credential enters the DSH workspace or validation commands. See [`SECURITY.md`](SECURITY.md) for the full trust model, known limitations, and vulnerability reporting. v0.3.0 still accepts only the audited `@deepseek-ai/dsh@0.1.0-rc.6` policy profile; adding another DSH version requires a matching profile and review.

## Architecture

```text
GitHub event
    ↓
Action controller: route task/review/diagnose/fix/implement → resolve target → authorize
    ↓
Controller-owned sticky progress → bounded workspace / context
    ↓
Fresh DSH turn in Docker
    ├─ needs_tool → controller fixed-argv tool ─┐
    └─ final → controller validation failure ──┤ bounded untrusted feedback
                                               └→ next DSH turn (max-turns/deadline)
    ↓
Action controller: final schema + validation → publish / commit / branch + PR
    ↓
Action outputs: legacy scalars + versioned result-json
```

The DSH worker does not hold a GitHub client. Model output must pass schema validation before the controller maps it to diff lines, invokes an authorized tool, updates tracking comments, or performs a trusted write. MCP/plugin/session-store types currently stop at the provider-contract layer and are not part of this runtime path.

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

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) provides the headless agent runtime used by this project.
- The GitHub event routing, permission checks, and tracking model are adapted from the MIT-licensed [Claude Code Action](https://github.com/anthropics/claude-code-action). The exact upstream commit and license text are recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
- The structured-output and execution/publication permission separation also draw on the design of [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action); this project retains its own controller/worker trust boundary and result protocol.
