import { describe, expect, test } from "bun:test";
import type { FrozenConfiguration } from "../../shared/frozen";
import type { PositionsSnapshot } from "../../shared/snapshot";
import fixture from "../fixtures/frozen-configuration.json";
import { replay, RULES } from "../src/replay";

const configuration = fixture as unknown as FrozenConfiguration;
const wallets = configuration.sources.map((s) => s.sourceAddress.toLowerCase()).sort();

// Every wallet holds 0.5× BTC; the first also 0.5× ETH, except in the runs listed.
const snapshot = (runAt: number, ethGone: boolean, hash = configuration.configurationHash): PositionsSnapshot => ({
  snapshotId: `snap-${runAt}`, runAt, takenAt: runAt, eligibleAssets: ["BTC", "ETH"],
  configuration: { ...configuration, configurationHash: hash },
  sources: wallets.map((address, i) => ({
    address, equityE6: "1000000000000",
    positions: [{ asset: "BTC", notionalE6: "500000000000" }, ...(i === 0 && !ethGone ? [{ asset: "ETH", notionalE6: "500000000000" }] : [])],
  })),
});

describe("replay (churn under the trading rules)", () => {
  // ETH leaves for one run and comes back.
  const runs = [0, 600, 1200, 1800].map((t, i) => snapshot(t, i === 2));
  const [current, before] = RULES.map((rules) => replay(runs, rules, 10_000));

  test("a perp that leaves for one run: closed and reopened before the churn work, held today", () => {
    expect(before).toMatchObject({ runs: 4, closes: 1, reopenedWithinHour: 1 });
    expect(current).toMatchObject({ runs: 4, closes: 0, reopenedWithinHour: 0 });
    expect(current.orders).toBeLessThan(before.orders);
    expect(current.tradedUsd).toBeLessThan(before.tradedUsd);
  });

  test("trades right after a configuration change count as a switch", () => {
    const switched = [snapshot(0, false), snapshot(600, false, `0x${"cd".repeat(32)}`)];
    const r = replay(switched, RULES[0]!, 10_000);
    expect(r.switches).toBe(1);
    expect(r.steadyTurnoverPerDay).toBeLessThanOrEqual(r.turnoverPerDay);
  });
});
