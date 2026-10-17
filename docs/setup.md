# Setup

[中文](setup.zh-CN.md) · [README](../README.md) · [Usage](usage.md) · [Configuration](configuration.md)

This guide takes you from installation to a safe first workflow. Start with read-only pull request review, then add commands or write mode only when the repository needs them.

## Quick Start: installer

From anywhere inside the existing GitHub repository you want to configure, run:

```bash
npm create deepseek-harness-action@latest
```

With no flags in a terminal, the installer guides read-only PR Review. It finds
the Git root and the `github.com` origin, checks `gh` availability/login and asks
before creating `.github/workflows/dsh-review.yml`. It creates no remote
repository or remote configuration. Guided setup requires an existing Git
repository; use manual file generation below if you are still preparing one.

When `gh` is logged in, the installer verifies repository access and lists only
Secret names. If `DEEPSEEK_API_KEY` is absent, you may confirm setting it with
hidden terminal input. Its value is sent only through `gh secret set` stdin;
neither arguments nor logs contain the key. Missing login prints
`gh auth login --hostname github.com`; finish the login manually and rerun, or
add the Secret in **Settings → Secrets and variables → Actions**.

Commit and push are separately confirmed and default to No. The installer
commits only the generated workflow using an isolated index. Other edits and
untracked files remain untouched; existing staged changes prevent its commit.
It executes no repository hooks, filters, validation scripts or signing program.
The commit is unsigned. Use a manual commit if your repository requires signing
or hooks. Push requires a single verified destination and remote parent, then performs a normal
non-force push of that exact commit; other unpublished or concurrent history
requires manual reconciliation. Automatic tag following is disabled only for
that push, preserving local settings. The workflow must reach the default branch.

Rerun the same no-flag command to resume. An identical workflow is preserved;
modified existing files require manual review. Login and Secret names are
rechecked, a workflow-only commit is reused, and an already published commit is
recognized. A failed or uncertain Secret request prints recovery guidance and
does not expose transport output. Check Secret names/permissions before retrying.

The built-in starter check validates the immutable Action reference, read-only
worker and trusted base checkout. Credentials, Actions permissions/quota,
Docker/image availability and the actual review still require a first Action run.

Use `--advanced` to select workflow and controlled/native composition interactively:

```bash
npm create deepseek-harness-action@latest -- --advanced
```

The advanced/manual flow offers:

| Choice                   | Files created                        |
| ------------------------ | ------------------------------------ |
| **PR Review**            | `.github/workflows/dsh-review.yml`   |
| **@dsh Coding Commands** | `.github/workflows/dsh-commands.yml` |
| **Both**                 | Both workflow files above            |
| **Automatic Session**    | `.github/workflows/dsh-session.yml`  |

Advanced setup and explicit flags only generate workflow files; they never set
Secrets, commit, push or open PRs. In CI or another non-interactive environment,
pass the mode explicitly; missing `--mode` fails without reading stdin:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

Explicit `--mode` also keeps manual file generation in a terminal. Omitting
`--dsh-mode` defaults to `controlled` without a composition prompt; select
native explicitly if intended:

```bash
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

Automatic Session creates a read-only starter with matching key/run-name/
concurrency and `queue: max` to retain pending follow-ups. Commit it to the
default branch and dispatch there with a lowercase key for the logical task.
Reuse the key with a new prompt; no source run ID is needed. Failed, expired,
corrupt or unknown history requires reconciliation before continuing.

```bash
npm create deepseek-harness-action@latest -- --mode session
```

Installer `0.7.0` targets formal Action `v0.10.3` and exact DSH `0.2.1-rc.2`
in both compositions. Only after the Action tag, GitHub Release and canary agree
does packing receive the verified full commit through `DSH_ACTION_RELEASE_SHA`.
The separately reviewed installer source is tagged
`create-deepseek-harness-action-v0.7.0`. Source templates retain the controlled
build token; generated workflows contain neither that token nor a candidate SHA,
floating tag or branch. A source commit cannot supply its own future identity.

After the installer succeeds:

1. If guided setup did not configure it, add `DEEPSEEK_API_KEY` under **Settings → Secrets and variables → Actions**.
2. Commit/push the workflow to the default branch; for Review, open or update a non-draft pull request.
3. For Coding Commands, put an `@dsh` command on the first line of an Issue or pull request comment. Before requesting a write, replace the validation command placeholders with commands for your project.
4. Continue with the security guidance in this document and read [Usage](usage.md) for every supported command.

Node.js and npm are needed locally only to run the installer. The generated workflows do not assume that the target repository is a Node.js project.

## Check configuration before the first model run

From a reviewed checkout of the Action source, with Node.js 24 and its locked
dependencies installed, copy [`examples/config-check.json`](../examples/config-check.json)
and replace its `inputs` with the literal Action input names/values from your
workflow. Keep secrets out of that file: `credentialEnv` selects the environment
variable holding each Controller credential.

```bash
npm run check:config -- --config examples/config-check.json
```

The checker reads only the selected JSON file (regular UTF-8 file, at most
256 KiB). It uses the same public input/extension schemas as the Action and
checks missing credentials, the exact DSH version, composition/isolation and
explicit write validation configuration. It starts no model, runs no repository
code/validation command, makes no network calls, and changes no remote state.
Its JSON result uses `scope: static_configuration_only`; `ok: true` means only
that the checked configuration is valid. Docker/image availability, credential
validity and online permissions/quota, current event/SHA authority, text-file
contents and extension activation remain `not_checked`. A write-capable `auto`
configuration with missing validation gets a warning because read routes remain
usable; an actual routed write fails before the model starts.

At execution, missing credentials/unsupported DSH or malformed extensions fail
during input parsing. Explicit/routed writes reject empty validation, disabled
tests and untouched placeholders before model startup. A bounded, credential-free
`docker info` probe reports an unavailable CLI/daemon before runtime installation.
These checks never grant authority or replace executed Controller validation.

Installer 0.7.0 accepts optional `--test-commands` JSON argv arrays and
`--container-image name@sha256:<64 lowercase hex>` for `commands` or `both`. Maintainers must explicitly choose reviewed,
credential-free commands. The installer never discovers or executes scripts,
and omitting the flags preserves the fail-closed placeholder.

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
uses: Lixiaoyiao/deepseek-harness-action@v0.10.3
```

