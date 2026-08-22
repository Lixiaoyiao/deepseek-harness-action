# Setup

[中文](setup.zh-CN.md) · [README](../README.md) · [Usage](usage.md) · [Configuration](configuration.md)

This guide takes you from a repository secret to a safe first workflow. Start with read-only pull request review, then add commands or write mode only when the repository needs them.

## Requirements

- A GitHub repository where you can add Actions secrets and workflows.
- A DeepSeek API key.
- An Ubuntu GitHub-hosted runner, or a self-hosted runner with Docker available.
- Node.js 24 only when developing this Action itself; consumers do not install Node separately.

Docker is required for untrusted pull request data, all writes, and all MCP, Bundle, or Plugin extensions. The optional host execution path has no operating-system isolation and is for dedicated trusted runners only.

## 1. Add the API key

Open **Settings → Secrets and variables → Actions → New repository secret** and create:

```text
DEEPSEEK_API_KEY
```

Pass it only to the `deepseek-api-key` input. Do not expose it through `env`, a prompt, validation command, MCP configuration, or Plugin configuration. The Action keeps the real key in a Controller-side proxy; the DSH worker receives only an ephemeral proxy token.

The default `github-token` is `${{ github.token }}` and is also Controller-only. Keep checkout credentials disabled so repository code and the worker cannot inherit Git credentials.

## 2. Choose an Action reference

The examples use the current release tag for readability:

```yaml
uses: Lixiaoyiao/deepseek-harness-action@v0.5.1
```

For production, replace the tag with the full immutable commit SHA published for that release. Do not use `main`, `latest`, a version range, or another floating ref. Keep `dsh-version` at the Action's audited exact value:

```yaml
with:
  dsh-version: 0.1.1-rc.2
```

The Action rejects a different DSH version until that package family and its Profile/tool surface have been reviewed and released together.

## 3. Add safe automatic pull request review

Create `.github/workflows/dsh-review.yml`:

```yaml
name: DSH review

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: dsh-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout trusted base only
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
          fetch-depth: 1
      - uses: Lixiaoyiao/deepseek-harness-action@v0.5.1
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.1.1-rc.2
```

`pull_request_target` can access secrets and a privileged token, so this workflow checks out only the immutable trusted base SHA. The Action obtains the pull request diff and changed-file context through GitHub APIs; it does not check out or execute the fork revision. Preserve `persist-credentials: false`.

Open a non-draft pull request and inspect the Actions run, review summary, and any inline findings. The full maintained template is [`examples/fork-review.yml`](../examples/fork-review.yml).

## 4. Grant only the GitHub permissions the entry point needs

Agent permission profiles do not grant GitHub permissions. The workflow token scopes only determine which APIs the trusted Controller can call.

| Scenario                                      | Workflow permissions                                                                        |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Automatic or fork PR review                   | `contents: read`, `pull-requests: write`                                                    |
| Read-only task without an Issue/PR comment    | `contents: read`                                                                            |
| Read-only task with an Issue/PR sticky result | `contents: read` plus the matching `issues: write` or `pull-requests: write`                |
| CI diagnosis                                  | `actions: read`, `checks: read`, `contents: read`, `issues: write`, `pull-requests: write`  |
| Commands with fix or implement enabled        | `actions: read`, `checks: read`, `contents: write`, `issues: write`, `pull-requests: write` |
| CI auto-fix                                   | The same permissions as the preceding row                                                   |
| Automation that creates a branch and PR       | `contents: write`, `pull-requests: write`                                                   |

A broad workflow token cannot bypass actor, event, origin, SHA, protected-path, validation, or Controller policy checks. Conversely, missing token scopes can stop an otherwise authorized result from being published.

## 5. Add commands, CI, or automation

Copy the template that matches the desired entry point:

- [`examples/commands.yml`](../examples/commands.yml): `@dsh` task, review, diagnose, fix, and Issue implementation.
- [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml): diagnose a failed CI run without changing code.
- [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml): trusted CI repair with mandatory validation.
- [`examples/task-automation.yml`](../examples/task-automation.yml): a maintainer-authored dispatch task with read or write access.
- [`examples/controlled-extensions.yml`](../examples/controlled-extensions.yml): advanced custom Profile, MCP, and Bundle configuration.

For `issue_comment`, `workflow_run`, dispatch, and schedule workflows, run the workflow definition from the trusted default branch. Check out the bound trusted branch or SHA, always set `persist-credentials: false`, and keep capability-bearing inputs literal or derived only from trusted workflow configuration.

The `prompt` input is trusted instruction. Do not interpolate Issue bodies, PR text, comments, logs, repository files, or model output into it. GitHub resolves expressions before the Action starts, so the Action cannot recover the original provenance.

## 6. Enable write mode deliberately

A write command alone does not authorize mutation. A valid write workflow must also meet the actor, event, same-repository, branch, SHA, workspace, and tool policy checks, and must configure Controller-run validation:

```yaml
with:
  permission-profile: standard
  allow-write: "true"
  run-tests: "true"
  validation-integrity: strict
  test-commands: >-
    [
      ["npm","ci","--ignore-scripts"],
      ["npm","test"],
      ["npm","run","typecheck"]
    ]
  container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
```

Replace these validation commands with the commands for your repository. Each entry is a fixed argv array and is not expanded by a shell. Every command must pass. `run-tests: "false"` denies the write; it is not a waiver.

The Docker image is executable worker code. Writes and extensions require a full digest, not only a tag. See [Configuration](configuration.md#write-validation-and-integrity) before enabling this path.

## Checkout, timeout, and concurrency rules

- Keep every `actions/checkout` reference pinned and set `persist-credentials: false`.
- For `pull_request_target`, check out only `github.event.pull_request.base.sha`; never run the fork checkout.
- Use a concurrency group scoped to the PR, Issue, upstream run, or automation target. The sticky marker does not contain run/head freshness data, so serialization prevents an older run from overwriting newer status.
- Keep the job-level `timeout-minutes` a few minutes above the Action's `timeout-minutes` input. The Action needs a short bounded window to stop its worker, write outputs, and attempt eligible cancellation status updates.
- A forced runner termination can bypass all cleanup. Treat the Actions conclusion as authoritative; see [Troubleshooting](troubleshooting.md#cancellation-or-a-sticky-comment-remains-in-progress).

## Verify the installation

After the first run, check that:

1. Checkout reports `persist-credentials: false` and the expected trusted SHA.
2. The Action resolves `dsh-version` to `0.1.1-rc.2`.
3. A read-only review reports no workspace write capability.
4. Only the intended Controller-owned summary comment and inline findings appear.
5. The step summary and `result-json` show the expected operation, permission profile, effective tools, and network path.

Next, read [Usage](usage.md) for commands and [Configuration](configuration.md) for every input, permission boundary, and output.
