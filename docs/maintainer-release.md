# Maintainer release guide

[README](../README.md) · [Contributing](../CONTRIBUTING.md) · [Security](../SECURITY.md) · [Changelog](../CHANGELOG.md)

This guide is for repository maintainers qualifying and publishing an Action release. A successful run proves only the exact commit SHA it tested. After any candidate change, repeat every required check against the new latest SHA.

## Release invariants

- Work from the latest `main`; the release tag and GitHub Release must ultimately resolve to the same immutable commit.
- Keep the Action version, DSH version, package manifest/lock, metadata, examples, documentation, canary, and committed `dist/` aligned.
- Never hand-edit `dist/`. Build it from source and review the generated diff.
- Keep every directly used `@deepseek-ai/dsh*` package exactly pinned. Do not use `latest`, ranges, floating Git refs, mixed package-family versions, or peer/lock bypass flags.
- Keep Action checkouts pinned with `persist-credentials: false`.
- Keep the real GitHub token and DeepSeek key outside the Agent, repository code, validation, and extensions.
- Publish installer templates only after replacing their controlled build token
  with the full commit SHA resolved from the formal release tag. A candidate or
  guessed SHA is not a production Action reference.
- A published tag is immutable. If its formal smoke fails, do not move the tag; fix forward with the next patch release.

The release constants and direct DSH package inventory live in [`src/release.ts`](../src/release.ts). [`scripts/verify-release-contract.mjs`](../scripts/verify-release-contract.mjs) checks them against the manifest, lock, Action metadata, CI runtime smoke, and release canary.

## Repository environments and variables

Before qualification, configure the `core-e2e` environment:

1. Limit deployment to the default branch.
2. Add `DEEPSEEK_API_KEY` to that environment.
3. Do not expose the secret to the gate jobs; the workflows bind trusted identities before entering the environment.

Both pre-merge and post-merge Core E2E use repository variable `DSH_E2E_CANDIDATE_SHA`. The release canary uses `DSH_RELEASE_CANARY_SHA`. Each must be a lowercase, full 40-character commit SHA for its current purpose.

## Local qualification

Use Node.js 24 and a clean dependency installation:

```bash
npm ci
npm run check
```

`npm run check` runs formatting, lint, type checking, coverage tests, the release-contract check, the DSH configuration audit, and a deterministic `dist` build comparison. Do not skip a failing sub-check.

For v0.6.0, the DSH audit also proves that the exact headless package still
accepts only one text task and creates one text content block. That negative
contract is release evidence for deferring GitHub attachment images; do not
remove it unless a replacement exact DSH multimodal contract and its security
review ship together.

Before committing, inspect the complete diff and confirm that only intended source, test, metadata, documentation, and generated bundle changes are present. For a documentation-only PR, verify explicitly that `src/`, `dist/`, runtime assets, `action.yml`, and package files did not change.

## Version and DSH update checklist

For an Action version bump, update every release surface together:

1. `ACTION_VERSION` / `ACTION_TAG` in `src/release.ts`.
2. `package.json` and the root versions in `package-lock.json`.
3. Release references in `action.yml`, README files, examples, and `CHANGELOG.md`.
4. The release canary workflow name and `RELEASE_TAG`.
5. `dist/`, generated through the normal build.
6. Any release-specific verification fixture or documentation.

The standalone `create-deepseek-harness-action` package has its own semantic
version. Its v0.6.0 companion release is `0.1.1`; do not change it to the Action
version. Keep its package manifest, npm lock/workspace metadata, CLI tests, and
pack-time release-SHA contract aligned.

For a DSH version bump, additionally:

1. Confirm the complete official npm package family is published and that ordinary `npm ci` succeeds with peer and lock validation intact.
2. Update `DSH_VERSION` and every package in `DIRECT_DSH_PACKAGES` to the same exact version, then regenerate the lock normally.
3. Audit the real upstream change range for app-boot, Profile/Bundle/Plugin composition, MCP, ToolRuntime, Bash, Web Search, Subagent, receipts, Docker/path/timeout handling, and the bundled Action entrypoint.
4. Revalidate the controlled Profile, native tool inventory, permission intersections, credential routing, extension locks, runtime reuse, receipts, and cleanup boundaries.
5. Add compatibility and security regression coverage before running the real golden paths.

If the official package family is incomplete or clean `npm ci` cannot consume it, do not use `--legacy-peer-deps`, mix versions, or weaken the lock audit. Leave the current exact DSH pin in place and defer the upgrade.

