# create-deepseek-harness-action

Create safe starter workflows for
[DeepSeek Harness Action](https://github.com/Lixiaoyiao/deepseek-harness-action).

```bash
npm create deepseek-harness-action@latest
```

With no flags in a terminal, the installer guides a **read-only PR Review**
setup. Start anywhere inside an existing Git repository with an `origin`
remote on `github.com`. The installer finds the Git root, identifies the remote,
and checks GitHub CLI availability/login before creating the pinned workflow.
It never creates a remote repository or changes your remotes.

If `gh` is available and logged in, it verifies access to that repository and
checks Secret names. Repository reads and Secret operations explicitly target
`github.com`, even when `GH_HOST` selects an Enterprise host. Existing CLI login
configuration is preserved. You can confirm setting `DEEPSEEK_API_KEY` through hidden
terminal input; the key goes only to `gh secret set` through stdin. It is never
written to a workflow, command argument, shell history, or installer log.
Missing login or failed setup prints the exact next step. Add the Secret through
GitHub **Settings → Secrets and variables → Actions** if you prefer.

Commit and push each require a separate confirmation, both defaulting to **No**.
The optional installer commit contains only `.github/workflows/dsh-review.yml`.
It preserves your edits and untracked files, refuses existing staged changes,
and its local commit runs no repository hooks, filters, validation scripts, or signing program.
Commits and pushes are unsigned; choose manual publication if your repository requires hooks or signing.
Push is a normal, non-force push of that exact commit. It requires the origin's
single push URL to match the verified remote and the remote branch to match the commit's
parent, so earlier unpublished or concurrent commits require manual reconciliation.
It disables automatic tag following for that command; local Git settings are preserved.
Before each remote read or push, it checks Git configuration names and scopes, including
included files. Repository-local and worktree SSH commands, credential/askpass helpers and custom
remote programs are refused; the local commit remains available for manual publication.
Object-reading operations also check for repository alternate-reference programs before starting.
Publication requires Git 2.45 or newer with `--no-lazy-fetch` support. It never fetches missing
objects automatically; if a partial clone lacks required objects, fetch them yourself before
rerunning. Push negotiation and recursive submodule publication are disabled.
Git continues to use your trusted system/global authentication and SSH agent. Host-configured
helpers remain your responsibility; the installer does not copy or log their configuration values.
The workflow must reach the default branch before PR Review can start.

Rerunning the same guided command resumes an identical generated workflow
without overwriting it. Content matching treats Git's LF/CRLF checkout conversion
as equivalent; no other text differences are accepted. Existing file bytes and Git
settings are preserved. Generated workflow text and Git blobs use LF, so a workflow
committed with LF and checked out with CRLF reuses its existing commit. Reuse of a
manually committed CRLF blob is not guaranteed.
It rechecks login and Secret names, preserves an existing
workflow-only commit, and checks whether that commit is already published before
repeating a push. Modified/user-owned workflow files are preserved and require a
manual merge. A successful configuration check covers the starter's immutable
reference and read-only/checkout settings; API acceptance, token scopes, quota,
Docker and the actual review are verified by the first Action run.

External Git/GitHub CLI commands keep a 30-second deadline and bounded output.
Timeout or oversized output terminates their process tree and releases inherited
pipes with bounded cleanup. A failed OS tree-termination request is reported as
uncertain transport cleanup; it never establishes a successful operation.

Use `--advanced` for interactive **PR Review**, **@dsh Coding Commands**,
**Both**, or **Automatic Session** choices and the controlled/native composition
choice. This advanced/manual flow generates files only:

```bash
npm create deepseek-harness-action@latest -- --advanced
```

For non-interactive use, select the workflow mode explicitly. Explicit `--mode`
also keeps manual file generation in a terminal; omitting `--dsh-mode` keeps
`controlled`, without a composition prompt:

```bash
npm create deepseek-harness-action@latest -- --mode both
```

To generate native-mode workflows explicitly:

```bash
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

Valid workflow modes are `review`, `commands`, `both`, and `session`; valid DSH modes are
`controlled` and `native`. Explicit flags and the advanced flow do not add
secrets, commit, push, or open a pull request. Existing workflow files are never
overwritten. Non-terminal or CI use without `--mode` fails immediately without
reading stdin.

Automatic Session creates `.github/workflows/dsh-session.yml` with matching
run-name, concurrency and key bindings, with `queue: max` to retain pending
follow-ups. Commit it to the default branch, dispatch
there with a lowercase key and a new prompt, then reuse the key for follow-ups:

```bash
npm create deepseek-harness-action@latest -- --mode session
```

This starter uses read-only authority and needs `contents: read` and `actions: read`.
It requires no source run ID. A previous failed or unknown run, or a missing,
expired, corrupt or incompatible checkpoint must be reconciled before continuing.
See the [Session contract](../../docs/session.md) for boundaries and explicit usage.

Installer 0.7.0 accepts explicit maintainer-selected write validation:

```bash
npm create deepseek-harness-action@latest -- --mode commands \
  --test-commands '[["node","trusted-tests.mjs"]]' \
  --container-image 'your-reviewed-image@sha256:<64 lowercase hex>'
```

Choose commands and their trusted sources yourself. No repository
scripts are discovered, executed or automatically trusted; no language or
package manager is assumed. Missing options keep the fail-closed placeholder.
Malformed/empty argv, workflow expressions, placeholders and mutable image
references are rejected. Installing these values still requires successful
Controller validation and fresh actor/repository/SHA authorization at runtime.
The installer reports credentials/scopes/quota, Docker/image availability and
repository validation as unchecked.

For an offline static check from a reviewed Action source checkout, use
`npm run check:config -- --config examples/config-check.json` as described in
[Setup](../../docs/setup.md#check-configuration-before-the-first-model-run).

Version `0.7.0` targets formal Action `v0.10.3`. Its Action SHA is not filled in
until the immutable tag, GitHub Release and controlled/native release canary
agree. The installer has a separate source identity and immutable
`create-deepseek-harness-action-v0.7.0` source tag.
Installer source review, exact-source CI/tag, the real guided first run,
qualified tarball, npm publication and fresh anonymous public consumers are
distinct gates.

The verified Action commit is supplied through `DSH_ACTION_RELEASE_SHA` at
pack time. Source templates retain a controlled build token; generated workflows
never use a candidate SHA, floating tag, or branch. Their audited exact DSH pin
is `0.2.1-rc.2`, with controlled as the default and native selected explicitly.

## Maintainer notes: process budgets and recovery

The process adapter owns these limits so guided decisions and Git publication
do not duplicate timing or cleanup rules. It finds the nearest `.git` boundary
through filesystem metadata, accepts only executable files from absolute host
PATH directories outside that repository, and resolves symlinks before spawning
an absolute path. Empty/relative PATH entries and repository-local candidates
are ignored; Windows tools are exe/com files and cleanup uses the system
`System32/taskkill.exe`. Repository cwd is preserved without changing global
PATH. Lookup shares the command's budget and fails before stdin is written.
Its 30-second command deadline covers
Git/GitHub CLI metadata and one-workflow publication; model execution and
validation run elsewhere. The 64 KiB per-stream output cap keeps expected
metadata small and rejects incessant or malformed tool output. POSIX termination
gets a 250 ms graceful interval before killing the process group; this gives
normal shutdown a short opportunity without letting ignored signals block
cleanup. The Windows tree-kill helper has a separate 1500 ms limit so a failed
helper cannot turn the original deadline into an indefinite wait. Pipe disposal
is bounded even when OS tree termination is unconfirmed, and that uncertainty
is surfaced as recovery guidance rather than success.

A failed or timed-out push may have reached the remote. Preserve the local
workflow commit and reconcile the exact remote branch before retrying. Guided
resume checks `ls-remote` first: an exact published commit is recognized without
another push, its expected parent allows the reviewed push, and any other
history stops for manual reconciliation. These budgets do not establish that a
remote effect was rolled back.

## Import local DSH plugins

Run `npm create deepseek-harness-action@latest -- --advanced --import-plugins` in a terminal. The installer reads only package metadata under `DSH_HOME/profiles` (default `~/.dsh/profiles`). It lists third-party package names, installed versions and compatibility with DSH `0.2.1-rc.2`, then asks for the package numbers and confirmation. Use `--dsh-home` for another location.

Enabled npm DSH Bundles can be reinstalled at exact versions in Native mode. Controlled mode also asks for the exact `plugin__owner__tool` names and grants only the selected read-only tools. Packages using arbitrary tool names need Native mode or manual configuration. Local paths, npm aliases, disabled Bundles, incompatible versions and plain dependencies need manual setup; the list explains each case. An undeclared compatibility range is shown as unverified.

The generated workflow enables package installation only after confirmation. It does not copy `.env`, credentials, local Cordis patches, compatibility exceptions or plugin settings. Imported plugins use package defaults and request no extra network or workspace-write access; existing workflow permissions and shared worker mounts still apply. Add any required cloud configuration separately with the existing extension inputs. Fork reviews retain their extension-free configuration.

Native web search and fetch now use the DeepSeek Search/Fetch API through the Controller proxy. Controlled search uses the same Search API; add `native.web-fetch` explicitly under a custom or standard permission profile to enable Fetch. The `base-url` input also selects the upstream for these API routes; `web-search-base-url` remains the legacy Messages-search route. The API model ID for the new Flash catalog entry is `deepseek-flash`.

Controlled automatic import targets read-only Review and Session workflows. Coding-command plugins need manual per-task permission declarations; selecting both workflows imports into Review and leaves Commands unchanged. Native commands retain the existing trusted-context gates, so plugins cannot run for untrusted fork commands.

An explicit custom `web-search-base-url` keeps its legacy Messages-search protocol. The default selects the new Search API. Fetch always uses its separate API grant and `base-url`, including when Fetch is the only selected web tool.
