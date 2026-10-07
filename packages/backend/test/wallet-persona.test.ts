import { SAMPLE_WALLET_IDS } from "../../shared/sample-wallet-ids";
import { expect, test } from "bun:test";
import { BIRD_NAMES, walletNickname, walletVibe } from "../../shared/wallet-persona";

test("vibe boundaries use both fractional evidence metrics", () => {
  for (const [maxDrawdown, realizedVol, expected] of [
    [0, 0, "calm"], [.0299, .0149, "calm"], [.03, .005, "steady"], [.01, .015, "steady"],
    [.0799, .0299, "steady"], [.08, .005, "wild"], [.01, .03, "wild"], [1, 2, "wild"],
  ] as const) expect(walletVibe({ maxDrawdown, realizedVol })).toBe(expected);
});

test("missing and invalid evidence is neutral, never a calm claim", () => {
  for (const evidence of [undefined, null, {}, { maxDrawdown: .1 }, { realizedVol: .2 },
    { maxDrawdown: null, realizedVol: 1 }, { maxDrawdown: .9, realizedVol: null },
    { maxDrawdown: NaN, realizedVol: .1 }, { maxDrawdown: .1, realizedVol: Infinity },
    { maxDrawdown: -.1, realizedVol: .1 }, { maxDrawdown: 1.1, realizedVol: .1 },
    { maxDrawdown: .1, realizedVol: -.1 },
  ]) expect(walletVibe(evidence)).toBe("steady");
});

test("nicknames are deterministic and distinct across all forty sample identities", () => {
  const ids = Array.from({ length: 40 }, (_, i) => SAMPLE_WALLET_IDS[i]);
  const names = ids.map(walletNickname);
  expect(new Set(names).size).toBe(40);
  expect(ids.toReversed().map(walletNickname).reverse()).toEqual(names);
  expect(walletNickname("0x0041d1dfd012c53ec90b222253d30fe1506fd262")).toBe("Captain Cracker");
  const cached = Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`);
  expect(new Set(cached.map(walletNickname)).size).toBe(6);
  for (const id of [...ids, "0x" + "a".repeat(40), "cached-bird"]) {
    expect(walletNickname(id)).toBe(walletNickname(id));
    expect(BIRD_NAMES as readonly string[]).toContain(walletNickname(id));
  }
});

test("the entire nickname vocabulary is cute, bounded and contains no financial words or ids", () => {
  expect(BIRD_NAMES).toHaveLength(40);
  expect(new Set(BIRD_NAMES).size).toBe(40);
  for (const name of BIRD_NAMES) {
    expect(name.split(" ").length).toBeGreaterThanOrEqual(2);
    expect(name.split(" ").length).toBeLessThanOrEqual(3);
    expect(name).toMatch(/^[A-Za-z -]+$/);
    expect(name).not.toMatch(/\d|addr|0x|money|cash|profit|loss|rich|poor|broke|dollar|coin|token|trade|yield|return|bank|bet|debt/i);
  }
});