## Pull request and candidate CI

1. Create a focused release branch from the latest `main`.
2. Run the local qualification commands.
3. Commit and push all source, test, documentation, metadata, lock, and generated `dist` changes together as applicable.
4. Open a PR to `main` and let [CI](../.github/workflows/ci.yml) run on the latest PR head.
5. Resolve every failure. Any new commit invalidates the old CI result; wait for CI on the new head.

Record the exact candidate identity:

```bash
candidate_sha="$(gh pr view "$pr_number" --json headRefOid --jq .headRefOid)"
test "${#candidate_sha}" -eq 40
```

The candidate PR must be open, non-draft, same-repository, and target the default branch.

## Core E2E

The permanent [Core E2E workflow](../.github/workflows/e2e.yml) is trusted release harness code and must already exist on the live default branch. Its secretless gate requires a write-capable actor and binds all of the following before any secret-bearing job starts:

- the workflow and dispatch SHA equal the live default-branch SHA;
- `candidate_sha` is either the current full PR head SHA or, in protected post-merge mode, the live default-branch SHA;
- `DSH_E2E_CANDIDATE_SHA` equals that SHA; and
- pull-request mode binds an open, non-draft, same-repository PR based on the default branch, while main mode rejects a PR number and requires the candidate, dispatch, workflow, and live default-branch SHAs to be identical.

For pre-merge qualification, set the candidate variable and dispatch the trusted workflow from `main` in pull-request mode:

```bash
gh variable set DSH_E2E_CANDIDATE_SHA --body "$candidate_sha"
gh workflow run e2e.yml --ref main \
  -f candidate_mode=pull-request \
  -f candidate_sha="$candidate_sha" \
  -f pull_request="$pr_number"
```

Harness files and fixtures are checked out at the trusted default-branch SHA. Candidate Action code is checked out separately at the bound candidate SHA. Every checkout sets `persist-credentials: false`, and the workflow verifies that no checkout Git credential remains.

The golden paths cover:

| Area                        | Required evidence                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Strict read-only            | Controlled `github-action` Profile and official Bundle identity with no write capability                                                                 |
| MCP                         | Real Streamable HTTP allow and deny paths plus bounded receipts                                                                                          |
| Web Search                  | Real Controller-mediated Web Search without exposing the real key                                                                                        |
| Validation Integrity        | Strict weakening denial with no GitHub mutation                                                                                                          |
| Ordinary validation failure | Failure with no comment, commit, ref, or PR mutation                                                                                                     |
| Subagent                    | Real `native.subagent` through a successful no-change write path                                                                                         |
| Bash trusted write          | `standard` native Bash, validation, and exact branch/PR/commit/file assertions                                                                           |
| Cancellation                | Graceful `SIGTERM` moves the isolated sticky comment from In progress to cancelled, then removes only the fixture comment and closes its temporary Issue |
| Trigger and filters         | Deterministic label, assignee, custom phrase, actor deny, historical-comment exclusion, and triggering-comment retention                                 |
| Branch UX                   | A real task PR targets the candidate branch and uses the configured sanitized prefix/template while retaining the Controller key                         |
| Typed GitHub tools          | All six exact operations: labels, assignees, Issue state, reconciled comment creation, PR metadata, and immutable-head check/status reads                |
| Structured task output      | Trusted bounded schema, final Controller validation, scalar output, and optional field inside the unchanged audit envelope                               |
| Image boundary              | Inline/reference Markdown, HTML image/source, and raw GitHub attachment URLs/tokens are absent from the deterministic LLM request                        |
| Credential isolation        | All candidate and harness checkouts use `persist-credentials: false` and have no residual Git auth configuration                                         |

The workflow also compares `main`, the candidate identity, PR/comments when
present, legacy `dsh/task-*` refs, and Controller-created task PRs on
no-mutation paths. Its
run-bound label, Issue, draft PR, comments, one-file fixture commit, and custom
ref are identity-verified and removed exactly before final candidate
revalidation. Cleanup handles each emitted identity independently, continues
after a per-fixture failure, and never performs a broad deletion.

Graceful cancellation is the verifiable path. `SIGKILL`, runner/host loss, a process crash, or GitHub API/network loss can prevent all finalizers from running; Core E2E must not claim otherwise.

If Core E2E finds a bug, fix it on the PR, obtain the new head SHA, update the variable, rerun CI, and dispatch Core E2E again. Never use an older candidate run as evidence for the new head.

