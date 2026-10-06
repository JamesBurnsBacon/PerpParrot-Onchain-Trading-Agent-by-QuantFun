import { scoreCandidates } from "../../score";
import type { Account, Selection } from "./store";
import { TARGET_COUNT } from "./store";

export const SCORE_LABEL = "STRICT_REPOSITORY_SCORE";

// Reuse the team's strict eligibility and exact cross-pool ordering. The 100
// acquisition accounts are not the separate, clone-grouped trading finalists.
export function priority(accounts: Account[], now: number): Selection[] {
  const fresh = accounts.filter(a => a.basis === "verified-input" && a.classification !== null
    && Date.parse(a.fetchedAt) <= now && now - Date.parse(a.fetchedAt) <= 86_400_000);
  const byAddress = new Map(fresh.map(a => [a.input.address, a]));
  const result = scoreCandidates(fresh.map(a => a.input));
  return result.candidates.filter(c => c.eligible && c.score !== null).slice(0, TARGET_COUNT).map(c => ({
    address: c.address, score: c.score!, pool: c.pool, rank: c.rank!,
    fetchedAt: byAddress.get(c.address)!.fetchedAt, basis: byAddress.get(c.address)!.basis,
  }));
}
