import { expect, test } from "bun:test";
import { explainSelection } from "../src/chat/strategy";
import { VIBE_THRESHOLDS, walletVibe } from "../../shared/wallet-persona";
import { intents } from "../scripts/measure-wallet-board";
import fixture from "../fixtures/frozen-configuration.json";
import type { Policy } from "../../shared/src/contracts";

for (const [name, metric, tag, boundary] of [
  ["calm drawdown", "maxDrawdown", "drawdown", VIBE_THRESHOLDS.calmDrawdown],
  ["calm volatility", "realizedVol", "vol", VIBE_THRESHOLDS.calmVol],
  ["wild drawdown", "maxDrawdown", "drawdown", VIBE_THRESHOLDS.wildDrawdown],
  ["wild volatility", "realizedVol", "vol", VIBE_THRESHOLDS.wildVol],
] as const) {
  for (const [offset, roundedOffset] of [[-.0001, -.0001], [-.00006, -.0001], [-.00004, 0], [0, 0], [.00004, 0], [.00006, .0001], [.0001, .0001]]) {
    test(`${name}: raw offset ${offset} agrees with rounded evidence`, () => {
      const finalists = Array.from({ length: 5 }, (_, i) => ({
        address: `0x${String(i + 1).repeat(40)}`, kind: "PERP" as const, score: 100 - i, flags: [], cloneOf: false as const,
        maxDrawdown: 0, realizedVol: 0, [metric]: boundary + offset,
      }));
      const { evidence } = explainSelection({ ...intents.balanced, riskStyle: "aggressive", maxSources: 5 }, fixture.policy as Policy, { finalists, dataSource: "sample" });
      expect(evidence).toHaveLength(5);
      for (const e of evidence) {
        expect(e[metric]).toBeCloseTo(boundary + roundedOffset, 8);
        const below = roundedOffset < 0, calm = name.startsWith("calm");
        expect(walletVibe(e)).toBe(calm ? (below ? "calm" : "steady") : (below ? "steady" : "wild"));
        expect(e.tags.includes(`low ${tag}`)).toBe(calm && below);
        expect(e.tags.includes(`high ${tag}`)).toBe(!calm && !below);
      }
    });
  }
}
