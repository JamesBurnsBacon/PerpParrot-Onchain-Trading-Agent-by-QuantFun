// Replays stored snapshots under today's trading rules and the rules before the churn work, and
// prints what each would have traded (src/replay.ts). Reads the public backend, no database needed.
//
//   bun run scripts/replay-churn.ts [--hours 24] [--equity 10000] [--backend https://perpparrot.vercel.app/api/backend]
//
// Snapshots replay through today's target maths, so older ones (before the leverage normalization)
// copy their wallets as they were. Prices are held constant: turnover, not PnL.
import { replay, RULES } from "../src/replay";
import type { PositionsSnapshot } from "../../shared/snapshot";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const hours = Number(arg("hours", "24"));
const equity = Number(arg("equity", "10000"));
const backend = arg("backend", "https://perpparrot.vercel.app/api/backend").replace(/\/$/, "");

const now = Math.floor(Date.now() / 1000);
const last = now - (now % 600);
const runAts = Array.from({ length: Math.ceil((hours * 3600) / 600) }, (_, i) => last - i * 600).reverse();
const snapshots: PositionsSnapshot[] = [];
for (let i = 0; i < runAts.length; i += 8) {
  const batch = await Promise.all(
    runAts.slice(i, i + 8).map(async (runAt) => {
      const res = await fetch(`${backend}/snapshots/${runAt}`, { signal: AbortSignal.timeout(30_000) });
      return res.ok ? ((await res.json()) as PositionsSnapshot) : undefined;
    }),
  );
  snapshots.push(...batch.filter((s): s is PositionsSnapshot => s !== undefined));
}
console.log(`${snapshots.length} snapshots over the last ${hours} h, replayed at $${equity.toLocaleString()} equity\n`);
const rows = RULES.map((rules) => replay(snapshots, rules, equity));
const pad = (v: string, n: number) => v.padStart(n);
console.log(["rules".padEnd(18), pad("runs", 5), pad("orders", 7), pad("traded", 10), pad("turnover/day", 13), pad("switches", 9), pad("at switches", 12), pad("steady/day", 11), pad("closes", 7), pad("reopen<1h", 10), pad("avg perps", 10)].join(" "));
for (const r of rows) {
  console.log([
    r.rules.padEnd(18), pad(String(r.runs), 5), pad(String(r.orders), 7), pad(`$${Math.round(r.tradedUsd).toLocaleString()}`, 10),
    pad(`${r.turnoverPerDay.toFixed(2)}×`, 13), pad(String(r.switches), 9), pad(`$${Math.round(r.switchTradedUsd).toLocaleString()}`, 12),
    pad(`${r.steadyTurnoverPerDay.toFixed(2)}×`, 11), pad(String(r.closes), 7), pad(String(r.reopenedWithinHour), 10), pad(r.meanPositions.toFixed(1), 10),
  ].join(" "));
}
console.log("\nswitches: the wallet set, weights or leverage scales changed (that run and its 2 confirmation runs count as the switch); steady/day: turnover outside them.");
