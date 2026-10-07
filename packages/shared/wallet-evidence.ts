// Evidence types and closed reason vocabulary used by selection and browser guards.
// Describe supplied Score facts only; tags must never become policy or trading authority.
export const WALLET_TAGS = ["low drawdown", "high drawdown", "low vol", "high vol", "clone-checked", "score selected"] as const;
const SELECTION_REASONS = [...WALLET_TAGS, "ranked below the new source limit", "outside the style score window", "lower priority for this style", "clone excluded", "unranked", "flagged: overflow", "flagged: ruin", "flagged: low-coverage", "flagged: no-intervals"] as const;
export type WalletEvidence = { address: string; rank: number; maxDrawdown: number | null; realizedVol: number | null; tags: string[]; periodReturn?: number | null; sharpe?: number | null };
export type WalletChanges = { added: { address: string; reason: string }[]; removed: { address: string; reason: string }[] };
export const isSelectionReason = (v: unknown): v is string => typeof v === "string" &&
  ((SELECTION_REASONS as readonly string[]).includes(v) || /^clone of [\w.:-]{1,66}$/.test(v));
