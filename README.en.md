# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[中文](README.md)

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
      - uses: Lixiaoyiao/deepseek-harness-action@badb4542f53941ae99c13773574ea90e48a277a1 # v0.1.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

Open a non-draft pull request. The action reads the diff and repository context, then posts a review summary. When it finds a concrete problem, it also comments on the relevant line.

See [`examples/fork-review.yml`](examples/fork-review.yml) for the complete template. This workflow uses `pull_request_target`, checks out only the trusted base SHA, and never runs code from the fork.

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

Repository files, diffs, CI logs, issues, pull requests, and comments are all treated as untrusted data.

- `GITHUB_TOKEN` stays in the action controller and is never passed to DSH.
- The controller-side proxy injects the DeepSeek key; it never enters the workspace or validation commands.
- Forks receive no filesystem or execution tools, and `pull_request_target` never checks out the PR head.
- Before a write, the controller checks the actor, repository origin, bound commit, and actual changed files again.
- Validation runs in a separate credential-free container.

See [`SECURITY.md`](SECURITY.md) for the full trust model, known limitations, and vulnerability reporting. v0.1.0 pins `@deepseek-ai/dsh@0.1.0-rc.6`; DSH is moving quickly, so review the configuration again before upgrading it.

## Architecture

```text
GitHub event
    ↓
Action controller: route → authorize → snapshot
    ↓
DSH worker in Docker
    ↓
Action controller: validate → comment / commit / open PR
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
