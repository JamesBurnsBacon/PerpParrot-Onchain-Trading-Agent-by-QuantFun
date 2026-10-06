#!/usr/bin/env bash
# Soak test of the CRE mirror path: keeps the snapshot service and executor running
# (dry run) and runs `cre workflow simulate mirror` against live Hyperliquid data every
# INTERVAL seconds, logging each round. Catches what one run can't: flakiness under
# repetition, leaks, and how spot-check deviation grows as a snapshot ages.
# Read-only on Hyperliquid; never sends an order.
#
#   ./scripts/soak-mirror.sh                  # 40 rounds, 90 s apart
#   ROUNDS=10 INTERVAL=60 ./scripts/soak-mirror.sh
#   DATABASE_URL=postgres://… ./scripts/soak-mirror.sh   # services on Postgres
#   TIMING=production ROUNDS=12 ./scripts/soak-mirror.sh # one round per 10-min run, at :x9:50
#
# TIMING=production measures the spot-check deviation the DON will see: the snapshot is the
# one the service's own scheduler prebuilt at ~:x8:30, checked ~90 s later. The default
# timing re-checks one snapshot as it ages, up to 10 min (deviation grows with age).
#
# Stops early if the code under test changes (files edited or HEAD moved), since the
# running services and each fresh simulation would then disagree.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRE="${CRE:-$(command -v cre || echo "$HOME/.cre/bin/cre")}"
ROUNDS="${ROUNDS:-40}"
INTERVAL="${INTERVAL:-90}"
TIMING="${TIMING:-repeat}"
OUT="${SOAK_DIR:-$(mktemp -d)}"
mkdir -p "$OUT"
RESULTS="$OUT/results.jsonl"
CONFIGURATION="$ROOT/packages/backend/fixtures/frozen-configuration.json"
CONFIGURATION_HASH="$(bun -e "console.log((await Bun.file('$CONFIGURATION').json()).configurationHash)")"
ACCOUNT="$(bun -e "console.log((await Bun.file('$CONFIGURATION').json()).account)")"
export MIRROR_SAMPLING_KEY="${MIRROR_SAMPLING_KEY:-0x$(openssl rand -hex 32)}"
PIDS=()

cleanup() { for pid in "${PIDS[@]:-}"; do { kill "$pid" && wait "$pid"; } 2>/dev/null || true; done; }
trap cleanup EXIT

for port in 8787 8788; do
  if lsof -ti ":$port" >/dev/null 2>&1; then echo "port $port is in use: stop whatever is running there first"; exit 1; fi
done

# Fingerprint of everything the services and the workflow are built from.
code_state() {
  (cd "$ROOT" && git rev-parse HEAD && git diff HEAD -- packages scripts supabase && git ls-files --others --exclude-standard packages) |
    shasum | cut -d' ' -f1
}
START_STATE="$(code_state)"

# The simulator stamps the next :x0, so the default timing needs 600 s of lead on both
# services; production timing runs with the production limits.
if [ "$TIMING" = production ]; then SNAPSHOT_LEAD=120 REPORT_LEAD=60; else SNAPSHOT_LEAD=600 REPORT_LEAD=600; fi

(cd "$ROOT/packages/backend" && PORT=8788 SNAPSHOT_MAX_LEAD_SECONDS=$SNAPSHOT_LEAD CONFIGURATION_PATH="$CONFIGURATION" \
  FROZEN_CONFIGURATION_HASH="$CONFIGURATION_HASH" exec bun run src/server.ts >>"$OUT/backend.log" 2>&1) &
PIDS+=($!)
(cd "$ROOT/packages/executor" && PORT=8787 VERIFY_REPORTS=false DRY_RUN=true HL_ACCOUNT="$ACCOUNT" MAX_REPORT_LEAD_SECONDS=$REPORT_LEAD \
  FROZEN_CONFIGURATION_HASH="$CONFIGURATION_HASH" WORKFLOW_OWNER=0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85 \
  exec bun run src/server.ts >>"$OUT/executor.log" 2>&1) &
