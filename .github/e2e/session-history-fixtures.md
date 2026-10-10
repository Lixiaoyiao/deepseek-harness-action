# Real Session history boundary fixtures

These diagnostics use the trusted default-branch `session-auto-e2e.yml` workflow,
the approved immutable candidate SHA and the existing `core-e2e` environment.
The workflow still has exactly one Session-producing Action step. Its job token
keeps `actions: read`; uploads and the one permitted replacement use the official
artifact SDK's current-job runtime scope, without `findBy` or another credential.

The private local JavaScript Action runs the existing fixture entrypoint with
`node24`. The runner supplies its artifact runtime context directly to this
process; shell `run: node` steps do not receive that context. No runtime token
is exported through `GITHUB_ENV` or persisted. A presence-only check fails with
`SESSION_FIXTURE_RUNTIME_CONTEXT` before any model proof or artifact is read.
CI first runs the same local Action in its private model-free smoke operation:
it uploads one small non-Session file under a unique run/attempt-bound name,
requires the upload digest, checks the current-job artifact ID/name/size, and
compares the optional queried digest when the SDK provides it. Its safe receipt
states whether that metadata digest was observed and compared. It deletes only
that confirmed current-job artifact. The private temporary directory is always removed.
This smoke has no model, Session or checkpoint and never counts as release
Session qualification. Transport uncertainty fails CI without application retry;
unconfirmed ownership never permits deletion by a broader prefix.

Only a first `save` task with a fresh logical key, successful Action output and
an independently decoded checkpoint can seed a fixture. The successful proof is
uploaded before the diagnostic. The helper binds the local proof, Action result,
actor, repository, workflow SHA, branch, run attempt and exact SDK artifact ID/name.
It stores files outside both checkouts and emits only IDs, hashes and binding
metadata. Hidden memory and raw model payloads never appear in fixture logs.
The automatic and explicit preparation entrypoints register their generated or
verified imported memory and challenge with the runner's `add-mask` command
before later steps display their inputs or result environment. Same-job step
outputs and the private oracle files retain their original values; masking does
not change the task schema or independent proof checks. This relies on the
runner's log masker and requires a real CI run to verify the platform behavior.

## Corrupt checkpoint

Dispatch with a fresh `session_key`, `phase=save`, `expected_failure=none` and
`fixture_kind=corrupt`. After the real task qualifies, the helper deletes only
that current run's verified checkpoint and uploads two deliberately malformed
files under the exact same checkpoint name. The original independent successful
proof remains available; a separate safe fixture receipt records the replacement.

Dispatch another run with the same key and runtime mode, `phase=resume`,
`expected_failure=corrupt` and `fixture_kind=none`. The exact candidate must reject
the actual downloaded artifact. The oracle still requires `SESSION_CHECKPOINT`,
failure, no worker start, no task/tools, no checkpoint upload and no writes.

## Orphan provenance denial

Seed with a fresh source `session_key`, `phase=save`, `expected_failure=none`,
`fixture_kind=orphan` and a different fresh `fixture_target_key`. The helper keeps
the source checkpoint, copies its verified payload and rebinds only the manifest
key and automation task identity. It independently computes the complete binding
hash and uploads a real checkpoint for the target key. The source run name keeps
the original source key.

Use the target key for the consumer, the same runtime mode, `phase=auto` (or
`save`), `expected_failure=unknown` and `fixture_source_run_id` equal to the actual
seed run ID. Leave both fixture creation inputs empty/default. This source ID is
used only by the independent oracle; it is never passed to the candidate Action.

Preparation must prove no prior target-key run-name history, a completed
successful source run on the exact trusted workflow SHA, the original successful
Action proof, the SDK fixture receipt and the real checkpoint's server ID/name,
digest and repository/run provenance. It never rewrites the observed history.
Only after those checks does the oracle accept the exact candidate diagnostic
`Automatic Session run-name does not match its verified logical key` as the
orphan provenance denial. It does not claim that the later checkpoint-without-
history branch executed. Ordinary `unknown` cases retain their original matcher,
and every no-execution/no-effect denial check remains mandatory.

