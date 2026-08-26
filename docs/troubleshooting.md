# Troubleshooting

[README](../README.md) · [Setup](setup.md) · [Usage](usage.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Start with the GitHub Actions run, not the model's prose or a sticky comment.
The Action conclusion is authoritative. On every terminal path, also check the
step summary and the outputs documented in [Configuration](configuration.md).

Give the Action step an `id`, then inspect `result-json` even when the step
fails:

```yaml
- uses: Lixiaoyiao/deepseek-harness-action@v0.8.1
  id: dsh
  with:
    deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}

- name: Inspect DSH result
  if: ${{ always() && steps.dsh.outputs['result-json'] != '' }}
  env:
    DSH_RESULT_JSON: ${{ steps.dsh.outputs['result-json'] }}
  run: printf '%s\n' "$DSH_RESULT_JSON" | jq .
```

Useful fields are:

- `status`: broad outcome (`denied`, `timed_out`, `validation_failed`, and so on);
- `error.code`: stable specific classification;
- `error.category`: stable `configuration`, `policy`, `domain`, or `runtime`
  semantics for classified errors;
- `error.phase`: `entrypoint`, `configuration`, `routing`, `authorization`,
  `context`, `agent`, `validation`, `publication`, or `write`; this records
  where the error surfaced and does not determine a classified error's
  identity;
- `error.message` and `error.guidance`: redacted, bounded diagnostics;
- `.dsh.mode` and `.dsh.composition`: the selected composition mode and stable
  identity;
- `toolPolicy`: Controller-effective grants for controlled mode or DSH-observed
  inventory telemetry for native mode;
- `permissions`, `isolation`, `validation`, `validationIntegrity`, and `loop`:
  Controller evidence for the effective run; and
- scalar `trust`, `dsh-mode`, `dsh-composition`, `permission-profile`,
  `effective-tools`, `network-access`, `workspace-write`, `error-code`, and
  `error-message`: convenient summaries.

`result-json`, model text, and receipts are observability data, not
authorization or tamper-proof security evidence. Keep their strings in data
channels such as environment variables; do not interpolate them into shell
source.

## The request is denied

Typical signal: `status: denied` or `error-code: POLICY_DENIED`.

Check these in order:

1. Confirm the event is supported and an interactive `@dsh` command starts on
   the first line of the comment or review. See [Usage](usage.md).
2. Confirm every originating actor has write, maintain, or admin permission.
   Permission lookup failures deny authority. For `workflow_run` writes, the
   receiving actor, upstream run actor, and rerun/triggering actor must all pass.
3. Confirm the target is in the same repository. Forks and
   `pull_request_target` are always review-only.
4. For a write, confirm `allow-write: "true"`, `run-tests: "true"`, and a
   non-empty JSON `test-commands` list. `run-tests: "false"` denies the write;
   it never waives validation.
5. Confirm the bound issue, pull request, branch, origin, and full SHA have not
   changed during the run, and that no protected path is being modified.
6. Confirm `workspace.edit` survives the permission profile and exact deny
   list. A workflow token with write scope cannot manufacture an Agent grant.

A denied read-only request creates no progress comment. A write request also
creates no lifecycle or status comment before final Controller validation
succeeds (or a no-change result is confirmed). The absence of a bot comment is
therefore expected for many denials and is not evidence that the Action did not
run.

If the failure is `ACTION_CONFIGURATION`, fix malformed or contradictory inputs
before retrying. If it is `EVENT_ROUTING_FAILED`, fix the event/command pairing
rather than broadening permissions.

### A custom trigger does not route

- Keep the job-level event types and `if` expression aligned with
  `trigger-phrase`, `label-trigger`, or `assignee-trigger`. The Action cannot run
  when the workflow filters the event out first.
- The literal command phrase and operation must be on the first line. A phrase
  found only in quoted or later text is intentionally ignored.
- Check `allowed-actors`; this is a routing filter, not a replacement for the
  repository permission and bot gates.
- Comment include/exclude settings affect historical prompt context only. They
  never remove the audited triggering comment or authorize its actor.
- A custom `base-branch` must exist. Templates must contain `{{prefix}}` and
  `{{key}}`; unknown variables and rendered invalid/oversized refs fail closed.

## A tool is missing or denied

First inspect `dsh-mode`, `dsh-composition`, `trust`, `workspace-write`,
`network-access`, and `result-json.toolPolicy`. For controlled mode, also inspect
`permission-profile`, `effective-tools`, and the permission audit.

Common causes:

- The canonical allow/deny and budget checks below apply to controlled tools.
  Native MCP/Bundle/Plugin inventory is discovered by DSH instead.
- `custom` starts empty. List every required canonical ID in `allowed-tools`.
- With `strict` or `standard`, `allowed-tools` adds requests after preset
  expansion; it does not replace the preset. Use `custom` for an exact minimal
  set.
- `disallowed-tools` always wins over both a preset and `allowed-tools`.
- Declaring a command, MCP server, Bundle, or plugin does not grant its tools.
  The matching `command.*`, `mcp.*`, or `plugin.*` ID must also be allowed.
- The event/actor trust profile can remove a requested tool. Forks receive no
  repository tools. Trusted-read work denies edit, Bash, and subagent.
- `native.bash` and `native.subagent` require eligible trusted-write Docker
  policy. `native.bash` cannot share a worker with a bridge-networked extension.
- `native.web-search` uses a separate Controller-mediated endpoint. It is not
  arbitrary web fetch and does not grant general bridge egress.
- Extension tools require `permission-profile: custom` (with `strict` retained
  only for older v0.4 compatibility), Docker isolation, matching declared
  permissions, and a consistent process-level network/workspace mode.

Those canonical-tool checks describe controlled mode. In native mode, DSH owns
the internal capability graph. `toolPolicy.policyOwner` is `dsh`, and
`observedTools` contains names actually visible to the root DSH Agent. It has no
Controller `effectiveTools` field. Observation is telemetry, not authorization:
seeing `bash`, `read`, or another DSH name does not bypass the Docker mount,
network, credential, trust, validation, or write boundary. Do not compare
`observedTools` with the scalar `effective-tools` output or expect controlled
`workspace.*` aliases there.

`permission-profile` does not select or rename the native composition. Native
MCP, Bundle, and Plugin configuration uses a separate definition-only schema:
declare owners, transports or exact packages, owner-level
`workspaceWrite`/`network`, and MCP's server-level `toolCallTimeoutMs`, but no
`tools`, grants, permissions, call/output budgets, or Action manifests. DSH
loads official MCP/Profile/Cordis mechanisms and decides the inventory. A
native `mcp.*` or `plugin.*` entry in `allowed-tools` / `disallowed-tools`
therefore fails closed. Controller-owned `command.*` and `github.*` tools remain
mode-independent and should still be diagnosed through their existing
canonical IDs, token scopes, and validation gates.

If a native ecosystem tool is absent from `observedTools`, check that the
definition passed schema and trusted-workflow admission, the MCP server started,
the Bundle was added as an official Profile layer, or the direct Plugin loaded
through Cordis. Also check `allow-plugin-install`, exact package pins, Docker
image digest, Action network/write authority, and the extension startup logs.
Do not add a guessed tool grant: the next successful native boot must report the
real dynamic name.

Repository native Skills should live at `.dsh/skills/<name>/SKILL.md` or
`.agents/skills/<name>/SKILL.md`. The worker is intentionally `.git`-less; the
official Skill system discovers those project directories without repository
Git metadata. Native Subagent and Workflow capabilities likewise come from the
locked official graph and are not controlled `native.subagent` aliases.

For controlled and Controller-owned planes, use canonical IDs exactly:

- `workspace.read`, `workspace.search`, `workspace.edit`;
- `native.bash`, `native.web-search`, `native.subagent`;
- `command.<name>`;
- the exact `github.issue.*`, `github.comment.create`,
  `github.pull.metadata.update`, or `github.checks.read` ID;
- `mcp.<server>.<tool>`; and
- `plugin.<extension>.<tool>`.

Unknown controlled IDs, undefined command tools, references to undeclared controlled extension tools,
missing runtime registrations, and tools that remain visible outside the
effective allowlist all fail closed. The model cannot approve a tool, edit its
profile, or expand its own permissions.

For a typed GitHub tool, also confirm the entity matches the operation and the
workflow token has only the required GitHub scope. Mutation tools require
`trusted-write`, `allow-write`, Docker, and configured validation. They are
deferred until finalization; a malformed final result or failed validation
correctly leaves no mutation. `github.checks.read` requires a bound PR or
workflow head and the Controller `readCi` capability. No raw REST or GraphQL
fallback exists.

## Docker or isolation fails

Typical codes include `DSH_ISOLATION_UNAVAILABLE`, `DSH_ENVIRONMENT`, and
`DSH_SPAWN`.

- Verify Docker is installed and the runner account can reach the daemon. A
  read-only check such as `docker version` in an earlier workflow step can make
  runner problems clear.
- Confirm `container-image` is exactly one Docker/OCI image reference. It cannot
  begin with an option or contain argument-breaking whitespace.
- Writes and effective extensions require a full lowercase
  `name@sha256:<64 hex>` digest. A tag is not sufficient for those paths.
- Review the pinned image as executable worker code. A valid digest proves
  identity, not trustworthiness or platform compatibility.
- Untrusted work, trusted writes, and effective MCP/Bundle/Plugin tools cannot
  use `isolation: none`.
- Experimental `dsh-mode: native` always requires `isolation: docker`; native
  fails closed on the host path even for otherwise eligible trusted-read work.
- `dsh-executable` is an absolute-path trusted host compatibility option. It has
  no OS/container boundary and cannot load extensions; it is controlled-mode
  compatibility only. Use it only for an eligible controlled trusted-read run
  on a dedicated trusted runner.
- If an image cannot be pulled, inspect registry access, platform compatibility,
  daemon storage, and the runner's network policy. Do not work around the
  identity check with a mutable image when a digest is required.

The Action workspace is intentionally `.git`-less and run-scoped. Tools should
not expect repository Git metadata or checkout credentials. Keep
`persist-credentials: false`; Controller writes do not depend on credentials
left by checkout.

## The worker cannot reach the API or web search

Typical code: `DSH_PROXY`.

- Verify `DEEPSEEK_API_KEY` is configured and accepted by the selected upstream.
- Verify `base-url` and, when `native.web-search` is effective,
  `web-search-base-url`. Both are trusted destinations that receive the real
  DeepSeek key through the Controller proxy.
- Check API availability, TLS, the runner's outbound policy, and proxy settings.
- Do not put the real DeepSeek key or GitHub token into `prompt`, tool argv,
  extension env/headers/configuration, or validation commands.
- `native.web-search` supports the configured DeepSeek Anthropic Messages route;
  it does not enable arbitrary `web_fetch` requests or general network access.

When extensions declare `network: false`, the DSH worker still reaches the
Controller proxy through an inspected Docker host gateway. That route is not a
port allowlist. Runner firewall policy must protect other host services. When an
approved extension requests network, the co-hosted worker uses bridge egress,
which is not destination-restricted.

## The Action times out

Relevant codes include:

| Code                 | Meaning                                                              | First response                                                                 |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `DSH_TIMEOUT`        | A DSH process exceeded its deadline.                                 | Reduce repository/task scope or increase the Action deadline.                  |
| `AGENT_TIMEOUT`      | The complete multi-turn Agent loop exhausted the remaining deadline. | Reduce task and validation work, or increase `timeout-minutes`.                |
| `VALIDATION_TIMEOUT` | A Controller validation command timed out.                           | Reduce or split validation work; ensure the command does not wait for input.   |
| `AGENT_TURN_LIMIT`   | The loop used `max-turns` before reaching a valid terminal result.   | Make the task narrower or raise `max-turns` within its 1–10 range.             |
| `AGENT_NO_PROGRESS`  | The same workspace revision repeated the same validation failure.    | Fix the validation setup or give the Agent the specific tool/context it lacks. |

`timeout-minutes` covers the overall setup/execution deadline. Runtime
installation, extension installation, each Agent turn, and each validation
phase have their own bounded budgets and also receive only the remaining total
time. Increasing the overall value cannot make an individual extension call
ignore its configured `timeoutMs`.

Set the job timeout a few minutes above the Action timeout. Cleanup and
cancellation-comment finalization have fixed, short best-effort grace periods;
they may extend wall-clock time slightly beyond the Action deadline but cannot
hang indefinitely.

For a controlled extension tool timeout, also check its per-tool `timeoutMs`,
per-tool `maxCalls`, and owner-wide `maxCalls`. Native definitions have none of
those Action budgets; for native MCP, check the server-wide
`toolCallTimeoutMs`, MCP logs, and the overall Action deadline. Same-process
Plugin cancellation is cooperative. The overall Controller deadline is the
hard boundary that can stop an uncooperative worker process.

## Cancellation or a sticky comment remains “In progress”

On `SIGTERM` or `SIGINT`, the Controller aborts the active worker and immediately
attempts a bounded terminal sticky-comment update while run-scoped cleanup
continues. Terminal-state guards prevent queued progress work from replacing a
known result with “In progress.” A later authoritative non-cancellation failure
may correct a provisional cancellation state.

This finalization is best effort. `SIGKILL`, runner/host loss, a process crash,
or a GitHub API/network outage can prevent all cleanup code from running. A
sticky comment can then remain stale. Use the Actions run conclusion as the
source of truth; do not interpret the comment as proof that work is still
running.

The v1 sticky marker names an operation result kind, not a run or head SHA.
Preserve a per-PR, per-Issue, or per-run `concurrency` group in custom workflows
so a slow or hard-cancelled older run cannot overwrite a newer result. If stale
comments are operationally unacceptable, set `progress-comment: "false"` to
disable intermediate lifecycle updates; this does not disable normal final
publication.

## Validation fails and nothing is written

Typical codes: `VALIDATION_FAILED` or `VALIDATION_TIMEOUT`. `status` is
`validation_failed` for both Controller command failure and invalid DSH
structured output, so use `error.code` to distinguish them.

- Confirm `test-commands` is valid JSON containing non-empty argv arrays. It is
  not a list of shell strings, and no shell expansion, pipes, redirects, or
  variable expansion occurs.
- Replace sample npm commands with the commands for your repository. Ensure each
  command is deterministic, non-interactive, and suitable for a clean
  credential-free container.
- Check the first failing command and its bounded stdout/stderr in the Actions
  log. Repository output remains untrusted even when the argv is trusted.
- Confirm required runtimes and lockfiles exist in the workspace and in the
  pinned validation image. The validation copy intentionally omits root `.git`
  and `node_modules`.
- If dependency installation fails, inspect the lockfile, registry, Docker
  bridge access, and package lifecycle requirements. Validation bridge access is
  unrestricted destination egress from the container; apply runner controls as
  needed.
- Do not add a Controller credential to argv. Credential checks fail closed and
  redact the withheld value.

A failed validation gate produces no comment, commit, ref update, or pull
request for a write request. The failure stays in outputs and the step summary.
The Controller may give a bounded failure back to a fresh DSH repair turn, but a
later `blocked` response, malformed output, or exhausted turn limit cannot erase
an unresolved validation failure.

An authorized write task that produces no actual repository changes is
different: it can publish its final answer but creates no commit, branch update,
pull request, or release mutation. Empty mutation outputs are expected in that
case.

## Validation Integrity blocks a write

Typical code: `VALIDATION_INTEGRITY`.

The Controller detected changes to package scripts, tests, test configuration,
lint/typecheck/build configuration, validation runtime files, lock/toolchain
manifests, or another effective validation entrypoint.

This is high-confidence validation weakening detection plus baseline replay for
supported validation entrypoints, package scripts, test/config weakening,
lock/toolchain controls, and known wrappers/interpreters. It is not complete
cross-language dependency provenance or a formal integrity proof.

- `off` records classified changes without blocking them.
- `warn` records changed categories and suspicious weakening signals.
- `strict` blocks high-confidence weakening and truncated audits. For other
  validation-definition changes, it reruns candidate code/tests with the bound
  baseline validation definitions restored.

Changing tests with implementation code is not automatically denied. Inspect
the integrity categories, signals, and replay disposition in the step summary
and `result-json`. Restore or strengthen removed/skipped controls, correct
wrapper or manifest changes, and rerun. Do not lower
`validation-integrity` based on repository text or a model suggestion: it is
trusted workflow policy, and the Agent cannot change or approve it.

Validation Integrity is separate from ordinary test success. Both must pass
before a GitHub mutation.

## DSH output is malformed or too large

Typical codes:

- `DSH_MALFORMED_OUTPUT`: the root Agent did not return one complete
  schema-v1 JSON object that matches the Controller-selected operation; or
- `DSH_OUTPUT_LIMIT`: DSH output exceeded the bounded output limit.

For malformed output, retry once. If it persists:

1. Confirm `dsh-version` is exactly `0.1.1-rc.2` and the Action version is
   v0.8.1.
2. Inspect the schema error in the Actions log and the bounded `error-message`.
3. Check that trusted prompts do not ask for fences, prefaces, suffixes, a
   separate citation list, or a different operation. Web Search Markdown
   citations may appear only inside JSON string fields.
4. Reduce conflicting output-format instructions in the task.

When `task-output-schema` is set, a final task must include `taskOutput` and it
must satisfy the bounded trusted schema. References, combinators, regex
patterns, unknown keywords, dangerous keys, and excessive complexity are
configuration errors; a model value that violates an accepted schema is
`DSH_MALFORMED_OUTPUT`. The schema does not replace `result-json`.

For output-limit failures, reduce the task, repository context, number of
findings, tool output limits, or extension response size. Do not parse a partial
response or bypass Controller schema validation.

## Runtime or extension installation fails

Configuration failures normally appear as `ACTION_CONFIGURATION` or
`DSH_CONFIGURATION`; process startup can appear as `DSH_SPAWN` or
`DSH_PROCESS_FAILED`. Inspect `error.phase` and the immediately preceding
bounded log message.

### DSH runtime

- v0.8.1 accepts only the exact `0.1.1-rc.2` DSH family. Do not use `latest`, a
  range, a floating Git ref, or mixed DSH package versions.
- The runtime installs from the committed lockfile in an ephemeral,
  credential-free container and audits the installed DSH inventory. Registry,
  lockfile, integrity, or version mismatches fail closed.
- Runtime reuse requires the complete audited identity to match. Temporary DSH
  home, npm cache, package state, counters, and receipts are scoped to one
  Action run; do not depend on cross-run mutable state.
- A host `dsh-executable` is not an extension-compatible shortcut and does not
  provide Docker isolation.
- Native uses that same locked runtime's official headless composition. If
  `dsh-mode: native` is combined with host isolation, it is intentionally
  rejected. For ecosystem startup failures, inspect the definition-only
  Profile/Cordis/MCP configuration rather than switching to a controlled tool
  schema.

### MCP

- `mcp-config` must be valid schema-v1 JSON with unique server IDs. Controlled
  mode additionally requires unique declared tool IDs and exact canonical
  references. Native accepts no tool declarations or `mcp.*` grants; DSH
  discovers the inventory.
- `stdio` commands must be an audited bare executable or absolute container
  path outside `/workspace`. Shells, interpreters, package managers, downloaders,
  Git, relative paths, and dynamic runners such as `npx` are rejected.
- `streamable-http` requires HTTP(S), no embedded URL credentials or fragment,
  and network authority. Controlled declares network on the server and every
  tool; native HTTP fixes the owner to `network: true`.
- Every selected/admitted server uses fail-closed startup. Controlled then
  enforces the exact known/allowed/visible contract. Native leaves discovery and
  visibility to the official DSH graph and reports the actual names only in
  `observedTools`.
- Controlled tools and co-hosted owners must have compatible process modes.
  Native owner flags request outer authority: one `network: true` owner gives
  the whole worker bridge egress, while any actual RW mount is likewise shared
  by the complete native worker.
- A native extension's arbitrary-name credential belongs in `credentialEnv`,
  `credentialHeaders`, or direct-Plugin `credentialConfig`; these values are
  merged into that extension and masked/audited without values or hashes.
  Controlled retains its compatible credential-like key detector. The real DeepSeek key and Action
  GitHub token remain forbidden. A user-configured GitHub MCP is external
  extension authority and does not receive Controller GitHub Gateway binding,
  revalidation, validation, deferred mutation, or receipts.

### Bundle and Plugin packages

- Controlled uses `permission-profile: custom` plus an exact canonical tool
  allowlist. Native instead accepts definition-only Bundle/Profile and direct
  Cordis Plugin entries and rejects `plugin.*` grants. Both require
  `isolation: docker`, an immutable digest-pinned `container-image`, and
  `allow-plugin-install: "true"`.
- Each package source must be an exact semver or a GitHub `git+https` URL pinned
  to a lowercase 40-character commit. Ranges, `latest`, floating refs, and
  replacement of Controller-owned DSH packages are rejected.
- Review the package, Bundle patch, and complete transitive dependency graph.
  Npm lifecycle scripts are disabled during acquisition, but package
  installation still uses bridge networking and startup still executes trusted
  code.
- Installation fails if an existing top-level runtime package is removed or its
  version changes, the installed identity/pin differs, or a Bundle patch escapes
  its installed package.
- For native, confirm the Bundle package appears as an official Profile layer
  and that a direct Plugin resolves to its installed module in the Cordis
  patch. Its dynamic tool name must come from `observedTools`, not a configured
  manifest.

Controlled ToolRuntime restricts model-routed calls only; native leaves routing
and inventory to the official DSH graph. Neither path sandboxes an approved
stdio executable, Bundle, or Plugin during initialization, startup, background
work, or direct process I/O. If that code is not trusted at the process level,
do not enable it. See [Extension contracts](extension-contracts.md) for the
exact compatibility and audit rules.

## GitHub publication fails

Typical codes: `PUBLICATION_FAILED` or `WRITE_FAILED`.

- Check the workflow token scopes in [Configuration](configuration.md) and the
  complete templates in [Setup](setup.md). Progress and final comments use the
  same Issue or pull-request write scope.
- Confirm the token belongs to the expected repository and has not been replaced
  with an empty or revoked credential.
- Confirm `bot-user-id` is the numeric ID of the account that owns existing
  sticky comments. User-forged markers and markers from a different bot are
  intentionally ignored.
- For `WRITE_FAILED`, check whether the bound branch, issue, pull request, origin,
  base/head SHA, default branch, or actor authorization changed during the run.
  The Controller revalidates identity immediately before mutation.
- A publication API outage can occur after Agent work completed. Inspect
  `result-json`, but do not manually publish model text without applying the same
  review and security judgment.

The Agent itself cannot push or open a PR and does not receive a GitHub client.
Messages indicating that Git credentials are unavailable inside the worker are
consistent with the security design; authorized mutation must pass back through
the Controller.

## Outputs appear empty

- Give the Action step an `id` and reference that exact ID in later steps.
- Use an `always()` condition because a failed Action step still writes outputs
  before reporting failure.
- `branch-name`, `pull-request-url`, `commit-sha`, and `comment-id` are empty when
  they do not apply. Read-only tasks, entity-free answers, denied/failing writes,
  and successful no-change writes commonly leave some or all of them empty.
- `review-summary` is the backward-compatible alias; prefer `summary` for new
  workflows.
- `task-output` is empty unless a configured task reached a valid final value;
  when present it is JSON data and remains untrusted.
- `dsh-mode` and `dsh-composition` report `controlled` /
  `github-action-controlled`, `native` / `dsh-native-headless`, or `none` when
  composition selection did not complete. The same values appear under
  `result-json.dsh` and in the step summary.
- Parse `effective-tools`, `trusted-extensions`, `tool-receipts`, and
  `result-json` as JSON. Do not treat their encoded text as shell source.
- In native mode, `effective-tools` remains a backward-compatible Action
  permission output and is not DSH inventory. Read
  `result-json.toolPolicy.observedTools` for runtime observation, and never treat
  either surface as a grant.
- Receipt arrays may be truncated to the Action output budget. Check
  `truncated` and `droppedCount`; truncation does not weaken or expand
  authorization.

If `result-json` itself is unexpectedly empty, inspect the earliest workflow
failure. A runner/host kill before Action finalization can prevent any final
output write, just as it can prevent sticky-comment cleanup.

## Cleanup leaves a container behind

Validation and command tools use random named containers with `--rm`. On launch
failure or timeout the Controller also attempts `docker rm --force`, and it
removes temporary workspaces in finalization.

Cleanup is best effort. A hard runner termination or unavailable Docker daemon
can leave a `dsh-action-validation-*` or `dsh-action-tool-*` container. A
self-hosted runner operator can inspect and reap those exact run-scoped
containers after confirming they no longer belong to an active job. A cleanup
failure never grants write authority and should not replace the primary Action
diagnostic.

## Security-sensitive failures

`DSH_CREDENTIAL_LEAK` means a withheld Controller credential appeared in a
worker-bound input or worker output. Stop treating the run as routine:

1. rotate any credential that might have been exposed;
2. inspect the trusted workflow inputs and linked Actions log;
3. remove the secret from `prompt`, validation/tool argv, extension
   configuration, or repository-generated output; and
4. rerun only after the source is understood.

The safety check does not echo the credential. For other suspected boundary
failures, follow the private reporting instructions in
[`SECURITY.md`](../SECURITY.md); do not open a public issue containing live
credentials.

## See also

- [Setup](setup.md)
- [Usage](usage.md)
- [Configuration](configuration.md)
- [Extension contracts](extension-contracts.md)
- [Security policy](../SECURITY.md)
