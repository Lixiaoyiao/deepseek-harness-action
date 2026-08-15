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

> v0.2.0 is released. The Quick start above and the files in `examples/` are pinned to the immutable runtime commit exercised by the real E2E release checks. See [`CHANGELOG.md`](CHANGELOG.md) for the complete release notes.

## What it does

| Entry point                                      | Result                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| PR `opened` / `synchronize` / `ready_for_review` | Automatic review with a summary and inline comments                  |
| `@dsh review`                                    | Review the current pull request again                                |
| `@dsh diagnose`                                  | Read failed checks and logs, then identify the cause                 |
| `@dsh fix`                                       | Change code and run validation in trusted write mode                 |
| `@dsh implement` on an issue                     | Understand the issue, change code, validate, and open a pull request |

The command must be on the first line of the comment. Ready-to-copy workflows are included:

- [`examples/commands.yml`](examples/commands.yml) for `@dsh` commands, fixes, and Issue → PR
- [`examples/ci-diagnose.yml`](examples/ci-diagnose.yml) for failed CI diagnosis
- [`examples/ci-auto-fix.yml`](examples/ci-auto-fix.yml) for trusted CI auto-fix

Writing `@dsh fix` or `@dsh implement` does not grant write access by itself. The workflow must also set `allow-write: "true"` and define validation commands. See [`action.yml`](action.yml) for all inputs.

## Progress and structured outputs (v0.2.0)

When an authorized operation resolves to a pull request or issue, the controller updates one sticky comment at three major stages: preparing bounded context, running DSH and validating its structured output, and publishing the result or applying the trusted write. It reuses the existing controller-owned v1 marker, so progress does not create a second status comment:

| Operation           | Reused sticky marker |
| ------------------- | -------------------- |
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
| `operation`        | `review`, `diagnose`, `fix`, `implement`, or `none`                              |
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

| Scenario                              | Workflow token permissions                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| Automatic or fork PR review           | `contents: read`, `pull-requests: write`                                                    |
| CI diagnosis                          | `actions: read`, `checks: read`, `contents: read`, `issues: write`, `pull-requests: write`  |
| Commands that support fix / implement | `contents: write`, `actions: read`, `checks: read`, `issues: write`, `pull-requests: write` |
| CI auto-fix                           | Same as the preceding row                                                                   |

Progress comments reuse the same permissions as final result comments and require no new scope. `GITHUB_TOKEN` remains in the controller, while the controller-side proxy injects the DeepSeek key; neither credential enters the DSH workspace or validation commands. See [`SECURITY.md`](SECURITY.md) for the full trust model, known limitations, and vulnerability reporting. v0.2.0 pins `@deepseek-ai/dsh@0.1.0-rc.6`; DSH is moving quickly, so review the configuration again before upgrading it.

## Architecture

```text
GitHub event
    ↓
Action controller: route → resolve target → authorize
    ↓
Controller-owned sticky progress → bounded workspace / context
    ↓
DSH worker in Docker
    ↓
Action controller: schema validation → publish / controller validation / write
    ↓
Action outputs: legacy scalars + versioned result-json
```

The DSH worker does not hold a GitHub client. Model output must pass schema validation before the controller maps it to diff lines, updates tracking comments, or performs a trusted write.

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
