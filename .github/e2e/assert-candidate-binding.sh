#!/usr/bin/env bash

set -euo pipefail

: "${GH_TOKEN:?}" "${REPOSITORY:?}" "${DEFAULT_BRANCH:?}" "${CANDIDATE_MODE:?}" "${CANDIDATE_SHA:?}"
sha_pattern='^[a-f0-9]{40}$'
[[ "$CANDIDATE_SHA" =~ $sha_pattern ]]

case "$CANDIDATE_MODE" in
  pull-request)
    : "${CANDIDATE_PR:?}"
    [[ "$CANDIDATE_PR" =~ ^[1-9][0-9]*$ ]]
    pr_json="$(gh api "repos/$REPOSITORY/pulls/$CANDIDATE_PR")"
    jq -e --arg sha "$CANDIDATE_SHA" --arg repo "${REPOSITORY,,}" --arg base "$DEFAULT_BRANCH" '
      .state == "open" and .draft == false and .head.sha == $sha and
      (.head.repo.full_name | ascii_downcase) == $repo and
      (.base.repo.full_name | ascii_downcase) == $repo and .base.ref == $base
    ' <<<"$pr_json" >/dev/null
    ;;
  main)
    [[ -z "${CANDIDATE_PR:-}" ]]
    live_sha="$(gh api "repos/$REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha)"
    [[ "$live_sha" =~ $sha_pattern && "$live_sha" == "$CANDIDATE_SHA" ]]
    ;;
  *)
    echo "Unsupported candidate mode: $CANDIDATE_MODE" >&2
    exit 1
    ;;
esac
