# Setup

[中文](setup.zh-CN.md) · [README](../README.md) · [Usage](usage.md) · [Configuration](configuration.md)

This guide takes you from installation to a safe first workflow. Start with read-only pull request review, then add commands or write mode only when the repository needs them.

## Quick Start: installer

From the root of the repository you want to configure, run:

```bash
npm create deepseek-harness-action@latest
```

Choose what to install:

| Choice                   | Files created                        |
| ------------------------ | ------------------------------------ |
| **PR Review**            | `.github/workflows/dsh-review.yml`   |
| **@dsh Coding Commands** | `.github/workflows/dsh-commands.yml` |
| **Both**                 | Both workflow files above            |

For CI or another non-interactive environment, pass the mode explicitly. The installer will not wait for stdin:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

The installer creates `.github/workflows/` when necessary and refuses to overwrite an existing target workflow. It does not add `DEEPSEEK_API_KEY`, commit or push changes, or open a pull request. The generated workflows pin the Action to the immutable v0.5.2 release commit.

After the installer succeeds:

1. Add `DEEPSEEK_API_KEY` under **Settings → Secrets and variables → Actions**.
2. For Review, open or update a non-draft pull request.
3. For Coding Commands, put an `@dsh` command on the first line of an Issue or pull request comment. Before requesting a write, replace the validation command placeholders with commands for your project.
4. Continue with the security guidance in this document and read [Usage](usage.md) for every supported command.

Node.js and npm are needed locally only to run the installer. The generated workflows do not assume that the target repository is a Node.js project.

## Manual installation

Use the following steps if you prefer to create the workflows yourself.

### Requirements

- A GitHub repository where you can add Actions secrets and workflows.
- A DeepSeek API key.
- An Ubuntu GitHub-hosted runner, or a self-hosted runner with Docker available.
- Node.js 24 only when developing this Action itself; it is not required to run a manually installed workflow.

Docker is required for untrusted pull request data, all writes, and all MCP, Bundle, or Plugin extensions. The optional host execution path has no operating-system isolation and is for dedicated trusted runners only.

### 1. Add the API key

Open **Settings → Secrets and variables → Actions → New repository secret** and create:

```text
DEEPSEEK_API_KEY
```

Pass it only to the `deepseek-api-key` input. Do not expose it through `env`, a prompt, validation command, MCP configuration, or Plugin configuration. The Action keeps the real key in a Controller-side proxy; the DSH worker receives only an ephemeral proxy token.

The default `github-token` is `${{ github.token }}` and is also Controller-only. Keep checkout credentials disabled so repository code and the worker cannot inherit Git credentials.

### 2. Choose an Action reference

The examples use the current release tag for readability:

```yaml
uses: Lixiaoyiao/deepseek-harness-action@v0.5.2
```

For production, replace the tag with the full immutable commit SHA published for that release. Do not use `main`, `latest`, a version range, or another floating ref. Keep `dsh-version` at the Action's audited exact value:

```yaml
with:
  dsh-version: 0.1.1-rc.2
```

The Action rejects a different DSH version until that package family and its Profile/tool surface have been reviewed and released together.

### 3. Add safe automatic pull request review

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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.5.2
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.1.1-rc.2
```

`pull_request_target` can access secrets and a privileged token, so this workflow checks out only the immutable trusted base SHA. The Action obtains the pull request diff and changed-file context through GitHub APIs; it does not check out or execute the fork revision. Preserve `persist-credentials: false`.

Open a non-draft pull request and inspect the Actions run, review summary, and any inline findings. The full maintained template is [`examples/fork-review.yml`](../examples/fork-review.yml).

### 4. Grant only the GitHub permissions the entry point needs

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

### 5. Add commands, CI, or automation

Copy the template that matches the desired entry point:

- [`examples/commands.yml`](../examples/commands.yml): `@dsh` task, review, diagnose, fix, and Issue implementation.
- [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml): diagnose a failed CI run without changing code.
- [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml): trusted CI repair with mandatory validation.
- [`examples/task-automation.yml`](../examples/task-automation.yml): a maintainer-authored dispatch task with read or write access.
- [`examples/controlled-extensions.yml`](../examples/controlled-extensions.yml): advanced custom Profile, MCP, and Bundle configuration.

For `issue_comment`, `workflow_run`, dispatch, and schedule workflows, run the workflow definition from the trusted default branch. Check out the bound trusted branch or SHA, always set `persist-credentials: false`, and keep capability-bearing inputs literal or derived only from trusted workflow configuration.

The `prompt` input is trusted instruction. Do not interpolate Issue bodies, PR text, comments, logs, repository files, or model output into it. GitHub resolves expressions before the Action starts, so the Action cannot recover the original provenance.

### 6. Enable write mode deliberately

A write command alone does not authorize mutation. A valid write workflow must also meet the actor, event, same-repository, branch, SHA, workspace, and tool policy checks, and must configure Controller-run validation. Replace every placeholder below with the commands and pinned container image for your project before enabling write mode; these are deliberately not npm defaults:

```yaml
with:
  permission-profile: standard
  allow-write: "true"
  run-tests: "true"
  validation-integrity: strict
  test-commands: >-
    [
      ["REPLACE_WITH_YOUR_PROJECT_INSTALL_COMMAND"],
      ["REPLACE_WITH_YOUR_PROJECT_TEST_COMMAND"]
    ]
  container-image: REPLACE_WITH_YOUR_PROJECT_IMAGE@sha256:REPLACE_WITH_FULL_DIGEST
```

Each validation command is a fixed argv array and is not expanded by a shell. Include every required argument as a separate string; every command must pass. The placeholders fail closed until replaced. `run-tests: "false"` denies the write; it is not a waiver.

The Docker image is executable worker code. Writes and extensions require a full digest, not only a tag. See [Configuration](configuration.md#write-validation-and-integrity) before enabling this path.

### Checkout, timeout, and concurrency rules

- Keep every `actions/checkout` reference pinned and set `persist-credentials: false`.
- For `pull_request_target`, check out only `github.event.pull_request.base.sha`; never run the fork checkout.
- Use a concurrency group scoped to the PR, Issue, upstream run, or automation target. The sticky marker does not contain run/head freshness data, so serialization prevents an older run from overwriting newer status.
- Keep the job-level `timeout-minutes` a few minutes above the Action's `timeout-minutes` input. The Action needs a short bounded window to stop its worker, write outputs, and attempt eligible cancellation status updates.
- A forced runner termination can bypass all cleanup. Treat the Actions conclusion as authoritative; see [Troubleshooting](troubleshooting.md#cancellation-or-a-sticky-comment-remains-in-progress).

### Verify the installation

After the first run, check that:

1. Checkout reports `persist-credentials: false` and the expected trusted SHA.
2. The Action resolves `dsh-version` to `0.1.1-rc.2`.
3. A read-only review reports no workspace write capability.
4. Only the intended Controller-owned summary comment and inline findings appear.
5. The step summary and `result-json` show the expected operation, permission profile, effective tools, and network path.

Next, read [Usage](usage.md) for commands and [Configuration](configuration.md) for every input, permission boundary, and output.
