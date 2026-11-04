#!/usr/bin/env bash
# kenli F-014 T03: the `state` job of pages-release.yml (docs/deployment.md §9.3–9.4). Inputs come
# from the environment (validated by `pages-ci.ts resolve`): MODE, TAG, VERSION, TAG_COMMIT, ANCHOR,
# GITHUB_TOKEN, SITE_URL, BASE, GITHUB_REPOSITORY, GITHUB_RUN_ID, RUNNER_TEMP, GITHUB_WORKSPACE.
# Optional for the local dry run: REMOTE (the pages-state repository), FACTS (a stated facts file
# instead of the GitHub API), LIVE_DIR (a local live site), TOOLS (this checkout).
# Writes `deploy=true|false` and `artifact_sha256=…` to $GITHUB_OUTPUT.
set -euo pipefail

tools=${TOOLS:-$GITHUB_WORKSPACE/tools}
tmp=$RUNNER_TEMP
out=${GITHUB_OUTPUT:-/dev/null}
remote=${REMOTE:-https://github.com/$GITHUB_REPOSITORY.git}
pages_ci() { bun "$tools/scripts/ci/pages-ci.ts" "$@"; }
publish() { bun "$tools/scripts/publish/cli.ts" "$@"; }

# git over HTTPS with the job's token, without writing it into a URL or a file (masked in logs)
if [ -n "${GITHUB_TOKEN:-}" ] && [ -z "${REMOTE:-}" ]; then
  auth=$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 -w0)
  echo "::add-mask::$auth"
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.https://github.com/.extraheader" GIT_CONFIG_VALUE_0="AUTHORIZATION: basic $auth"
fi

facts=${FACTS:-$tmp/facts.json}
if [ -z "${FACTS:-}" ]; then
  pages_ci facts --repo "$GITHUB_REPOSITORY" --workflow pages-release.yml --tag "$TAG" --run-id "$GITHUB_RUN_ID" --out "$facts"
fi
live=()
[ -n "${LIVE_DIR:-}" ] && live=(--live-dir "$LIVE_DIR")
work=$tmp/work-state
common=(--remote "$remote" --work "$work" --facts "$facts" "${live[@]}")

# the pre-upload canary: synthetic parent-workspace / private files outside the checkout, unique to
# this run; none may reach the artifact (by content or name), nor any tracked source/config file
canary() {
  local c=$tmp/parent-canary
  mkdir -p "$c/library" "$c/private"
  local nonce
  nonce="${GITHUB_RUN_ID:-local}-$RANDOM-$RANDOM-$(date +%s%N)"
  printf '{"canary":"parent-private %s"}\n' "$nonce" > "$c/kenli-private.json"
  printf '{"canary":"library %s"}\n' "$nonce" > "$c/library/character.json"
  printf 'CANARY_SECRET=%s\n' "$nonce" > "$c/.env"
  printf '# parent workspace %s\n' "$nonce" > "$c/private/notes.md"
  cp "$c/kenli-private.json" "${GITHUB_WORKSPACE:-$tmp}/parent-canary.json"
  echo "$c"
}
pack() {
  mkdir -p "$tmp/pages"
  local r
  r=$(pages_ci pack --site "$tmp/site" --manifest "$work/site-manifest.json" --out "$tmp/pages/artifact.tar" --canary "$(canary)" --source "$tools")
  echo "$r"
  echo "deploy=true" >> "$out"
  echo "artifact_sha256=$(jq -r .sha256 <<<"$r")" >> "$out"
}

case "$MODE" in
  initialize)
    publish initialize "${common[@]}" --base "$BASE" --site-url "$SITE_URL"
    echo "deploy=false" >> "$out"
    echo "Set the repository variable PAGES_STATE_ANCHOR to the anchor above (operator)."
    ;;
  publish)
    publish publish "${common[@]}" --anchor "$ANCHOR" --version "$VERSION" --tag-commit "$TAG_COMMIT" \
      --release "$tmp/candidate/release" --srd "$tmp/candidate/srd" --site-out "$tmp/site"
    pack
    ;;
  retry)
    r=$(publish retry "${common[@]}" --anchor "$ANCHOR" --version "$VERSION" --site-out "$tmp/site")
    echo "$r"
    if [ "$(jq -r .action <<<"$r")" = "redeploy-pending" ]; then pack; else echo "deploy=false" >> "$out"; fi
    ;;
  resolve)
    publish resolve "${common[@]}" --anchor "$ANCHOR" --version "$VERSION"
    echo "deploy=false" >> "$out"
    ;;
  *)
    echo "state-op.sh: mode $MODE" >&2
    exit 2
    ;;
esac
