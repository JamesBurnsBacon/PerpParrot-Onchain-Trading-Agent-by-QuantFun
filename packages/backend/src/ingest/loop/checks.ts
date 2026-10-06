import { scoreCandidates } from "../../score";
import type { Collected } from "./collect";
import type { LoopStore } from "./store";

export function requireCollection(store: LoopStore, result: Collected, address: string, now: number) {
  const account = result.account, fetched = Date.parse(account.fetchedAt);
  if (account.input.address !== address || account.candidate.address !== address) throw new Error("Collected address mismatch");
  if (account.basis !== "verified-input" || !account.classification || account.classification.kind !== account.input.kind) throw new Error("Unverified collected classification");
  if (!Number.isFinite(fetched) || fetched > now || now - fetched > 540_000) throw new Error("Collected portfolio is stale or future-dated");
  store.raw(account.rawHash);
}

export function isStrictEligible(result: Collected): boolean {
  return scoreCandidates([result.account.input]).candidates[0]?.eligible === true;
}
