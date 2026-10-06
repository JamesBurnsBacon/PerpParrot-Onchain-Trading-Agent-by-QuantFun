import { SAMPLE_WALLET_IDS } from "./sample-wallet-ids";
// Display-only personalities. Never use these names or vibes for scoring, policy or execution.
export const BIRD_NAMES = [
  "Captain Cracker", "Sir Squawks-a-lot", "Feather Locksmith", "Wing Commander Wobble",
  "Professor Peep", "Duchess Fluff", "Major Macaw", "Noodle Beak",
  "Pickle Parrot", "Waffle Wings", "Baron Biscuit", "Lady Plume",
  "Doctor Flap", "Admiral Apricot", "Mango Mumbles", "Peachy Perch",
  "Lord Loofah", "Pudding Puff", "Doodle Dodo", "Coconut Chirp",
  "Tango Toucan", "Peanut Preen", "Velvet Squawk", "Disco Feathers",
  "Marshmallow Macaw", "Count Cuddle", "Button Beak", "Jellybean Jiggle",
  "Papaya Pajamas", "Wobbly Wren", "Teacup Tweet", "Squeaky Sneakers",
  "Crumpet Cockatoo", "Tinsel Tail", "Fluffy Fandango", "Bumble Beak",
  "Perch Inspector", "Chirpy Churro", "Sleepy Sprout", "Tippy Taps",
] as const;

function hashId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// Resolve hash collisions against the whole fixed sample universe, not the current
// shortlist: all 40 names are unique and kept/reentering birds never change names.
// This registry is presentation vocabulary only, not a list of eligible sources.
function namesFor(ids: readonly string[]): ReadonlyMap<string, string> {
  const used = new Set<number>();
  return new Map(ids.map(id => {
    let index = hashId(id) % BIRD_NAMES.length;
    while (used.has(index) && used.size < BIRD_NAMES.length) index = (index + 1) % BIRD_NAMES.length;
    used.add(index);
    return [id, BIRD_NAMES[index]];
  }));
}
const sampleNames = namesFor(SAMPLE_WALLET_IDS);
const cachedNames = namesFor(Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`));
// Unknown ids retain stable hash names too. A finite vocabulary cannot guarantee
// uniqueness for arbitrary live ids; the current server and cached demo are unique.
export const walletNickname = (id: string): string => sampleNames.get(id) ?? cachedNames.get(id) ?? BIRD_NAMES[hashId(id) % BIRD_NAMES.length];

export type WalletVibe = "calm" | "steady" | "wild";
type VibeEvidence = { maxDrawdown?: number | null; realizedVol?: number | null };
// Fractions, not percentages. realizedVol is Score's non-annualised volatility, so its scale is small.
// Calibrated to the sample finalists (drawdown 1-19%, realizedVol 0.3-3.7%); recalibrate against real Score output.
// Cosmetic buckets describe supplied evidence, never future returns or safety. One definition shared by vibes and tags.
export const VIBE_THRESHOLDS = { calmDrawdown: .03, calmVol: .015, wildDrawdown: .08, wildVol: .03 } as const;
export function walletVibe(evidence?: VibeEvidence | null): WalletVibe {
  const dd = evidence?.maxDrawdown, vol = evidence?.realizedVol;
  // Unknown/invalid either metric => neutral Steady. Wild: EITHER metric at/above its wild bound. Calm: BOTH below their calm bounds.
  if (dd == null || vol == null || !Number.isFinite(dd) || !Number.isFinite(vol) || dd < 0 || dd > 1 || vol < 0) return "steady";
  if (dd >= VIBE_THRESHOLDS.wildDrawdown || vol >= VIBE_THRESHOLDS.wildVol) return "wild";
  return dd < VIBE_THRESHOLDS.calmDrawdown && vol < VIBE_THRESHOLDS.calmVol ? "calm" : "steady";
}
