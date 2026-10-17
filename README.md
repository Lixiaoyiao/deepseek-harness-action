# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[中文](README.zh-CN.md)

Run DeepSeek Harness directly from GitHub pull requests, issues, failed CI jobs, and maintainer-authored automations.

```text
GitHub PR / Issue / CI  →  DeepSeek Harness  →  Review / Diagnose / Fix / Issue → PR
```

The Action starts a credential-isolated DSH worker, validates its structured result, and lets a trusted Controller publish comments or validated changes. This is a community project, not an official DeepSeek or GitHub product. It is maintained by [@Lixiaoyiao](https://github.com/Lixiaoyiao).

## Quick Start

The Action runs DSH on GitHub-hosted Linux runners. **You do not need to install DSH or Docker on your computer.** Local DSH runs on your own computer; its keys and settings are separate from the GitHub Action.

### 1. Install the tools

On Windows, install [Node.js 24 or later](https://nodejs.org/en/download), [Git for Windows](https://git-scm.com/download/win), and [GitHub CLI](https://cli.github.com/). Keep the default installation options. Close and reopen PowerShell, then check:

```powershell
node --version
npm.cmd --version
git --version
gh --version
```

Use `npm.cmd` if PowerShell blocks `npm.ps1`; no execution-policy change is needed. On macOS and Linux, use `npm`.

### 2. Open your repository and sign in

Use the existing local repository folder. You do not need to clone it again.

```powershell
cd "C:\path\to\your-repository"
git remote -v
gh auth login
```

Choose GitHub.com and browser sign-in. The `origin` remote should point to the repository you want to set up. The installer uses that repository; it does not create a new one.

### 3. Install the workflow and set your key

```powershell
npm.cmd create deepseek-harness-action@latest
```

The guide starts with **read-only PR Review**. It shows the target repository and asks before creating files, setting the key, committing and pushing. Paste your DeepSeek API key at the hidden prompt. It is saved as the repository Actions secret `DEEPSEEK_API_KEY`.

To add it manually, open **Settings → Secrets and variables → Actions → New repository secret** on GitHub. Set the name to `DEEPSEEK_API_KEY` and paste the key as its value. A key stored in local DSH does not configure this secret.

### 4. Trigger your first PR Review

Make sure `.github/workflows/dsh-review.yml` is on the default branch, usually `main`. If direct pushes are blocked, submit and merge a PR containing the workflow first.

Create a branch, make a small change, push it and open a **non-draft pull request**. The Action posts a review on the PR. Follow progress or read failure details under **Actions → DSH review**. For a PR opened before installation, push a new commit to trigger it. Review comments on code without changing your files.

### Optional: local plugins and other workflows

Choose Review, Coding Commands, both, or automatic Session with `--advanced`. If you already have local DSH plugins, add `--import-plugins` to list their installed versions and compatibility, select packages, and confirm:

```powershell
npm.cmd create deepseek-harness-action@latest -- --advanced --import-plugins
```

Native mode supports DSH Bundles directly. Controlled mode also asks for their exact read-only tool names (`plugin__owner__tool`). Plugins without that contract need manual configuration. The cloud installs selected packages at exact versions; local settings and keys stay on your computer. Local-only, disabled and incompatible packages show a short explanation. Use `--dsh-home "C:\path\to\.dsh"` with the import option for another DSH home.

File-only and non-interactive setup remains available:

```powershell
npm.cmd create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

Controlled remains the default. Coding writes require explicit validation commands; the installer tells you where to configure them. Installer `0.7.0` targets Action `v0.10.3` and DSH `0.2.1-rc.2`. Its build binds the qualified Action commit through `DSH_ACTION_RELEASE_SHA`; its source tag is `create-deepseek-harness-action-v0.7.0`. See the [setup guide](docs/setup.md) for manual setup and recovery.

### Manual installation

Add `DEEPSEEK_API_KEY` under **Settings → Secrets and variables → Actions**, then create `.github/workflows/dsh-review.yml`:

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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.10.3
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.2.1-rc.2
```

Open a non-draft pull request. The Action checks out only the trusted base SHA, reads the pull request through GitHub APIs, and never executes fork code.

For production, pin the complete commit published in the corresponding GitHub Release. Resolve the corresponding immutable release tag to its full SHA after qualification; the installer version and its Action binding are independent release identities. See [Setup](docs/setup.md) for permissions, pinning, checkout rules, and complete templates.

## Core capabilities

| Capability              | What it does                                                                                                |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pull request review     | Reviews new commits, publishes one summary, and adds high-confidence inline findings                        |
| General tasks           | Answers repository questions or performs an explicitly authorized coding task                               |
| CI diagnosis and repair | Reads failed checks and logs; trusted workflows may validate and publish a fix                              |
| Issue implementation    | Turns an authorized Issue request into a validated branch and pull request                                  |
| Composition modes       | Keeps the existing controlled tool profile by default and offers an experimental native DSH mode            |
| Controlled tools        | Adds exact profiles for native, fixed-command, typed Controller GitHub, MCP, Bundle, and Plugin tools       |
| Structured results      | Keeps the schema-v1 audit envelope and can validate an optional maintainer-defined task result              |
| Explicit Session resume | Continues a completed task in a new Actions run using a verified raw DSH checkpoint and current permissions |

The Action provides the experimental `dsh-mode: native` path over the locked DSH `0.2.1-rc.2` runtime and its official ecosystem composition. Native MCP servers, Profile Bundles, direct Cordis Plugins, repository Skills, Subagents, and Workflows retain DSH-native discovery and behavior. `controlled` remains the compatible default, so workflows that omit `dsh-mode` retain their existing composition, permissions, tools, budgets, receipts, and outputs.

Native mode is not an unsafe mode. It returns ownership of DSH's internal headless composition, capability graph, and model-visible inventory to DSH. Native MCP servers load through official `@deepseek-ai/dsh-mcp-client`; Bundles become official Profile layers; direct Plugins load through Cordis; and repository Skills, Subagents, and Workflows retain DSH-native behavior. Its definition-only extension schema declares owners and process requirements, not Action tools, grants, or per-tool budgets. Dynamic ecosystem tools appear only in runtime `observedTools`, and native `toolPolicy` never claims Controller `effectiveTools`.

The Action still owns trusted-workflow admission, exact package pins, lifecycle-script suppression, runtime inventory audit, Docker and `.git`-less workspace boundaries, the run-scoped DeepSeek credential proxy, GitHub credential isolation, actor/repository trust, validation and deferred writes, deadlines, cancellation, and secret redaction. Native remains Docker-only. Bridge network and read/write mounts are whole-worker capabilities, not per-extension or per-tool sandboxes. A user-configured GitHub MCP with its own credential is a trusted external extension whose direct effects do not receive the Controller Gateway's binding, revalidation, validation, or deferred-mutation guarantees. Controller-owned `command.*` and `github.*` capabilities remain a separate, mode-independent plane.

The Action supports [automatic Session creation and continuation by key](docs/session.md), retaining explicit save/resume. A trusted workflow discovers the latest successful compatible checkpoint; failed, unknown, missing, expired or corrupt history prevents silent fallback. Matching workflow identity and concurrency bindings serialize one key while allowing different keys to run concurrently. The existing Controller / DSH / Gateway / validation ownership, exact `0.2.1-rc.2` pin and default-off Session path remain. Current authority is recalculated; previous GitHub writes are not replayed. [Text file context](docs/text-files.md), [offline configuration checks](docs/configuration-check.md) and [bounded GitHub diagnostics](docs/github-requests.md) remain available. Native image and Office attachments remain deferred for the [documented runtime/transport reasons](docs/v0.9.2-runtime-audit.md).

## Live runs

These public runs show the comments and Actions logs produced by this repository.

| Scenario                                                | Run                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR review, including a rerun without duplicate comments | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| Diagnosis based on failed checks and logs               | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| Fix and validation in trusted write mode                | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| Issue implementation followed by a pull request         | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## Common `@dsh` commands

Put the command on the first line of an Issue or pull request comment.

| Command                       | Purpose                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| `@dsh task --read <question>` | Explain code, inspect the repository, or answer a general question |
| `@dsh task --write <task>`    | Request a coding task; every write gate must still pass            |
| `@dsh review`                 | Review the current pull request again                              |
| `@dsh diagnose`               | Diagnose failed checks and logs                                    |
| `@dsh fix`                    | Repair a same-repository pull request in trusted write mode        |
| `@dsh implement`              | Implement an Issue and open a pull request                         |

`--write`, `fix`, and `implement` request capabilities; they do not grant them. The workflow must explicitly enable write mode and provide Controller-run validation. See [Usage](docs/usage.md) for commands and automation, and [Configuration](docs/configuration.md) for the gates.

Maintainers can change the trigger phrase, add label/assignee routes, filter actors or historical comments, select a base branch, and choose a deterministic branch template. These settings change routing and naming only; GitHub authority still comes from the Controller policy and workflow token scopes.

## Security

- The Agent receives neither the real `GITHUB_TOKEN` nor the real DeepSeek key. Only the Controller can call Action-owned `github.*` mutation APIs; an explicitly configured external GitHub MCP uses its own credential and authority as described below.
- Repository content, diffs, issues, pull requests, comments, logs, model output, and tool output remain untrusted data.
- Fork review uses a `.git`-less, credential-free worker and must check out only the trusted base SHA with `persist-credentials: false`.
- Writes require a trusted same-repository context, authorized actors, Docker, `allow-write: "true"`, non-empty fixed validation commands, and successful validation. Protected-path and Validation Integrity checks still apply.
- Typed `github.*` mutations are exact-ID, entity-bound, deferred until Controller validation, and reconciled with bounded receipts. No arbitrary REST, GraphQL, URL, or credential pass-through exists.
- Validation Integrity provides high-confidence weakening detection plus baseline replay for its supported entrypoints, scripts, test/config weakening, lock/toolchain controls, and known wrappers/interpreters; it is not complete cross-language dependency provenance or a formal proof.
- Validation may use Docker bridge networking. On self-hosted or corporate-network runners, repository validation code may reach runner-accessible network services; use dedicated runners and runner-level segmentation/egress controls.
- An approved Bundle, Plugin, or stdio MCP server is trusted worker code. Controlled ToolRuntime limits model-routed calls; native leaves routing and inventory to DSH. Neither model is a sandbox for extension startup, background work, or direct process I/O, and any bridge/RW capability applies to the whole worker.
- `github.*` uses the Controller GitHub Gateway. A separately configured GitHub MCP uses its own external credential and is outside the Gateway's binding, revalidation, validation, and deferred-write guarantees.

Read the complete [Security policy](SECURITY.md) before enabling write mode, host execution, network access, or third-party extensions.

## Documentation

| Guide                                                              | Contents                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| [Setup](docs/setup.md) · [中文](docs/setup.zh-CN.md)               | Installer, manual setup, Secret, permissions, safe checkout, and templates           |
| [Usage](docs/usage.md) · [中文](docs/usage.zh-CN.md)               | `@dsh` commands, tasks, review, diagnose, fix, implement, and automation             |
| [Configuration](docs/configuration.md)                             | Inputs, permission profiles, tools, validation, extensions, and outputs              |
| [Architecture](ARCHITECTURE.md) · [Invariants](docs/invariants.md) | Component ownership, authority boundaries, and stable system invariants              |
| [Troubleshooting](docs/troubleshooting.md)                         | Denials, Docker, timeouts, cancellation, validation, and extension failures          |
| [Security policy](SECURITY.md)                                     | Trust model, credential boundaries, network behavior, and known limitations          |
| [Extension contracts](docs/extension-contracts.md)                 | Deep technical contracts for MCP, Profile, Bundle, Plugin, ToolRuntime, and receipts |
| [Maintainer release guide](docs/maintainer-release.md)             | Local checks, Core E2E, release canary, version updates, and publishing              |
| [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)        | Development workflow and release history                                             |

## Development

Node.js 24 is required.

```bash
npm ci
npm run check
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The Marketplace `dist/` bundle is committed for releases and must not be edited by hand.

## License

[MIT](LICENSE). Third-party licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [BUNDLED_DEPENDENCIES.md](BUNDLED_DEPENDENCIES.md).

DeepSeek Harness supplies the headless runtime and official extension mechanisms. The GitHub integration also draws on the MIT-licensed [Claude Code Action](https://github.com/anthropics/claude-code-action) patterns and the execution/publication separation described by [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action); exact attributions are recorded in the third-party notices.
