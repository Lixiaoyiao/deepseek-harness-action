# Real Session history boundary fixtures

These diagnostics use the trusted default-branch `session-auto-e2e.yml` workflow,
the approved immutable candidate SHA and the existing `core-e2e` environment.
The workflow still has exactly one Session-producing Action step. Its job token
keeps `actions: read`; uploads and the one permitted replacement use the official
artifact SDK's current-job runtime scope, without `findBy` or another credential.

Only a first `save` task with a fresh logical key, successful Action output and
an independently decoded checkpoint can seed a fixture. The successful proof is
uploaded before the diagnostic. The helper binds the local proof, Action result,
actor, repository, workflow SHA, branch, run attempt and exact SDK artifact ID/name.
It stores files outside both checkouts and emits only IDs, hashes and binding
metadata. Hidden memory and raw model payloads never appear in fixture logs.

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

## Limits and qualification

Fixture creation cannot be combined with `force_failure` or an expected failure,
and cannot run on reruns, fork refs or established source keys. Artifact SDK
transport uncertainty fails the producer; the helper performs no application
retry and publishes no successful fixture receipt after an uncertain effect.
Use a new source/target key for another attempt and preserve the failed evidence.

Expired history requires genuinely expired server metadata. These fixtures do
not alter time, metadata, transport responses or product code. Unit tests verify
the current-run SDK interface and independent oracle boundaries; they do not
qualify a release. New harness changes must pass CI and reach the trusted default
branch before real producer/consumer runs qualify the unchanged exact candidate.
