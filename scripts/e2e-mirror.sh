#!/usr/bin/env bash
# End-to-end check of the CRE mirror path against live Hyperliquid data (read-only):
# backend snapshot service → cre workflow simulate mirror → executor (verify, plan, dry run).
# Needs: bun, the cre CLI (logged in), network. Never sends an order: DRY_RUN stays on.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRE="${CRE:-$(command -v cre || echo "$HOME/.cre/bin/cre")}"
LOGS="$(mktemp -d)"
CONFIGURATION="$ROOT/packages/backend/fixtures/frozen-configuration.json"
CONFIGURATION_HASH="$(bun -e "console.log((await Bun.file('$CONFIGURATION').json()).configurationHash)")"
ACCOUNT="$(bun -e "console.log((await Bun.file('$CONFIGURATION').json()).account)")"

cleanup() { kill "${BACKEND_PID:-}" "${EXECUTOR_PID:-}" 2>/dev/null || true; }
trap cleanup EXIT

(cd "$ROOT/packages/backend" && PORT=8788 CONFIGURATION_PATH="$CONFIGURATION" FROZEN_CONFIGURATION_HASH="$CONFIGURATION_HASH" \
  exec bun run src/server.ts >"$LOGS/backend.log" 2>&1) &
BACKEND_PID=$!
(cd "$ROOT/packages/executor" && PORT=8787 VERIFY_REPORTS=false DRY_RUN=true HL_ACCOUNT="$ACCOUNT" \
  MAX_REPORT_LEAD_SECONDS=600 FROZEN_CONFIGURATION_HASH="$CONFIGURATION_HASH" WORKFLOW_OWNER=0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85 \
  exec bun run src/server.ts >"$LOGS/executor.log" 2>&1) &
EXECUTOR_PID=$!

for url in http://localhost:8788/health http://localhost:8787/health; do
  for _ in $(seq 1 50); do curl -sf "$url" >/dev/null && break; sleep 0.2; done
  curl -sf "$url" >/dev/null || { echo "service at $url didn't start"; cat "$LOGS"/*.log; exit 1; }
done

echo "== cre workflow simulate mirror"
(cd "$ROOT/packages/cre-workflows" && "$CRE" workflow simulate mirror --target staging-settings --trigger-index 0 --non-interactive) \
  >"$LOGS/simulate.log" 2>&1 || { cat "$LOGS/simulate.log"; echo "FAIL: simulation failed"; exit 1; }
grep -E "USER LOG|Simulation Result" -A1 "$LOGS/simulate.log" | grep -v "^--$" || true

# The executor answers the DON right away and executes in the background.
for _ in $(seq 1 50); do
  RUNS="$(curl -sf 'http://localhost:8787/runs?limit=1')"
  [ "$RUNS" != "[]" ] && break
  sleep 0.2
done

echo "== executor run"
echo "$RUNS" | bun -e '
const [run] = JSON.parse(await Bun.stdin.text());
if (!run) { console.log("FAIL: executor recorded no run"); process.exit(1); }
const p = run.plan ?? { orders: [], skipped: [] };
console.log(`run ${run.runId}: ${run.status}, dryRun=${run.dryRun}, equity $${run.equityUsd?.toFixed(2)}, margin scale ${p.marginScale?.toFixed(3)}`);
console.log(`orders ${p.orders.length} (reduce-only ${p.orders.filter((o) => o.reduceOnly).length}), skipped ${p.skipped.length}`);
for (const o of p.orders.slice(0, 8)) console.log(`  ${o.isBuy ? "BUY " : "SELL"} ${o.asset.padEnd(10)} ${o.size.padStart(12)} @ ${o.price}${o.reduceOnly ? " reduce-only" : ""}`);
if (run.status !== "executed" || !run.dryRun) { console.log("FAIL: expected an executed dry run", run.error ?? ""); process.exit(1); }
console.log("PASS");
'
echo "logs: $LOGS"
