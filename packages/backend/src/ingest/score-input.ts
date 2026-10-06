import { parsePortfolio } from "../score/parse";
import type { ScoreInput } from "../score/types";
import { addressSchema, decimalSchema, type Candidate, type CollectionRecord } from "./types";

// Observed filled orders are a lower bound, not a claim of complete lifetime history.
export function orderEvidence(payload: unknown, endTime: number) {
  if (!Array.isArray(payload)) return { observed: null, tradeCount: null };
  const ids = new Set<string>();
  for (const fill of payload) {
    if (fill && typeof fill === "object" && Number.isSafeInteger(fill.time) && fill.time >= 0 && fill.time <= endTime
      && typeof fill.coin === "string" && fill.coin.length > 0 && Number.isSafeInteger(fill.oid) && fill.oid >= 0
      && typeof fill.sz === "string" && decimalSchema.safeParse(fill.sz).success
      && Number.isFinite(Number(fill.sz)) && Number(fill.sz) > 0) {
      ids.add(`${fill.coin}:${fill.oid}`);
    }
  }
  return { observed: ids.size, tradeCount: ids.size >= 10 ? ids.size : null };
}

export function toScoreInput(candidate: Candidate, record: CollectionRecord, raw: unknown,
  fills: unknown = null): ScoreInput | null {
  if (!record.classification || record.classificationError || record.portfolioError) return null;
  const address = addressSchema.parse(candidate.address);
  if (address !== addressSchema.parse(record.address)) throw new Error("Candidate/record address mismatch");
  const accountValue = Number(decimalSchema.parse(candidate.accountValueOrTvlUsd));
  if (!Number.isFinite(accountValue) || accountValue < 0) throw new Error("Invalid candidate account value/TVL");
  const { month, allTime } = parsePortfolio(raw);
  const end = month?.pnlHistory.at(-1)?.[0] ?? 0;
  return {
    address, kind: record.classification.kind,
    // Score's funding filter uses the discovery account value / vault TVL, per the ingest contract.
    // Portfolio equity still supplies the return series; mirror equity is a separate live input.
    accountValue,
    // Open HyperCore vaults are checked against this run's source list. Trader closure is N/A.
    // ERC-4626 closed state has not been verified by the two contract probes.
    closed: record.classification.kind === "erc4626-vault" ? null : false,
    month, allTime, history: null, tradeCount: orderEvidence(fills, end).tradeCount,
    links: candidate.knownHypercoreVault && candidate.leaderAddress ? [candidate.leaderAddress] : [],
  };
}
