#!/usr/bin/env bash
# Every check the repository's gate runs, from the public tree alone: no private steps file, no lock, no stamp, no
# logs. The steps are the gate's, in the gate's order, and the first failure stops the run. `readme` is the one step
# the gate does not have; it runs last.
# The test step runs on its own database (TEST_DB_SCOPE, `check` unless the caller sets one), so a hand run or the gate
# on the same branch never shares it.
#   docker compose up -d --wait   (this script does it)   then   npm run check
# The leak step reads LEAK_CHECK_RAW and LEAK_CHECK_NAMES (examples/app/.env.local or the environment) and skips what
# an unset one would check, saying so; `npm run persona:leak -- --require` is the strict form that fails instead.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export TEST_DB_SCOPE="${TEST_DB_SCOPE:-check}"

now() { perl -MTime::HiRes=time -e 'printf "%.3f\n", time' 2>/dev/null || date +%s; }
STARTED="$(now)"

step() {
  local name="$1"
  shift
  echo "==> $name"
  local began
  began="$(now)"
  "$@" </dev/null
  local code=$?
  local took
  took="$(awk -v a="$began" -v b="$(now)" 'BEGIN { printf "%.1fs", b - a }')"
  if [ "$code" -ne 0 ]; then
    echo "check: $name FAILED (exit $code, $took)"
    exit 1
  fi
  echo "    $name ok ($took)"
}

step typecheck npm run --silent typecheck
step lint npm run --silent lint
step db-up docker compose up -d --wait
step test npx vitest run
step build npm run --silent build
# The publishable packages' own build and pack checks exist once scripts/release.mjs does.
step packages bash -c "if [ -f scripts/release.mjs ]; then npm run --silent build:packages && node --test scripts/pack-smoke.test.mjs scripts/release.test.mjs; fi"
step persona bash -c "node --test 'packages/persona/src/**/*.test.mjs' scripts/persona/*.test.mjs"
step env node --test examples/app/scripts/check-env.test.mjs
step public bash -c "node --test scripts/check-public.test.mjs && node scripts/check-public.mjs"
step codemap node scripts/codemap.mjs
step leak npm run --silent persona:leak
step links bash -c "node --test scripts/check-links.test.mjs && node scripts/check-links.mjs"
step docker-static node --test scripts/dockerfile.test.mjs
step readme bash -c "node --test scripts/check-readme.test.mjs scripts/check.test.mjs && node scripts/check-readme.mjs"

echo "check: PASS ($(awk -v a="$STARTED" -v b="$(now)" 'BEGIN { printf "%.1fs", b - a }'))"
