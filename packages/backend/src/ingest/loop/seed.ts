import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parsePortfolio } from "../../score";
import { normalizedMonth } from "../history";
import { addressSchema, type Candidate } from "../types";
import { digest } from "../store";
import { LoopStore, type Account } from "./store";
import { SCORE_LABEL } from "./rank";

export async function seedFirstPass(store: LoopStore, root: string, candidateFile: string, now = Date.now()) {
  if (store.state("seed")) throw new Error("Already seeded");
  const rawScreen = await readFile(join(root, "screening-v1/screening.json"), "utf8");
  const screening = JSON.parse(rawScreen);
  if (screening.summary?.schema !== "research-screen.v1" || screening.summary.status !== "complete") throw new Error("Complete research screen required");
  const rawCandidates = await readFile(candidateFile, "utf8");
  const candidates: Candidate[] = JSON.parse(rawCandidates);
  const byAddress = new Map(candidates.map(c => [addressSchema.parse(c.address), c]));
  if (byAddress.size !== candidates.length) throw new Error("Duplicate discovery address");
  const accounts: Account[] = [], seen = new Set<string>();
  for (const row of screening.rows) {
    if (row.decision !== "candidate") continue;
    const address = addressSchema.parse(row.address), candidate = byAddress.get(address);
    if (!candidate || seen.has(address)) throw new Error("Missing/duplicate seed candidate");
    seen.add(address);
    const evidence = JSON.parse(await readFile(join(root, "evidence", `${address}.json`), "utf8"));
    if (evidence.address !== address || typeof evidence.raw !== "string" || digest(evidence.raw) !== evidence.sha256
      || evidence.sha256 !== row.evidenceSha256) throw new Error(`Invalid seed evidence: ${address}`);
    const fetched = Date.parse(evidence.fetchedAt);
    if (!Number.isFinite(fetched) || fetched > now || now - fetched > 86_400_000) throw new Error("Seed older than 24 hours or from the future");
    const raw = JSON.parse(evidence.raw), windows = parsePortfolio(raw);
    normalizedMonth(address, raw, evidence.fetchedAt, "seed");
    // Account kind is a declared acquisition proxy until classify() runs; it is
    // never fed into a purported strict result as verified evidence.
    const known = candidate.knownHypercoreVault;
    accounts.push({ candidate, input: { address, kind: known ? "hypercore-vault" : "trader",
      accountValue: Number(candidate.accountValueOrTvlUsd), closed: known ? false : null,
      ...windows, history: null, tradeCount: null,
      links: known && candidate.leaderAddress ? [candidate.leaderAddress] : [] },
      fetchedAt: evidence.fetchedAt, rawHash: store.blob(evidence.raw),
      classification: known ? { kind: "hypercore-vault", evidence: "vault-list" } : null,
      classificationAt: null, fillsHash: null, fillsCheckedAt: null, basis: "research-priority" });
  }
  store.seed(accounts, { schema: "ingest-registry-seed.v1", importedAt: new Date(now).toISOString(),
    accounts: accounts.length, screenHash: digest(rawScreen), candidateFileHash: digest(rawCandidates),
    scoreLabel: SCORE_LABEL, source: "regular-candidates-only", scoreVersion: "repository-default" });
  return { accounts: accounts.length, selected: 0, status: "awaiting-evidence-bootstrap" };
}