For production, replace the tag with the full immutable commit SHA resolved
from formal `v0.10.3`. Installer `0.7.0` targets that Action identity, with a
separately reviewed source commit. Generated workflows use the verified release
commit; source templates receive it through the release build.

The installer source tag and `DSH_ACTION_RELEASE_SHA` packing input must each
be verified for their own purpose. Source preparation does not establish a
release identity.

Do not use `main`, `latest`, a version range, a candidate SHA, or another
floating ref. Keep `dsh-version` at the Action's audited exact value:

```yaml
with:
  dsh-version: 0.2.1-rc.2
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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.10.3
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.2.1-rc.2
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
| Selected typed GitHub tools                   | Add only their matching `issues`, `pull-requests`, `checks`, or `statuses` read/write scope |

A broad workflow token cannot bypass actor, event, origin, SHA, protected-path, validation, or Controller policy checks. Conversely, missing token scopes can stop an otherwise authorized result from being published.

### 5. Add commands, CI, or automation

Copy the template that matches the desired entry point:

- [`examples/commands.yml`](../examples/commands.yml): `@dsh` task, review, diagnose, fix, and Issue implementation.
- [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml): diagnose a failed CI run without changing code.
- [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml): trusted CI repair with mandatory validation.
- [`examples/task-automation.yml`](../examples/task-automation.yml): a maintainer-authored dispatch task with read or write access.
- [`examples/github-integration.yml`](../examples/github-integration.yml): custom routes, safe branch naming, typed GitHub tools, and structured task output.
- [`examples/controlled-extensions.yml`](../examples/controlled-extensions.yml): advanced custom Profile, MCP, and Bundle configuration.

For `issue_comment`, `workflow_run`, dispatch, and schedule workflows, run the workflow definition from the trusted default branch. Check out the bound trusted branch or SHA, always set `persist-credentials: false`, and keep capability-bearing inputs literal or derived only from trusted workflow configuration.

The `prompt`, trigger/filter, branch, schema, and tool inputs are trusted maintainer configuration. Do not interpolate Issue bodies, PR text, comments, logs, repository files, or model output into them. GitHub resolves expressions before the Action starts, so the Action cannot recover the original provenance.

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
2. The Action resolves `dsh-version` to `0.2.1-rc.2`.
3. A read-only review reports no workspace write capability.
4. Only the intended Controller-owned summary comment and inline findings appear.
5. The step summary and `result-json` show the expected operation, permission profile, effective tools, and network path.

Next, read [Usage](usage.md) for commands and [Configuration](configuration.md) for every input, permission boundary, and output.

## Import local DSH plugins

Run `npm create deepseek-harness-action@latest -- --advanced --import-plugins` in a terminal. The installer reads only package metadata under `DSH_HOME/profiles` (default `~/.dsh/profiles`). It lists third-party package names, installed versions and compatibility with DSH `0.2.1-rc.2`, then asks for the package numbers and confirmation. Use `--dsh-home` for another location.

Enabled npm DSH Bundles can be reinstalled at exact versions in Native mode. Controlled mode also asks for the exact `plugin__owner__tool` names and grants only the selected read-only tools. Packages using arbitrary tool names need Native mode or manual configuration. Local paths, npm aliases, disabled Bundles, incompatible versions and plain dependencies need manual setup; the list explains each case. An undeclared compatibility range is shown as unverified.

The generated workflow enables package installation only after confirmation. It does not copy `.env`, credentials, local Cordis patches, compatibility exceptions or plugin settings. Imported plugins use package defaults and request no extra network or workspace-write access; existing workflow permissions and shared worker mounts still apply. Add any required cloud configuration separately with the existing extension inputs. Fork reviews retain their extension-free configuration.

Native web search and fetch now use the DeepSeek Search/Fetch API through the Controller proxy. Controlled search uses the same Search API; add `native.web-fetch` explicitly under a custom or standard permission profile to enable Fetch. The `base-url` input also selects the upstream for these API routes; `web-search-base-url` remains the legacy Messages-search route. The API model ID for the new Flash catalog entry is `deepseek-flash`.

Controlled automatic import targets read-only Review and Session workflows. Coding-command plugins need manual per-task permission declarations; selecting both workflows imports into Review and leaves Commands unchanged. Native commands retain the existing trusted-context gates, so plugins cannot run for untrusted fork commands.

An explicit custom `web-search-base-url` keeps its legacy Messages-search protocol. The default selects the new Search API. Fetch always uses its separate API grant and `base-url`, including when Fetch is the only selected web tool.
