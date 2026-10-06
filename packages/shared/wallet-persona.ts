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
function namesFor(ids: string[]): ReadonlyMap<string, string> {
  const used = new Set<number>();
  return new Map(ids.map(id => {
    let index = hashId(id) % BIRD_NAMES.length;
    while (used.has(index) && used.size < BIRD_NAMES.length) index = (index + 1) % BIRD_NAMES.length;
    used.add(index);
    return [id, BIRD_NAMES[index]];
  }));
}
const sampleNames = namesFor(Array.from({ length: 40 }, (_, i) => `addr-${String(i + 1).padStart(2, "0")}`));
const cachedNames = namesFor(Array.from({ length: 6 }, (_, i) => `0x${String(i + 1).repeat(40)}`));
// Unknown ids retain stable hash names too. A finite vocabulary cannot guarantee
// uniqueness for arbitrary live ids; the current server and cached demo are unique.
export const walletNickname = (id: string): string => sampleNames.get(id) ?? cachedNames.get(id) ?? BIRD_NAMES[hashId(id) % BIRD_NAMES.length];

export type WalletVibe = "calm" | "steady" | "wild";
type VibeEvidence = { maxDrawdown?: number | null; annualisedVol?: number | null };
export function walletVibe(evidence?: VibeEvidence | null): WalletVibe {
  const dd = evidence?.maxDrawdown, vol = evidence?.annualisedVol;
  // Fractions, not percentages. Unknown/invalid either metric => neutral Steady.
  // Calm: BOTH drawdown < 15% and annualised volatility < 45%.
  // Wild: EITHER drawdown >= 30% or volatility >= 80%. Otherwise Steady.
  // Cosmetic buckets describe supplied evidence, never future returns or safety.
  if (dd == null || vol == null || !Number.isFinite(dd) || !Number.isFinite(vol) || dd < 0 || dd > 1 || vol < 0) return "steady";
  if (dd >= .3 || vol >= .8) return "wild";
  return dd < .15 && vol < .45 ? "calm" : "steady";
}
