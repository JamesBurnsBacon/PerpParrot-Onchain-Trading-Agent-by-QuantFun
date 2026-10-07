// Churn replay (docs/ingest/ROSTER.md §8): stored snapshots → the same targets the executor gets
// (shared/copy.ts) → the same leg rule (shared/rebalance.ts) against a simulated account, under
// rule variants, to compare turnover on history. Prices are held constant, so this measures what
// the rules trade, not PnL. Pure: the script (scripts/replay-churn.ts) does the fetching.
import { CLOSE_CONFIRM_RUNS, pendingCloses, targetsFromSnapshot } from "../../shared/copy";
import { legSkip, type BandConfig } from "../../shared/rebalance";
import type { PositionsSnapshot } from "../../shared/snapshot";

export type ReplayRules = BandConfig & { name: string; confirmCloses: boolean };

// Today's rules, and the rules before the churn work (no equity band, closes at once).
export const RULES: ReplayRules[] = [
  { name: "current", minOrderUsd: 10, driftFraction: 0.1, equityBandFraction: 0.005, confirmCloses: true },
  { name: "before churn work", minOrderUsd: 10, driftFraction: 0.1, equityBandFraction: 0, confirmCloses: false },
];

export type ReplayResult = {
  rules: string;
  runs: number;
  hours: number;
  orders: number;
  tradedUsd: number;
  turnoverPerDay: number; // traded ÷ equity per day
  // Trades in the runs right after the wallet set, weights or leverage scales changed (a rebalance to
  // a new configuration, its confirmed closes included), and the steady turnover without them.
  switches: number;
  switchTradedUsd: number;
  steadyTurnoverPerDay: number;
  closes: number;
  reopenedWithinHour: number; // closes followed by a reopen of the same perp within an hour
  meanPositions: number;
};

// `snapshots`: consecutive runs (sorted by runAt; a missing run is simply absent).
export const replay = (snapshots: PositionsSnapshot[], rules: ReplayRules, equityUsd: number): ReplayResult => {
  const sorted = [...snapshots].sort((a, b) => a.runAt - b.runAt);
  const held = new Map<string, number>(); // perp → USD
  const history = new Map<number, { asset: string; exposureE9: bigint }[]>();
  const closedAt = new Map<string, number>();
  let orders = 0;
  let tradedUsd = 0;
  let closes = 0;
  let reopened = 0;
  let positionRuns = 0;
  let switches = 0;
  let switchTradedUsd = 0;
  let lastKey: string | undefined;
  let switchUntil = -Infinity;
  for (const snapshot of sorted) {
    let targets: { asset: string; exposureE9: bigint }[];
    try {
      targets = targetsFromSnapshot(snapshot);
    } catch {
      continue; // a run the executor would get no targets for: it holds
    }
    history.set(snapshot.runAt, targets);
    const previous = Array.from({ length: CLOSE_CONFIRM_RUNS - 1 }, (_, i) => history.get(snapshot.runAt - (i + 1) * 600));
    const pending = rules.confirmCloses ? new Set(pendingCloses(targets, previous)) : new Set<string>();
    const target = new Map(targets.map((t) => [t.asset, (Number(t.exposureE9) / 1e9) * equityUsd]));
    // A new configuration or new leverage scales: this run's trades are a switch, not steady churn.
    // The window covers the confirmation runs too, so delayed closes are attributed to the switch.
    const key = `${snapshot.configuration.configurationHash}|${JSON.stringify(snapshot.leverage ?? [])}`;
    if (lastKey !== undefined && key !== lastKey) {
      switches++;
      switchUntil = snapshot.runAt + (CLOSE_CONFIRM_RUNS - 1) * 600;
    }
    const switching = snapshot.runAt <= switchUntil;
    lastKey = key;
    for (const asset of new Set([...target.keys(), ...held.keys()])) {
      const targetUsd = target.get(asset) ?? 0;
      const currentUsd = held.get(asset) ?? 0;
      if (targetUsd === currentUsd) continue;
      if (legSkip({ targetUsd, currentUsd, equityUsd, closePending: pending.has(asset) }, rules)) continue;
      orders++;
      tradedUsd += Math.abs(targetUsd - currentUsd);
      if (switching) switchTradedUsd += Math.abs(targetUsd - currentUsd);
      if (targetUsd === 0) {
        held.delete(asset);
        closes++;
        closedAt.set(asset, snapshot.runAt);
      } else {
        if (currentUsd === 0 && closedAt.has(asset) && snapshot.runAt - closedAt.get(asset)! <= 3600) reopened++;
        held.set(asset, targetUsd);
      }
    }
    positionRuns += held.size;
  }
  const runs = history.size;
  const hours = sorted.length > 1 ? (sorted.at(-1)!.runAt - sorted[0]!.runAt) / 3600 + 1 / 6 : runs / 6;
  return {
    rules: rules.name,
    runs,
    hours,
    orders,
    tradedUsd,
    turnoverPerDay: hours > 0 ? tradedUsd / equityUsd / (hours / 24) : 0,
    switches,
    switchTradedUsd,
    steadyTurnoverPerDay: hours > 0 ? (tradedUsd - switchTradedUsd) / equityUsd / (hours / 24) : 0,
    closes,
    reopenedWithinHour: reopened,
    meanPositions: runs ? positionRuns / runs : 0,
  };
};