## Actual manifest expiry

Seed with a fresh `session_key`, `phase=save`, `expected_failure=none` and
`fixture_kind=expired`. After the actual first task qualifies, the helper changes
only the manifest's `expiresAt` to its original `createdAt + 24 hours`. It keeps
the original `createdAt`, payload and every provenance/runtime/task field. Before
any replacement effect it independently verifies the original manifest hash,
the complete legal retention window and that the new expiry is still in the
future. It deletes only the current job's exact verified checkpoint and uploads
the replacement under the same full binding name with three days of service
retention. The SDK receipt records the actual uploaded archive digest; the
original successful proof and its canonical manifest hash remain separate.

Wait until actual wall-clock time is strictly later than the receipt's
`expiry.expiresAt`. This takes at least a real day from the original checkpoint
creation; the harness has no adjustable short TTL, clock override or fake server
metadata. Do not dispatch the consumer early: an intervening failed same-key run
would become the latest history and invalidate this source selection.

Dispatch the same key and runtime mode with `phase=resume` (or `auto`),
`expected_failure=expired`, `fixture_kind=none` and `fixture_source_run_id` set to
the actual seed run ID. Each consumer runs its own exact approved candidate and
trusted harness SHA. The source ID stays oracle-only and is never an Action input.
Use two different fresh producer keys for candidate and post-merge main proof:
the first consumer's expected failure becomes failed same-key history, so that
key cannot qualify a second consumer.

The historical producer's Action SHA may differ from the consumer's. Its harness
SHA may also differ, but actual Git commit/tree metadata must prove the source
workflow, all three executing helper blobs and the local JavaScript Action
metadata are byte-identical to the current
trusted checkout. The independent Git blob hashes use a fixed path whitelist;
metadata cannot supply a local path or executable command. A changed, missing,
symlink or truncated historical helper tree invalidates the fixture and requires
a new producer. The source proof, receipt and actual source run must agree on
the historical producer identity. The oracle retains its 18-request limit and
performs no read retries; this source check adds only two GET requests. Orphan
fixtures keep their existing exact current-SHA restriction.

The independent consumer must prove that this successful source is the latest
same-key history; source/run/repository/actor bindings match; original Action
proof and fixture receipt match; the real downloaded archive matches the SDK
digest and server metadata; and its payload is unchanged. Restoring only the
original `expiresAt` in the downloaded manifest must recover the original
independently computed manifest hash. The original window must have been legal
and unexpired when prepared, the new window must be exactly 24 hours, and actual
time must now exceed its expiry while the service artifact is still unexpired
and within its verified three-day retention window.

Only this independently verified context permits the exact candidate diagnostic
`Session checkpoint is expired or has an invalid retention window`. The evidence
labels this `manifest-expiry-denial`; it proves the manifest expiry check and
does not claim the `artifact.expired` branch executed. The default server-history
expiry matcher and every `SESSION_CHECKPOINT`, failure, no-worker, no-task,
no-tools, no-checkpoint and no-writes check remain mandatory and unchanged.

## Limits and qualification

Fixture creation cannot be combined with `force_failure` or an expected failure,
and cannot run on reruns, fork refs or established source keys. Artifact SDK
transport uncertainty fails the producer; the helper performs no application
retry and publishes no successful fixture receipt after an uncertain effect.
Use a new source/target key for another attempt and preserve the failed evidence.

Server-history expiry requires genuinely expired server metadata; a service
404 proves only missing. Manifest expiry requires the separately proven real
24-hour transition above. These fixtures do not alter clocks, server metadata,
transport responses or product code. Unit tests verify
the current-run SDK interface and independent oracle boundaries; they do not
qualify a release. New harness changes must pass CI and reach the trusted default
branch before real producer/consumer runs qualify the unchanged exact candidate.
