#!/usr/bin/env bash
# End-to-end checks of one mirror run against live Hyperliquid data (read-only):
# backend (reads the sources, serves the run's targets) → executor (plans and signs a dry run).
# Needs: bun, network. Never sends an order: DRY_RUN stays on.
#
#   ./scripts/e2e-mirror.sh [scenario]     default: ok
#   ./scripts/e2e-mirror.sh all            every scenario below
#
# Scenarios (each must fail closed, except ok, paused and duplicate):
#   ok                   the executor takes the backend's targets, plans and signs a dry run
#   paused               executor paused: the run is recorded as skipped, no plan, no orders
#   backend-down         no backend: the run is recorded as failed, no orders
#   wrong-configuration  executor pins another configuration: the run fails, no orders
#   duplicate            a second trigger for the same run is a no-op
#
# Runs are triggered for the next :x0 with POST /admin/run (the backend builds that early
# because SNAPSHOT_MAX_LEAD_SECONDS=600 here). Set DATABASE_URL to run both services on Postgres.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIGURATION="$ROOT/packages/backend/fixtures/frozen-configuration.json"
CONFIGURATION_HASH="$(bun -e "console.log((await Bun.file('$CONFIGURATION').json()).configurationHash)")"
ACCOUNT="$(bun -e "console.log((await Bun.file('$CONFIGURATION').json()).account)")"
ADMIN_TOKEN="e2e-$RANDOM$RANDOM"
PIDS=()

cleanup() { for pid in "${PIDS[@]:-}"; do { kill "$pid" && wait "$pid"; } 2>/dev/null || true; done; }
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 50); do curl -sf "$1" >/dev/null && return 0; sleep 0.2; done
  echo "service at $1 didn't start"; cat "$LOGS"/*.log; exit 1
}

start_backend() {
  (cd "$ROOT/packages/backend" && PORT=8788 SNAPSHOT_MAX_LEAD_SECONDS=600 CONFIGURATION_PATH="$CONFIGURATION" FROZEN_CONFIGURATION_HASH="$CONFIGURATION_HASH" \
    exec bun run src/server.ts >"$LOGS/backend.log" 2>&1) &
  PIDS+=($!)
  wait_up http://localhost:8788/health
}

start_executor() { # pinned configuration hash
  (cd "$ROOT/packages/executor" && PORT=8787 DRY_RUN=true HL_ACCOUNT="$ACCOUNT" ADMIN_TOKEN="$ADMIN_TOKEN" \
    BACKEND_URL=http://localhost:8788 FROZEN_CONFIGURATION_HASH="$1" \
    exec bun run src/server.ts >"$LOGS/executor.log" 2>&1) &
  PIDS+=($!)
  wait_up http://localhost:8787/health
}

# The next :x0 run time.
RUN_AT="$(bun -e 'const now = Math.floor(Date.now() / 1000); console.log(now - (now % 600) + 600)')"

trigger() { # prints the executor's answer for RUN_AT
  curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "x-operator: e2e" \
    -d "{\"runAt\": $RUN_AT}" http://localhost:8787/admin/run
}

# Checks the run's JSON (stdin) with a JS expression over `run`.
expect_run() { # description, expression
  bun -e "
    const run = JSON.parse(await Bun.stdin.text());
    console.log('  ' + JSON.stringify({ runId: run.runId, status: run.status, orders: run.orders, error: run.error }));
    process.exit(($2) ? 0 : 1);
  " || fail "$1"
}

fail() { echo "FAIL [$SCENARIO]: $*"; echo "logs: $LOGS"; exit 1; }

for port in 8787 8788; do
  if lsof -ti ":$port" >/dev/null 2>&1; then echo "port $port is in use: stop whatever is running there first"; exit 1; fi
done

run_scenario() {
  SCENARIO="$1"
  LOGS="$(mktemp -d)"
  PIDS=()
  echo "== $SCENARIO (run $RUN_AT)"
  case "$SCENARIO" in
    ok)
      start_backend; start_executor "$CONFIGURATION_HASH"
      trigger | expect_run "expected an executed dry run" 'run.kind === "mirror" && run.status === "executed" && run.dryRun === true'
      curl -sf "http://localhost:8787/runs?limit=1" | bun -e '
        const [run] = JSON.parse(await Bun.stdin.text());
        const p = run.plan ?? { orders: [], skipped: [] };
        console.log(`  equity $${run.equityUsd?.toFixed(2)}, ${p.orders.length} orders (${p.orders.filter((o) => o.reduceOnly).length} reduce-only), ${p.skipped.length} skipped, snapshot ${run.evidence?.snapshotHash?.slice(0, 10)}…`);
        process.exit(run.results?.every((r) => r.status === "dry_run") && /^0x[0-9a-f]{64}$/.test(run.evidence?.snapshotHash) ? 0 : 1);
      ' || fail "expected dry-run results and the snapshot hash as evidence"
      ;;
    paused)
      start_backend; start_executor "$CONFIGURATION_HASH"
      curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/admin/pause >/dev/null
      trigger | expect_run "expected skipped_paused with no orders" 'run.status === "skipped_paused" && run.orders === 0'
      ;;
    backend-down)
      start_executor "$CONFIGURATION_HASH"
      trigger | expect_run "expected a failed run naming the backend" 'run.status === "failed" && /backend targets|Unable to connect|ConnectionRefused|fetch failed/i.test(run.error ?? "")'
      ;;
    wrong-configuration)
      start_backend; start_executor "0x$(printf '0%.0s' $(seq 1 64))"
      trigger | expect_run "expected a configuration mismatch" 'run.status === "failed" && /configuration mismatch/.test(run.error ?? "") && run.orders === 0'
      ;;
    duplicate)
      start_backend; start_executor "$CONFIGURATION_HASH"
      trigger >/dev/null
      trigger | expect_run "expected the second trigger to be a duplicate" 'run.status === "duplicate"'
      ;;
    *) echo "unknown scenario: $SCENARIO"; exit 2 ;;
  esac
  echo "PASS [$SCENARIO]"
  cleanup
  sleep 0.5
}

if [ "${1:-ok}" = all ]; then
  for s in ok paused backend-down wrong-configuration duplicate; do run_scenario "$s"; done
else
  run_scenario "${1:-ok}"
fi