## Merge and qualify `main`

After candidate CI and pre-merge Core E2E pass:

1. Reconfirm the PR head SHA has not moved.
2. Merge the PR into `main`.
3. Record the resulting full `main` SHA as `release_sha`.
4. Wait for the `push` CI run on that exact `main` SHA.
5. Verify the working tree and release metadata contain the expected version and generated bundle.
6. Set `DSH_E2E_CANDIDATE_SHA` to `release_sha` and run the complete protected Core E2E workflow in `main` mode:

   ```bash
   gh variable set DSH_E2E_CANDIDATE_SHA --body "$release_sha"
   gh workflow run e2e.yml --ref main \
     -f candidate_mode=main \
     -f candidate_sha="$release_sha"
   ```

7. Wait for every Core E2E job, including final candidate binding, to succeed against that exact SHA.

Do not tag while final `main` CI or post-merge Core E2E is pending or failing. If
`main` moves, the old run is not release evidence: record the new SHA, repeat
push CI and the complete `main`-mode Core E2E, and tag only that newly qualified
commit.

## Tag and GitHub Release

Create the release tag at the qualified `main` commit. An annotated tag is preferred because the canary deliberately resolves either annotated or lightweight tags to their final commit.

```bash
git tag -a "vX.Y.Z" "$release_sha" -m "vX.Y.Z"
git push origin "vX.Y.Z"
gh release create "vX.Y.Z" --verify-tag --title "vX.Y.Z" --notes-file release-notes.md
```

Release notes should summarize user-visible changes, security implications, compatibility, tests/E2E, performance evidence, and known limitations. Confirm the GitHub Release is neither draft nor prerelease unless that status is intentional for a non-final release.

## Release canary and formal tag smoke

The [release canary](../.github/workflows/release-canary.yml) runs every Wednesday at 05:17 UTC and can also be dispatched manually. Its secretless gate requires:

- `refs/heads/main`;
- the run SHA and workflow SHA to equal live `main`; and
- `main` to remain the default branch.

The protected `core-e2e` smoke job then checks that the configured release Tag, its non-draft/non-prerelease GitHub Release, and `DSH_RELEASE_CANARY_SHA` all resolve to the same commit. It checks out that immutable commit with `persist-credentials: false` and runs one `strict`, read-only, no-tools task with no mutation scope.

Set the variable to the formal tag's final commit and dispatch from `main`:

```bash
gh variable set DSH_RELEASE_CANARY_SHA --body "$release_sha"
gh workflow run release-canary.yml --ref main
```

Wait for the run and record its URL and conclusion. Pre-merge Core E2E, post-merge Core E2E, and `main` CI do not replace this formal-tag smoke; conversely, the one-task post-release smoke does not replace full post-merge Core E2E before tagging.

If the smoke fails after publication, keep the tag immutable. Diagnose the failure, prepare the next patch release from `main`, and repeat the complete latest-SHA qualification flow.

## Publish the npm create package

Publish `create-deepseek-harness-action` only after the formal Action tag,
GitHub Release, and release canary all resolve to `release_sha`. A Git commit
cannot safely contain its own not-yet-known object ID, so the source package
uses one controlled build token. When an installer patch follows the Action
release, keep two identities: `release_sha` is the immutable Action commit
written into generated workflows, while `installer_source_sha` is the reviewed
commit containing the installer manifest, tests, and documentation. Create an
immutable `create-deepseek-harness-action-vX.Y.Z` source tag after CI succeeds
on that exact installer commit. Never move either tag or publish a tarball from
an unreviewed working tree, with an unresolved token, or with a floating Action
reference.

First verify the published Action release identity and the installer source tag,
then create a detached staging checkout. Each tag-resolution loop accepts an
annotated or lightweight tag and must end at its expected commit:

