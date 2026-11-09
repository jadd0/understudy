#!/usr/bin/env bash
# Runs the vitest suite as TEST_SHARDS parallel shards (default 3), each against its own test database
# (TEST_DB_SCOPE=s<i>, see scripts/test-db.mjs). The suite runs files one at a time inside a shard because they
# share that shard's database; splitting the files across databases is what makes the test step parallel.
set -uo pipefail
cd "$(dirname "$0")/.."
n="${TEST_SHARDS:-3}"
mkdir -p gate-logs
pids=()
for i in $(seq 1 "$n"); do
  TEST_DB_SCOPE="s$i" npx vitest run --shard="$i/$n" >"gate-logs/test-shard-$i.log" 2>&1 &
  pids+=("$!")
done
status=0
for i in $(seq 1 "$n"); do
  if wait "${pids[$((i - 1))]}"; then r=PASS; else r=FAIL; status=1; fi
  echo "--- shard $i/$n: $r"
  grep -E "Test Files|Tests |FAIL|×" "gate-logs/test-shard-$i.log" | head -40
done
exit "$status"
