import { shortlist, type FinalistLike, type StrategyIntent } from "../../shared/strategy-intent";
import type { Candidate } from "./score/types";

/**
 * Map actual Score outputs into the deliberately small preview interface.
 * Missing clone evidence is kept as null; avoidClones then excludes that row.
 */
export function mapScoreFinalists(
  candidates: readonly Candidate[],
  cloneStatus: ReadonlyMap<string, boolean> = new Map(),
): FinalistLike[] {
  const normalizedCloneStatus = new Map<string, boolean>();
  for (const [address, isClone] of cloneStatus) {
    if (typeof address !== "string" || typeof isClone !== "boolean") continue;
    const key = address.toLowerCase();
    // Conflicting aliases fail closed: any positive clone evidence wins.
    normalizedCloneStatus.set(key, normalizedCloneStatus.get(key) === true || isClone);
  }
  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || typeof candidate.address !== "string" || !candidate.finalist ||
        typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || !candidate.metrics ||
        !Array.isArray(candidate.metrics.flags) || !candidate.metrics.flags.every((flag) => typeof flag === "string") ||
        !(candidate.metrics.maxDrawdown === null || Number.isFinite(candidate.metrics.maxDrawdown)) ||
        !(candidate.metrics.realizedVol === null || Number.isFinite(candidate.metrics.realizedVol))) return [];
    const address = candidate.address.toLowerCase();
    return [{
      address: candidate.address,
      kind: candidate.kind,
      score: candidate.score,
      flags: [...candidate.metrics.flags],
      maxDrawdown: candidate.metrics.maxDrawdown,
      // Score's realizedVol is deliberately non-annualised; retain its native name and units.
      realizedVol: candidate.metrics.realizedVol,
      cloneOf: normalizedCloneStatus.get(address) ?? null,
    }];
  });
}

/** Typed adapter from Score's ranking output to the chat-only deterministic preview shortlist. */
export function shortlistScoreFinalists(
  candidates: readonly Candidate[],
  intent: StrategyIntent,
  maxSources: number,
  cloneStatus?: ReadonlyMap<string, boolean>,
): string[] {
  return shortlist(mapScoreFinalists(candidates, cloneStatus), intent, maxSources);
}
