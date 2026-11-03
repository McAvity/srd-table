#!/usr/bin/env bash
# kenli F-014 T03: the fresh build of the two public repositories (docs/deployment.md §9.2), as CI and
# pages-release.yml run it and as the local dry run repeats it. Sibling checkouts:
#   <dir>/srd-table              this repository (the tag's commit)
#   <dir>/srd-rules-engine-main  the engine at ENGINE_COMMIT (scripts/engine-pin.ts)
# Usage: scripts/ci/build.sh <srd-table dir> [--app-version V --out DIR [--report FILE]] [--skip-tests]
# Lockfile installs only (npm ci); nothing from a cache is a source of dist/ or of the release.
set -euo pipefail

table=$(cd "$1" && pwd)
shift
engine=$(cd "$table/../srd-rules-engine-main" && pwd)
version=""
out=""
report=""
skip_tests=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app-version) version="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --report) report="$2"; shift 2 ;;
    --skip-tests) skip_tests=1; shift ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

clean() { # a checkout with no change at all (tracked or untracked, ignored files aside)
  if [ -n "$(git -C "$1" status --porcelain --untracked-files=all)" ]; then
    echo "build.sh: $1 is not clean:" >&2
    git -C "$1" status --porcelain --untracked-files=all >&2
    exit 1
  fi
}

pin=$(sed -n 's/^export const ENGINE_COMMIT = "\([0-9a-f]\{40\}\)";$/\1/p' "$table/scripts/engine-pin.ts")
[ -n "$pin" ] || { echo "build.sh: no ENGINE_COMMIT pin" >&2; exit 1; }
[ "$(git -C "$engine" rev-parse HEAD)" = "$pin" ] || { echo "build.sh: engine is not at the pin $pin" >&2; exit 1; }
clean "$table"
clean "$engine"

echo "::group::engine: npm ci, build"
(cd "$engine" && npm ci --no-audit --no-fund && npm run build)
echo "::endgroup::"
clean "$engine"

echo "::group::table: npm ci, engine:verify, content"
(cd "$table" && npm ci --no-audit --no-fund && npm run engine:verify && npm run content)
echo "::endgroup::"

if [ "$skip_tests" = 0 ]; then
  echo "::group::table: lint, typecheck, tests"
  (cd "$table" && npm run lint && npm run typecheck && npx vitest run)
  echo "::endgroup::"
fi
clean "$table"

if [ -n "$out" ]; then
  echo "::group::release ${version:-(no version)}"
  args=(scripts/release.ts --base /srd-table/ --out "$out")
  [ -n "$version" ] && args+=(--app-version "$version")
  [ -n "$report" ] && args+=(--report "$report")
  (cd "$table" && bun "${args[@]}")
  echo "::endgroup::"
fi
clean "$table"
clean "$engine"
