#!/usr/bin/env bash
# kenli F-014 T03: the `receipt` job of pages-release.yml (docs/deployment.md §9.5). The deployed
# artifact must be byte for byte the tar of the archived pending site (re-exported and re-packed
# here: the packing is deterministic), the live site must serve every file with its hash, and the
# github-pages deployment of this run must have succeeded — only then the receipt. Environment:
# TAG, VERSION, ANCHOR, PAGE_URL, ARTIFACT_SHA256, GITHUB_TOKEN, SITE_URL, GITHUB_REPOSITORY,
# GITHUB_RUN_ID, RUNNER_TEMP; for the local dry run REMOTE, FACTS, LIVE_DIR, TOOLS, SMOKE_URL.
set -euo pipefail

tools=${TOOLS:-$GITHUB_WORKSPACE/tools}
tmp=$RUNNER_TEMP
remote=${REMOTE:-https://github.com/$GITHUB_REPOSITORY.git}
pages_ci() { bun "$tools/scripts/ci/pages-ci.ts" "$@"; }
publish() { bun "$tools/scripts/publish/cli.ts" "$@"; }

if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${REMOTE:-}" ]; then
  auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)
  echo "::add-mask::$auth"
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
fi
live=()
[ -n "${LIVE_DIR:-}" ] && live=(--live-dir "$LIVE_DIR")
facts=${FACTS:-$tmp/facts-receipt.json}
gh_facts() { # this run's deployment must report success (bounded wait for the status)
  [ -n "${FACTS:-}" ] || pages_ci facts --repo "$GITHUB_REPOSITORY" --workflow pages-release.yml --tag "$TAG" \
    --run-id "$GITHUB_RUN_ID" --out "$facts" --wait-success 300
}

gh_facts
# the archived pending site again (verified, never built) and its tar: equal to what was deployed
work=$tmp/work-receipt-check
r=$(publish retry --remote "$remote" --work "$work" --facts "$facts" "${live[@]}" --anchor "$ANCHOR" --version "$VERSION" --site-out "$tmp/site-again")
[ "$(jq -r .action <<<"$r")" = "redeploy-pending" ] || { echo "receipt.sh: $VERSION is not pending: $r" >&2; exit 1; }
again=$(pages_ci pack --site "$tmp/site-again" --manifest "$work/site-manifest.json" --out "$tmp/artifact-again.tar")
pages_ci verify-tar --tar "$tmp/deployed/artifact.tar" --manifest "$work/site-manifest.json" --sha256 "$ARTIFACT_SHA256"
[ "$(jq -r .sha256 <<<"$again")" = "$ARTIFACT_SHA256" ] || { echo "receipt.sh: the archive's tar is not the deployed one" >&2; exit 1; }
pages_ci smoke --site-url "${SMOKE_URL:-$SITE_URL}" --manifest "$work/site-manifest.json" --rounds "${SMOKE_ROUNDS:-12}" --delay-ms "${SMOKE_DELAY_MS:-15000}"
gh_facts
publish receipt --remote "$remote" --work "$tmp/work-receipt" --facts "$facts" "${live[@]}" --anchor "$ANCHOR" \
  --version "$VERSION" --run-id "$GITHUB_RUN_ID" --page-url "$PAGE_URL" --artifact-digest "sha256:$ARTIFACT_SHA256"