PIDS+=($!)
for url in http://localhost:8788/health http://localhost:8787/health; do
  for _ in $(seq 1 50); do curl -sf "$url" >/dev/null && break; sleep 0.2; done
  curl -sf "$url" >/dev/null || { echo "service at $url didn't start"; cat "$OUT"/*.log; exit 1; }
done
SERVICES_AT=$(date +%s)

if [ "$TIMING" = production ]; then
  echo "soak: $ROUNDS rounds at :x9:50 (production timing and limits), logs in $OUT"
else
  echo "soak: $ROUNDS rounds, ${INTERVAL}s apart, logs in $OUT"
fi
for i in $(seq 1 "$ROUNDS"); do
  # Production timing: start 10 s before the run (the simulator compiles for ~4 s before it
  # reads the clock and stamps the next :x0), in a window whose snapshot the scheduler
  # prebuilt at ~:x8:30, so not within 2 minutes of the services starting.
  # Waits before the code check below, so an edit during the wait is still caught.
  if [ "$TIMING" = production ]; then
    until s=$(( $(date +%s) % 600 )); [ "$s" -ge 590 ] && [ "$s" -le 594 ] && [ $(( $(date +%s) - SERVICES_AT )) -gt 120 ]; do sleep 1; done
  fi
  if [ "$(code_state)" != "$START_STATE" ]; then
    echo "stopping: the code changed during the soak (rounds after this would test a mix of versions)"
    break
  fi
  t0=$(date +%s)
  if out=$(cd "$ROOT/packages/cre-workflows" && "$CRE" workflow simulate mirror --target staging-settings --trigger-index 0 --non-interactive 2>&1); then
    rc=0
  else
    rc=$?
  fi
  dev=$(echo "$out" | grep -o "max deviation [0-9]* bps" | grep -o "[0-9]*" | head -1 || true)
  err=$(echo "$out" | grep -o "execution failed: .*" | head -1 | cut -c1-200 | tr '"' "'" || true)
  snap=$(echo "$out" | grep -o "snap-[0-9]*" | head -1 || true)
  # leadS: run time minus start; about 10 in production timing (600 means it stamped the run after).
  lead=$([ -n "$snap" ] && echo $(( ${snap#snap-} - t0 )) || echo null)
  printf '{"i":%d,"t":"%s","ok":%s,"secs":%d,"snap":"%s","leadS":%s,"devBps":%s,"err":"%s"}\n' \
    "$i" "$(date -u +%H:%M:%S)" "$([ $rc = 0 ] && echo true || echo false)" "$(( $(date +%s) - t0 ))" \
    "$snap" "$lead" "${dev:-null}" "$err" | tee -a "$RESULTS"
  if [ "$i" -lt "$ROUNDS" ]; then
    # Production timing: leave the start window, so a fast failure can't run twice for one run.
    if [ "$TIMING" = production ]; then sleep 10; else sleep "$INTERVAL"; fi
  fi
done

# Summary: pass/fail counts, failure reasons, deviation range, executor run outcomes.
bun -e '
const rows = (await Bun.file(process.argv[1]).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const failed = rows.filter((r) => !r.ok);
const devs = rows.map((r) => r.devBps).filter((d) => d !== null);
console.log(`\nsoak summary: ${rows.length} rounds, ${rows.length - failed.length} passed, ${failed.length} failed`);
if (devs.length) console.log(`spot-check deviation: ${Math.min(...devs)}–${Math.max(...devs)} bps (limit 500)`);
const reasons = {};
for (const r of failed) reasons[r.err || "unknown"] = (reasons[r.err || "unknown"] ?? 0) + 1;
for (const [err, n] of Object.entries(reasons)) console.log(`  ${n}× ${err}`);
const runs = await (await fetch("http://localhost:8787/runs?limit=200")).json();
const byStatus = {};
for (const r of runs) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log(`executor runs: ${JSON.stringify(byStatus)} (repeat rounds in one 10-min window are deduplicated)`);
process.exit(failed.length ? 1 : 0);
' "$RESULTS"
