import { expect, test } from "bun:test";
import { BIRD_NAMES, walletNickname, walletVibe } from "../../shared/wallet-persona";

test("vibe boundaries use both fractional evidence metrics", () => {
  for (const [maxDrawdown, annualisedVol, expected] of [
    [0, 0, "calm"], [.1499, .4499, "calm"], [.15, .1, "steady"], [.1, .45, "steady"],
    [.2999, .7999, "steady"], [.3, .1, "wild"], [.1, .8, "wild"], [1, 2, "wild"],
  ] as const) expect(walletVibe({ maxDrawdown, annualisedVol })).toBe(expected);
});

test("missing and invalid evidence is neutral, never a calm claim", () => {
  for (const evidence of [undefined, null, {}, { maxDrawdown: .1 }, { annualisedVol: .2 },
    { maxDrawdown: null, annualisedVol: 1 }, { maxDrawdown: .9, annualisedVol: null },
    { maxDrawdown: NaN, annualisedVol: .1 }, { maxDrawdown: .1, annualisedVol: Infinity },
    { maxDrawdown: -.1, annualisedVol: .1 }, { maxDrawdown: 1.1, annualisedVol: .1 },
    { maxDrawdown: .1, annualisedVol: -.1 },
  ]) expect(walletVibe(evidence)).toBe("steady");
});

test("nicknames are deterministic and distinct across all forty sample identities", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `addr-${String(i + 1).padStart(2, "0")}`);
  const names = ids.map(walletNickname);
  expect(new Set(names).size).toBe(40);
  expect(ids.toReversed().map(walletNickname).reverse()).toEqual(names);
  expect(walletNickname("addr-03")).toBe("Perch Inspector");
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
