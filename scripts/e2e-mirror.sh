#!/usr/bin/env bash
# End-to-end checks of the CRE mirror path against live Hyperliquid data (read-only):
# backend snapshot service → cre workflow simulate mirror → executor (verify, plan, dry run).
# Needs: bun, the cre CLI (logged in), network. Never sends an order: DRY_RUN stays on.
#
#   ./scripts/e2e-mirror.sh [scenario]     default: ok
#   ./scripts/e2e-mirror.sh all            every scenario below
#
# Scenarios (each must fail closed, except ok and paused):
#   ok                   report delivered, executor plans and signs a dry run
#   paused               executor paused: report accepted, run skipped, no orders
#   backend-down         no snapshot service: the run fails, nothing reaches the executor
#   executor-down        no executor: the run fails
#   wrong-configuration  executor pins another configuration: HTTP 422
#   tampered-snapshot    a proxy inflates every source's equity: spot-check fails
#
# Set DATABASE_URL to run both services on Postgres.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRE="${CRE:-$(command -v cre || echo "$HOME/.cre/bin/cre")}"
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

start_backend() { # port
  (cd "$ROOT/packages/backend" && PORT="$1" SNAPSHOT_MAX_LEAD_SECONDS=600 CONFIGURATION_PATH="$CONFIGURATION" FROZEN_CONFIGURATION_HASH="$CONFIGURATION_HASH" \
    exec bun run src/server.ts >"$LOGS/backend.log" 2>&1) &
  PIDS+=($!)
  wait_up "http://localhost:$1/health"
}

start_executor() { # pinned configuration hash
  (cd "$ROOT/packages/executor" && PORT=8787 VERIFY_REPORTS=false DRY_RUN=true HL_ACCOUNT="$ACCOUNT" ADMIN_TOKEN="$ADMIN_TOKEN" \
    MAX_REPORT_LEAD_SECONDS=600 FROZEN_CONFIGURATION_HASH="$1" WORKFLOW_OWNER=0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85 \
    exec bun run src/server.ts >"$LOGS/executor.log" 2>&1) &
  PIDS+=($!)
  wait_up http://localhost:8787/health
}

# Forwards :8788 to the backend on :8789, doubling every source's equity in the snapshot.
start_tampering_proxy() {
  bun -e '
    Bun.serve({ port: 8788, async fetch(req) {
      const res = await fetch("http://localhost:8789" + new URL(req.url).pathname);
      if (!res.ok || !new URL(req.url).pathname.startsWith("/snapshots/")) return res;
      const snap = await res.json();
      for (const s of snap.sources) s.equityE6 = (BigInt(s.equityE6) * 2n).toString();
      return Response.json(snap);
    } });' >"$LOGS/proxy.log" 2>&1 &
  PIDS+=($!)
  wait_up http://localhost:8788/health
}

simulate() { # sets SIM_OK and SIM_LOG
  SIM_LOG="$LOGS/simulate.log"
  if (cd "$ROOT/packages/cre-workflows" && "$CRE" workflow simulate mirror --target staging-settings --trigger-index 0 --non-interactive) \
    >"$SIM_LOG" 2>&1; then SIM_OK=1; else SIM_OK=0; fi
  grep -E "USER LOG|execution failed" "$SIM_LOG" | sed 's/^/  /' || true
}

# Prints the executor's run for the simulated runId (empty JSON array if none).
executor_run() {
  local run_id
  run_id="$(grep -A1 "Workflow Simulation Result" "$SIM_LOG" | tail -1 | tr -d '" ')"
  for _ in $(seq 1 100); do
    RUNS="$(curl -sf 'http://localhost:8787/runs?limit=50' | RUN_ID="$run_id" bun -e \
      'console.log(JSON.stringify(JSON.parse(await Bun.stdin.text()).filter((r) => r.runId === process.env.RUN_ID)))')"
    [ "$RUNS" != "[]" ] && break
    sleep 0.2
  done
  echo "$RUNS"
}

fail() { echo "FAIL [$SCENARIO]: $*"; echo "logs: $LOGS"; exit 1; }
expect_failure() { # message pattern
  [ "$SIM_OK" = 0 ] || fail "simulation should have failed"
  grep -q -E "$1" "$SIM_LOG" || { cat "$SIM_LOG"; fail "expected an error matching: $1"; }
}

for port in 8787 8788 8789; do
  if lsof -ti ":$port" >/dev/null 2>&1; then echo "port $port is in use: stop whatever is running there first"; exit 1; fi
done

run_scenario() {
  SCENARIO="$1"
  LOGS="$(mktemp -d)"
  PIDS=()
  echo "== $SCENARIO"
  case "$SCENARIO" in
    ok)
      start_backend 8788; start_executor "$CONFIGURATION_HASH"; simulate
      [ "$SIM_OK" = 1 ] || { cat "$SIM_LOG"; fail "simulation failed"; }
      executor_run | bun -e '
        const [run] = JSON.parse(await Bun.stdin.text());
        if (!run) { console.log("  no executor run for this report"); process.exit(1); }
        const p = run.plan ?? { orders: [], skipped: [] };
        console.log(`  run ${run.runId}: ${run.status}, dryRun=${run.dryRun}, equity $${run.equityUsd?.toFixed(2)}, ${p.orders.length} orders (${p.orders.filter((o) => o.reduceOnly).length} reduce-only), ${p.skipped.length} skipped`);
        process.exit(run.status === "executed" && run.dryRun && run.results?.every((r) => r.status === "dry_run") ? 0 : 1);
      ' || fail "expected an executed dry run"
      ;;
    paused)
      start_backend 8788; start_executor "$CONFIGURATION_HASH"
      curl -sf -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8787/admin/pause >/dev/null
      simulate
      [ "$SIM_OK" = 1 ] || { cat "$SIM_LOG"; fail "a paused executor should still accept the report"; }
      executor_run | bun -e '
        const [run] = JSON.parse(await Bun.stdin.text());
        console.log(`  run ${run?.runId}: ${run?.status}`);
        process.exit(run?.status === "skipped_paused" && !run.plan ? 0 : 1);
      ' || fail "expected skipped_paused with no plan"
      ;;
    backend-down)
      start_executor "$CONFIGURATION_HASH"; simulate
      expect_failure "snapshot|connection refused|dial tcp"
      [ "$(curl -sf 'http://localhost:8787/runs?limit=5')" = "[]" ] || fail "executor should have no runs"
      ;;
    executor-down)
      start_backend 8788; simulate
      expect_failure "connection refused|dial tcp|executor"
      ;;
    wrong-configuration)
      start_backend 8788; start_executor "0x$(printf '0%.0s' $(seq 1 64))"; simulate
      expect_failure "HTTP 422"
      grep -q "configuration mismatch" "$LOGS/executor.log" || fail "executor should log a configuration mismatch"
      ;;
    tampered-snapshot)
      start_backend 8789; start_tampering_proxy; start_executor "$CONFIGURATION_HASH"; simulate
      expect_failure "spot-check failed"
      [ "$(curl -sf 'http://localhost:8787/runs?limit=5')" = "[]" ] || fail "executor should have no runs"
      ;;
    *) echo "unknown scenario: $SCENARIO"; exit 2 ;;
  esac
  echo "PASS [$SCENARIO]"
  cleanup
  sleep 0.5
}

if [ "${1:-ok}" = all ]; then
  for s in ok paused backend-down executor-down wrong-configuration tampered-snapshot; do run_scenario "$s"; done
else
  run_scenario "${1:-ok}"
fi
