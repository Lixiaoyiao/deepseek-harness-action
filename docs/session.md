# Session checkpoints and automatic continuation

[中文](zh-CN/session.md) · [Configuration](configuration.md) · [Security](../SECURITY.md)

Session is an explicit opt-in for continuing one portable text task in a later
Actions run. It uses DSH **0.2.0-rc.2** public JSONL persistence and `--session-id`. The checkpoint
contains the complete raw v4 Session log and a provenance manifest. A headless
NDJSON event projection or concatenated GitHub comments is not a Session log.

Copy [the dispatch example](../examples/session.yml) to
`.github/workflows/dsh-session.yml`, commit it to the default branch, and set
`DEEPSEEK_API_KEY`. Pin the complete Action commit published in the formal
Release for production. Dispatch `auto` from the default branch with a
maintainer-selected key. With no recorded history for that key, the Action starts
generation 1. Dispatch the **same workflow** with the same key and mode to continue
the latest successful compatible checkpoint automatically. No source run ID is
needed. The new prompt may ask a follow-up about the same task; a successful
continuation saves the next generation. The result records `selection: created`
or `resumed`, generation and the selected `sourceRunId`.

The [explicit example](../examples/session-explicit.yml) retains `save` and
`resume`. `save` starts a fresh logical key; `resume` requires the exact latest
successful producer's numeric `source_run_id`. Explicit workflows retain their
original concurrency contract. When adopting auto from an explicit workflow,
choose a new workflow file path and a new key. An earlier run without a verifiable
key run-name makes that workflow's history unknown and blocks auto, even if its
artifacts have disappeared.

| Input                    | Meaning                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `session-mode`           | `off` (default), `auto`, `save` or `resume`. `auto` creates or continues by key.                                                     |
| `session-key`            | Maintainer-selected 1–64 ASCII letters, digits, dots, underscores or hyphens. Required when enabled. Auto keys are case-insensitive. |
| `session-source-run-id`  | Explicit successful producer run ID, required only for `resume`. The current verified run attempt is used.                           |
| `session-retention-days` | Default `3`; integer `1`–`7`. Expired state is rejected.                                                                             |

Both controlled and native compositions require `isolation: docker`, a
digest-pinned image and the fixed `/workspace` worker directory. Host execution
cannot provide portable Session cwd identity. A checkpoint is limited to **4 MiB**
of raw log and **16 KiB** of manifest. Session preserves the raw records, including
original stream settlements; it does not silently trim, redact or migrate them.

## Workflow and source binding

For auto, declare this **workflow-level** concurrency and identical run name, and
pass exactly the same required string dispatch input to the Action:

```yaml
run-name: dsh-session-${{ inputs.session_key }}
on:
  workflow_dispatch:
    inputs:
      session_key:
        type: string
        required: true
concurrency:
  group: dsh-session-${{ inputs.session_key }}
  cancel-in-progress: false
# In the single producing Action step:
# with:
#   session-mode: auto
#   session-key: ${{ inputs.session_key }}
```

The group serializes runs of the same logical key; different keys can run in
parallel. Auto normalizes keys to lowercase, matching GitHub's case-insensitive
concurrency groups. A static maintained key is also supported when `session-key`,
the group suffix and the run-name suffix are identical literal values. Other
expressions, mismatched key expressions and cancellation are rejected. Explicit
save/resume workflows continue to use the literal group `dsh-session` with
`cancel-in-progress: false`.

Use exactly one
Session-producing Action step in one statically named job. Matrix producers and
reusable producer jobs are unsupported. Keep Session modes, keys and source run
selection under maintainer control; PR text, issue text, logs and model output
cannot choose them or grant permissions.

The current run's GitHub triggering actor must match its freshly checked
authorization identity. Auto rejects reruns of an old Actions run: use a new
maintainer dispatch. Explicit modes reject a rerun by a different actor. The new
dispatch's actor may differ from the source run.

The Controller freshly verifies the same repository ID, default branch,
immutable workflow revision, workflow path, static job and run attempt. A source
must be a successful same-repository default-branch run; `pull_request` and
`pull_request_target` source runs are rejected. The manifest also binds the task,
key, DSH version, composition, image, extension configuration, generation and
retention window. Issue/PR tasks bind to their entity and operation; automation
tasks bind to their operation and Session key. Follow-up instructions may change.
Changing the repository, task, key or runtime composition requires a fresh key.
The controlled extension digest includes its effective extension tool grants;
if a permission change removes or changes those grants, resume is incompatible
and requires a new key. Changing extension configuration or credentials can also
change the digest. Current permissions are still recomputed for every compatible
resume.

GitHub artifact metadata attests the workflow run, not the job that issued an
artifact. Manifest job and actor fields are checked against current GitHub run
and job metadata; they are not independent server-issued artifact-issuer proof.
The reviewed **whole default-branch workflow** is the trust boundary. Review all
of its steps and referenced actions, including steps able to upload artifacts.

