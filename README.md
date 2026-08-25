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

## Core capabilities

| Capability              | What it does                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------- |
| Pull request review     | Reviews new commits, publishes one summary, and adds high-confidence inline findings                  |
| General tasks           | Answers repository questions or performs an explicitly authorized coding task                         |
| CI diagnosis and repair | Reads failed checks and logs; trusted workflows may validate and publish a fix                        |
| Issue implementation    | Turns an authorized Issue request into a validated branch and pull request                            |
| Controlled tools        | Adds exact profiles for native, fixed-command, typed Controller GitHub, MCP, Bundle, and Plugin tools |
| Structured results      | Keeps the schema-v1 audit envelope and can validate an optional maintainer-defined task result        |

v0.7.0 establishes four architecture foundations without widening the public capability surface: the internal `DshComposition` seam (still backed only by `ControlledComposition`), explicit Controller-owned tool-policy audit semantics, a value-free audit of Action-known authority sources, and a transport-only `GitHubToolBackend` seam (still backed by Octokit). It does not add `NativeComposition`, a native DSH ecosystem mode, a GitHub MCP backend, or Session/Resume; the DSH pin remains `0.1.1-rc.2`.

## Live runs

These public runs show the comments and Actions logs produced by this repository.

| Scenario                                                | Run                                                                                                                                                                   |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR review, including a rerun without duplicate comments | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| Diagnosis based on failed checks and logs               | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| Fix and validation in trusted write mode                | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| Issue implementation followed by a pull request         | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## Quick Start

Run the installer from the root of the repository you want to configure:

```bash
npm create deepseek-harness-action@latest
```

Choose one of these modes:

- **PR Review** creates `.github/workflows/dsh-review.yml`.
- **@dsh Coding Commands** creates `.github/workflows/dsh-commands.yml`.
- **Both** creates both workflow files.

For CI or another non-interactive environment, pass the mode explicitly so the installer never waits for stdin:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

The installer creates `.github/workflows/` when needed and refuses to overwrite an existing target workflow. It does not add secrets, commit or push changes, or open a pull request. Installer v0.1.1 generates workflows pinned to the immutable v0.6.0 release commit.

After installation, add `DEEPSEEK_API_KEY` under **Settings → Secrets and variables → Actions**. Open or update a non-draft pull request to trigger Review. For Coding Commands, put an `@dsh` command on the first line of an Issue or pull request comment. See [Setup](docs/setup.md) for the complete onboarding and security guide.

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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.7.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.1.1-rc.2
```

Open a non-draft pull request. The Action checks out only the trusted base SHA, reads the pull request through GitHub APIs, and never executes fork code.

For production, replace `v0.7.0` with the full immutable release commit SHA. See [Setup](docs/setup.md) for permissions, pinning, checkout rules, and complete templates.

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

- The Agent receives neither the real `GITHUB_TOKEN` nor the real DeepSeek key. Only the Controller can call GitHub mutation APIs.
- Repository content, diffs, issues, pull requests, comments, logs, model output, and tool output remain untrusted data.
- Fork review uses a `.git`-less, credential-free worker and must check out only the trusted base SHA with `persist-credentials: false`.
- Writes require a trusted same-repository context, authorized actors, Docker, `allow-write: "true"`, non-empty fixed validation commands, and successful validation. Protected-path and Validation Integrity checks still apply.
- Typed `github.*` mutations are exact-ID, entity-bound, deferred until Controller validation, and reconciled with bounded receipts. No arbitrary REST, GraphQL, URL, or credential pass-through exists.
- Validation Integrity provides high-confidence weakening detection plus baseline replay for its supported entrypoints, scripts, test/config weakening, lock/toolchain controls, and known wrappers/interpreters; it is not complete cross-language dependency provenance or a formal proof.
- Validation may use Docker bridge networking. On self-hosted or corporate-network runners, repository validation code may reach runner-accessible network services; use dedicated runners and runner-level segmentation/egress controls.
- An approved Bundle, Plugin, or stdio MCP server is trusted worker code. ToolRuntime limits model-routed calls; it does not sandbox extension startup, background work, or direct process I/O.

Read the complete [Security policy](SECURITY.md) before enabling write mode, host execution, network access, or third-party extensions.

## Documentation

| Guide                                                       | Contents                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [Setup](docs/setup.md) · [中文](docs/setup.zh-CN.md)        | Installer, manual setup, Secret, permissions, safe checkout, and templates           |
| [Usage](docs/usage.md) · [中文](docs/usage.zh-CN.md)        | `@dsh` commands, tasks, review, diagnose, fix, implement, and automation             |
| [Configuration](docs/configuration.md)                      | Inputs, permission profiles, tools, validation, extensions, and outputs              |
| [Troubleshooting](docs/troubleshooting.md)                  | Denials, Docker, timeouts, cancellation, validation, and extension failures          |
| [Security policy](SECURITY.md)                              | Trust model, credential boundaries, network behavior, and known limitations          |
| [Extension contracts](docs/extension-contracts.md)          | Deep technical contracts for MCP, Profile, Bundle, Plugin, ToolRuntime, and receipts |
| [Maintainer release guide](docs/maintainer-release.md)      | Local checks, Core E2E, release canary, version updates, and publishing              |
| [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) | Development workflow and release history                                             |

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