```bash
release_tag="vX.Y.Z"
installer_tag="create-deepseek-harness-action-v0.1.1"
sha_pattern='^[0-9a-f]{40}$'
[[ "$release_sha" =~ $sha_pattern ]]
[[ "$installer_source_sha" =~ $sha_pattern ]]

release_json="$(gh api "repos/$GITHUB_REPOSITORY/releases/tags/$release_tag")"
jq -e --arg tag "$release_tag" '
  .tag_name == $tag and .draft == false and .prerelease == false
' <<<"$release_json" >/dev/null

ref_json="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$release_tag")"
object_sha="$(jq -r '.object.sha' <<<"$ref_json")"
object_type="$(jq -r '.object.type' <<<"$ref_json")"
for _ in 1 2 3 4 5; do
  [[ "$object_type" != "tag" ]] && break
  tag_json="$(gh api "repos/$GITHUB_REPOSITORY/git/tags/$object_sha")"
  object_sha="$(jq -r '.object.sha' <<<"$tag_json")"
  object_type="$(jq -r '.object.type' <<<"$tag_json")"
done
[[ "$object_type" == "commit" && "$object_sha" == "$release_sha" ]]

installer_ref_json="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$installer_tag")"
installer_object_sha="$(jq -r '.object.sha' <<<"$installer_ref_json")"
installer_object_type="$(jq -r '.object.type' <<<"$installer_ref_json")"
for _ in 1 2 3 4 5; do
  [[ "$installer_object_type" != "tag" ]] && break
  installer_tag_json="$(gh api "repos/$GITHUB_REPOSITORY/git/tags/$installer_object_sha")"
  installer_object_sha="$(jq -r '.object.sha' <<<"$installer_tag_json")"
  installer_object_type="$(jq -r '.object.type' <<<"$installer_tag_json")"
done
[[ "$installer_object_type" == "commit" && "$installer_object_sha" == "$installer_source_sha" ]]

installer_stage="$(mktemp -d)"
git worktree add --detach "$installer_stage/source" "$installer_source_sha"
mkdir "$installer_stage/pack" "$installer_stage/unpacked" "$installer_stage/smoke"
```

Pack with the verified SHA as the only production substitution input. The
package's pack step must reject a missing, uppercase, short, or otherwise
invalid value:

```bash
pack_json="$(
  DSH_ACTION_RELEASE_SHA="$release_sha" \
    npm pack "$installer_stage/source/packages/create-deepseek-harness-action" \
      --silent --json --pack-destination "$installer_stage/pack"
)"
tarball="$installer_stage/pack/$(jq -r '.[0].filename' <<<"$pack_json")"
test -f "$tarball"
tar -xzf "$tarball" -C "$installer_stage/unpacked"
```

Inspect the packed artifact, not only the source tree. It must contain version
`0.1.1`, expose the `create-deepseek-harness-action` executable, contain no
unresolved release token or floating `v0.6.0` Action reference, and generate
exactly two workflows bound to `release_sha` in a non-interactive smoke run:

```bash
node --input-type=module - "$installer_stage/unpacked/package/package.json" <<'NODE'
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(process.argv[2], "utf8"));
assert.equal(manifest.name, "create-deepseek-harness-action");
assert.equal(manifest.version, "0.1.1");
assert.ok(manifest.bin?.["create-deepseek-harness-action"]);
NODE

! grep -R -E '__[A-Z0-9_]*RELEASE[A-Z0-9_]*__|Lixiaoyiao/deepseek-harness-action@(v[0-9]|main|latest)' \
  "$installer_stage/unpacked/package"

(
  cd "$installer_stage/smoke"
  npm exec --yes --package "$tarball" -- \
    create-deepseek-harness-action --mode both
)

test "$(find "$installer_stage/smoke/.github/workflows" -type f -name '*.yml' | wc -l)" -eq 2
while IFS= read -r workflow; do
  grep -F "uses: Lixiaoyiao/deepseek-harness-action@$release_sha" "$workflow"
  ! grep -E 'Lixiaoyiao/deepseek-harness-action@(v[0-9]|main|latest)' "$workflow"
done < <(find "$installer_stage/smoke/.github/workflows" -type f -name '*.yml')
```

Only after those checks pass, authenticate to the official npm registry and
publish that exact tarball. Do not publish from the source directory because
that would rerun packing with an unreviewed environment:

```bash
npm whoami --registry=https://registry.npmjs.org/
npm publish "$tarball" --access public --registry=https://registry.npmjs.org/
npm view create-deepseek-harness-action@0.1.1 \
  name version dist-tags --json --registry=https://registry.npmjs.org/
```

Run one final `npm create deepseek-harness-action@latest -- --mode both` smoke
from an empty temporary directory against the public registry. Confirm the two
generated workflow files still contain only `release_sha`, parse as YAML, and
retain the required checkout, permission, Docker, validation, and credential
boundaries. Then remove the disposable worktree and staging directory. npm
versions and the release tag are immutable; a bad published installer must be
fixed with a new installer patch version rather than replacing `0.1.1`.