The latest successful generation is the only admissible parent. An older source,
multiple matching checkpoints, rerunning the same claimed attempt, an expired
checkpoint or a conflicting generation fails closed. A retained claim records a
started attempt; a failed or uncertain run is not a resumable producer. Inspect
its result and external effects before selecting a fresh logical key. Automatic
task replay and write retries are not used to recover an ambiguous outcome.

Auto checks the complete available workflow run history by the verified run name
before model startup and again before saving. A previous same-key run with a
failed, cancelled or unknown result blocks automatic continuation, even if an
older successful checkpoint remains. A latest successful run with expired,
missing, damaged or incompatible state also fails; it never becomes a new task
or falls back to an older checkpoint. GitHub concurrency does not guarantee FIFO:
an older request is rejected if a newer same-key request has already started or
finished. Later requests still queued do not prevent the active run from saving.

Discovery is bounded to 1,000 workflow runs, 1,000 repository artifacts and 20
compatible retained checkpoint candidates. Incomplete, duplicated or unavailable
listings fail closed. Retained run names distinguish missing/expired artifacts
from a key with no recorded history. Administrators can delete both runs and
artifacts; automatic discovery cannot reconstruct deleted evidence and does not
promise permanent first-ever detection. Do not delete Session history to retry
an ambiguous task. Reusing an auto key in a different workflow/task/runtime is
incompatible; select a new key after reviewing previous effects.

## Permissions, credentials and retained data

The resumed worker receives freshly computed current permissions. Its startup
policy replaces persisted permission, sandbox and approval settings before the
driver can run. Historical authorization is not restored. Controller GitHub
writes still require authorization, validation, immediate revalidation and
result reconciliation. Previous GitHub writes are not replayed by checkpoint
import. External extensions retain their own credential and side-effect model.

The exporter admits one complete, settled top-level Session. It rejects pending
input, unfinished turns, requests, tools or other tracked operations, child/fork
lineage, incompatible cwd/presets, unknown required events, malformed records,
extra Sessions or generations, symlinks, hardlinks and excessive JSON complexity.
The artifact contains only `manifest.json` and `session.jsonl`; worker home,
configuration and lease files are excluded. Import checks integrity and creates
fresh dedicated storage without overwriting existing state.

This initial checkpoint supports portable text Sessions only. DSH's published
attachment store and tools such as native `read_image` can create durable image
or file references whose bytes live under `DSH_HOME/attachments/v1`, outside the
raw JSONL log. The Action's two-file archive does not carry or hydrate that store
in a fresh worker. It therefore rejects DSH-interpreted image/file content
references during import admission and checkpoint collection, including
references generated by tools in the current run. Saving fails clearly rather
than producing state that restores with missing attachment bytes. Diagnostics
do not disclose the referenced filename or attachment ID. Textual filenames and
ordinary business JSON are not themselves binary attachments.

The native tool graph remains available; this restriction does not disable
`read_image` or imply that DSH lacks image support. Attachment transport,
storage lifecycle and hydration are unfinished Action engineering, separate from
the published Headless input limitation described in the
[runtime audit](v0.9.2-runtime-audit.md#why-images-and-binary-attachments-are-deferred).

This first version does not snapshot child Sessions automatically. Native keeps
its existing tool graph; if a task actually creates subagent/child persistence,
the additional Session makes checkpoint collection fail with a clear diagnostic.
It does not produce a partial parent-only archive. Blocked or failed tasks do not
produce a resumable checkpoint; inspect their claim and effects before starting a
new logical Session.

Before saving and importing, the Controller checks actual known Controller,
extension and proxy credentials, credential fields, recognized token formats and
private keys. Detection rejects the checkpoint with a safe diagnostic. It does
not alter the raw log to obtain a successful result. These checks do **not** prove
that every possible secret in arbitrary third-party event data has been excluded.
The checkpoint retains task text, repository context, model output and tool
results: treat the Actions artifact as retained task data and review extension
output before opting in. The feature adds text Session continuity, not native
image or Office attachment support.

Workflow/run/artifact reads use the existing Controller GitHub client and its
quota audit. Artifact uploads use the separate job-scoped SDK runtime credential;
SDK transport request counts are not included in that client audit. Uploads have
a bounded wait and record uncertain outcomes without replaying tasks or writes.

## Failure recovery

Use the run result and artifact receipt to identify its source run, generation
and checksum. Resume only a latest compatible checkpoint from a successful run.
For expiration or incompatible state, start a new task under a new maintained
key. If a current worker generated a durable image/file reference, checkpoint
collection can fail after tools have run; inspect tool receipts and confirmed
external effects before choosing a new logical Session. No partial attachment
checkpoint is produced. For malformed state or a credential refusal, fix the producing
configuration/output and create a fresh Session; editing raw records would lose
the integrity and lossless restoration guarantee. A configuration-only check
does not establish online provenance, Docker availability or artifact access;
the actual run verifies those requirements before model startup.
