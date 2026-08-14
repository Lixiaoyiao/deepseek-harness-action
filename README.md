# DeepSeek Harness for GitHub

**AI Code Review · CI Diagnosis · Auto Fix · Issue → PR**

`dsh-action` adapts the mature GitHub integration architecture of
[`anthropics/claude-code-action`](https://github.com/anthropics/claude-code-action)
to current `@deepseek-ai/dsh` headless execution. It keeps GitHub event routing,
actor permission checks, trigger-time snapshots and controller-side finalization,
then replaces Claude SDK execution with an isolated DeepSeek Harness worker.

> Developer preview. `@deepseek-ai/dsh` is currently pinned to `0.1.0-rc.6`.

This repository is a standard Node 24 JavaScript Action: `action.yml` and the
committed `dist/` bundle are ready to tag for Marketplace publication.

## Features

- Automatic high-precision review on `opened`, `synchronize`,
  `ready_for_review` and `reopened`.
- Exact `@dsh review`, `@dsh diagnose`, `@dsh fix` and `@dsh implement`
  command routing.
- Host-fetched, bounded and redacted Actions logs for CI root-cause diagnosis.
- Trusted same-repository fixes and issue-to-PR implementation with tests.
- Unified-diff to GitHub line mapping, stable finding fingerprints, sticky
  summaries and rerun deduplication.
- Strict TypeScript, Zod runtime schemas, timeout/output limits and partial
  GitHub publication fallbacks.

Same-repository trusted reviews give DSH read/search access to an immutable,
`.git`-less API snapshot. Trusted write runs additionally enable editing, but
DSH never gets a shell; operator-configured tests run later in a separate
credential-free container. Fork reviews receive no filesystem or execution
tools. The current stock headless bundle does not include LSP, so v0.1 does not
claim LSP verification.

## Quick start

Automatic review with a trusted workflow and a bounded PR context packet:

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
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
      # Replace the zero SHA with an audited immutable dsh-action commit.
      - uses: your-org/dsh-action@0000000000000000000000000000000000000000
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

The standalone template is in [`examples/fork-review.yml`](examples/fork-review.yml).
Automatic `pull_request_target` review never checks out the PR head. A confirmed
same-repository PR from a write-authorized actor may use read/search against the
controller-materialized immutable snapshot; fork and untrusted-actor reviews
receive only the bounded context packet and no repository tools. Never check out
or run the PR head in a privileged workflow. Commands and CI examples are in
[`examples/commands.yml`](examples/commands.yml) and
[`examples/ci-diagnose.yml`](examples/ci-diagnose.yml). Trusted workflow-run
auto-fix, with validation and immutable-reference placeholders, is in
[`examples/ci-auto-fix.yml`](examples/ci-auto-fix.yml).

## Commands

The triggering issue/PR conversation comment must start with exactly one command:

```text
@dsh review
@dsh diagnose
@dsh fix
@dsh implement
```

Only the triggering command line and trusted workflow `prompt` are interpreted
as instructions. Repository content is always data. Mention commands require
write access from every originating actor; automatic fork review remains
available through the separate review-only workflow.

The controller can parse `pull_request_review` and `pull_request_review_comment`
webhooks for API/App integrations, matching the Claude Action state machine.
The bundled secret-bearing workflow deliberately uses only `issue_comment`,
because GitHub loads review-event workflow YAML from the PR merge revision.

## Write mode

`allow-write` is `false` by default. When true, write is still denied unless all
originating actors have write access and the target is the same repository.
Forks, unresolved PR origins and `pull_request_target` never gain write tools.
Every actual trusted-write run also requires `container-image` to be a complete
immutable `name@sha256:<64 lowercase hex>` reference. The default image is the
same audited Node 24.18.0 digest exercised by CI; review/diagnosis may accept an
explicit tag override, but doing so weakens runtime reproducibility.

When `run-tests` is true but `test-commands` is empty, write mode fails closed.
Set `run-tests: "false"` explicitly only when an **unverified** change is
acceptable; otherwise configure concrete argv arrays. The default combination
is intentionally a write interlock: review/diagnosis still work, while `fix`
and `implement` cannot commit, update a branch or create a PR until validation
is explicitly configured (or explicitly disabled).

`test-commands` is a JSON array of argv arrays. No command is shell-expanded:

```yaml
with:
  allow-write: "true"
  test-commands: '[["npm","ci","--ignore-scripts"],["npm","test"],["npm","run","typecheck"]]'
  container-image: node@sha256:0000000000000000000000000000000000000000000000000000000000000000
```

Replace the zero digest with the audited Node image digest you deploy. For
Marketplace workflows, pin the action by immutable commit as well. Docker must
be available on the runner.

## Architecture

The controller follows Claude Code Action's `prepare -> route -> authorize -> run -> finalize`
lifecycle. Modules are split across `github`, `commands`, `security`,
`dsh`, `review`, `diff`, `ci` and `write`. DSH is an untrusted-output worker; it
does not receive an Octokit client or GitHub token.

See [`SECURITY.md`](SECURITY.md), [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
and [`BUNDLED_DEPENDENCIES.md`](BUNDLED_DEPENDENCIES.md), plus the action inputs
in [`action.yml`](action.yml).

## Development

Requires Node 24.

```bash
npm ci
npm run check
```

`dist/` is generated with `@vercel/ncc` and committed for Marketplace releases.
The CI gate runs strict formatting/lint/type checks, the full coverage suite,
and a clean rebuild check so stale Marketplace bundles cannot pass.

## License

MIT. Portions are derived from Claude Code Action under its MIT license; exact
attribution and the pinned upstream source commit are in
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
