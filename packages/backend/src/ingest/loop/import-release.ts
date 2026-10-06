import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { parsePortfolio, scoreCandidates, type ScoreInput } from "../../score";
import { addressSchema, decimalSchema } from "../types";
import { orderEvidence } from "../score-input";
import { digest } from "../store";
import { readGzipRows, scoreSourceHash, type Asset } from "./export-data";
import { verifyAssets } from "./load-data";
import { rankAsync } from "./ranking";
import { LoopStore, TARGET_COUNT, type Account } from "./store";

export const RELEASE_ASSETS = ["discovery.jsonl.gz", "score-inputs.jsonl.gz", "score-evidence.jsonl.gz"] as const;
const point = z.tuple([z.number().int().nonnegative(), z.number().finite()]);
const window = z.object({ accountValueHistory: z.array(point), pnlHistory: z.array(point) }).strict();
const kind = z.enum(["trader", "hypercore-vault", "erc4626-vault"]);
const optionalMetric = z.number().finite().nullable().optional();
const inputSchema = z.object({ address: addressSchema, kind, accountValue: z.number().finite().nonnegative(),
  closed: z.boolean().nullable(), month: window.nullable(), allTime: window.nullable(), history: window.nullable(),
  tradeCount: z.number().int().nonnegative().nullable(), links: z.array(addressSchema).optional(),
  avgLeverage: optionalMetric, timeInMarket: optionalMetric, medianHoldHours: optionalMetric, makerShare: optionalMetric,
}).strict();
const candidateSchema = z.object({ address: addressSchema, accountValueOrTvlUsd: decimalSchema,
  valueSource: z.enum(["leaderboard-account-value", "hypercore-vault-tvl"]),
  sources: z.array(z.enum(["leaderboard", "hypercore-vault-list"])), name: z.string().nullable(),
  knownHypercoreVault: z.boolean(), leaderAddress: addressSchema.nullable(),
}).strict();
const blobSchema = z.object({ fetchedAt: z.string().datetime(), sha256: z.string().regex(/^[a-f0-9]{64}$/), raw: z.string() }).strict();
const evidenceSchema = z.object({ schema: z.literal("score-evidence.v1"), address: addressSchema,
  portfolio: blobSchema, fills: blobSchema.nullable(), classificationAt: z.string().datetime(),
  classification: z.object({ kind, evidence: z.enum(["vault-list", "no-hyperevm-code", "erc4626-probes", "contract-probes-failed"]),
    blockNumber: z.string().optional(), asset: addressSchema.optional(), totalAssets: decimalSchema.optional(),
  }).strict(),
}).strict();

export function freshAccounts(accounts: Account[], now: number) {
  return accounts.filter(a => a.basis === "verified-input" && a.classification !== null
    && Date.parse(a.fetchedAt) <= now && now - Date.parse(a.fetchedAt) <= 86_400_000);
}

export async function activateFreshRegistry(store: LoopStore, now: number, assertOwner: () => void = () => {}) {
  const accounts = store.accounts(), fresh = freshAccounts(accounts, now), selected = await rankAsync(accounts, now);
  const ready = selected.length === TARGET_COUNT, scoreSourceSha256 = await scoreSourceHash();
  const status = { at: now, ready, freshAccounts: fresh.length, totalAccounts: accounts.length,
    selectionScope: fresh.length === accounts.length ? "complete-imported-registry" : "fresh-subset-of-imported-registry",
    selected: selected.length, scoreSourceSha256 };
  store.db.transaction(() => {
    assertOwner();
    if (ready) {
      store.setState("selection", { generatedAt: now, selected, scoreSourceSha256, scope: status.selectionScope });
      store.setState("bootstrapComplete", status);
    } else {
      store.setState("selection", null);
      store.setState("bootstrapComplete", null);
    }
    store.setState("releaseReadiness", status);
  })();
  return status;
}

/** Portable release -> private local registry. No Bradley filesystem or running DB is needed. */
export async function importRelease(directory: string, store: LoopStore, now = Date.now()) {
  if (store.accounts().length || store.state("seed")) throw new Error("Destination registry must be empty");
  const manifest = await verifyAssets(directory, RELEASE_ASSETS);
  const manifestRaw = await readFile(join(directory, "manifest.json"), "utf8");
  const expected = (name: string) => (manifest.files as Asset[]).find(a => a.file === name)!.rows;
  const discovered = new Map<string, z.infer<typeof candidateSchema>>(), inputs = new Map<string, ScoreInput>();
  for await (const row of readGzipRows(join(directory, RELEASE_ASSETS[0]))) {
    const candidate = candidateSchema.parse(row);
    if (discovered.has(candidate.address)) throw new Error("Duplicate discovery address");
    discovered.set(candidate.address, candidate);
  }
  for await (const row of readGzipRows(join(directory, RELEASE_ASSETS[1]))) {
    const input = inputSchema.parse(row);
    if (inputs.has(input.address)) throw new Error("Duplicate Score input address");
    inputs.set(input.address, input);
  }
  if (discovered.size !== expected(RELEASE_ASSETS[0]) || inputs.size !== expected(RELEASE_ASSETS[1])
    || inputs.size !== manifest.counts.scoreInputs) throw new Error("Release row counts disagree");
  const seen = new Set<string>();
  // Evidence can be hundreds of MB compressed. Stream rows and commit at the end,
  // so corrupt or incomplete exports cannot leave a partly usable registry.
  store.db.exec("BEGIN");
  try {
    for await (const row of readGzipRows(join(directory, RELEASE_ASSETS[2]))) {
      const evidence = evidenceSchema.parse(row), input = inputs.get(evidence.address), candidate = discovered.get(evidence.address);
      if (!input || !candidate || seen.has(evidence.address)) throw new Error("Missing/duplicate release account");
      if (digest(evidence.portfolio.raw) !== evidence.portfolio.sha256
        || (evidence.fills && digest(evidence.fills.raw) !== evidence.fills.sha256)) throw new Error("Release raw evidence hash mismatch");
      const windows = parsePortfolio(JSON.parse(evidence.portfolio.raw));
      const tradeCount = orderEvidence(evidence.fills ? JSON.parse(evidence.fills.raw) : null,
        input.month?.pnlHistory.at(-1)?.[0] ?? 0).tradeCount;
      if (!isDeepStrictEqual(windows.month, input.month) || !isDeepStrictEqual(windows.allTime, input.allTime)
        || input.kind !== evidence.classification.kind || input.tradeCount !== tradeCount
        || (candidate.knownHypercoreVault && input.kind !== "hypercore-vault")) throw new Error("Release input disagrees with raw evidence");
      if (Date.parse(evidence.portfolio.fetchedAt) > now || Date.parse(evidence.classificationAt) > now
        || (evidence.fills && Date.parse(evidence.fills.fetchedAt) > now)
        || [input.month, input.allTime, input.history].some(w => w && [...w.pnlHistory, ...w.accountValueHistory]
          .some(([ts]) => ts > Date.parse(evidence.portfolio.fetchedAt)))) throw new Error("Future-dated release evidence");
      store.putAccount({ candidate, input, fetchedAt: evidence.portfolio.fetchedAt,
        rawHash: store.blob(evidence.portfolio.raw), classification: evidence.classification,
        classificationAt: evidence.classificationAt, fillsHash: evidence.fills ? store.blob(evidence.fills.raw) : null,
        fillsCheckedAt: evidence.fills?.fetchedAt ?? null, basis: "verified-input" });
      seen.add(evidence.address);
    }
    if (seen.size !== inputs.size || seen.size !== expected(RELEASE_ASSETS[2])) throw new Error("Missing release evidence rows");
    // This old-data queue is only an acquisition priority. It cannot become a
    // current selection until official refresh + the unchanged freshness check.
    const historic = scoreCandidates([...inputs.values()]);
    store.setState("releaseRefreshQueue", historic.candidates.map(c => c.address));
    store.setState("seed", { schema: "ingest-release-import.v1", importedAt: new Date(now).toISOString(),
      accounts: seen.size, source: "github-score-data-release", releaseManifestSha256: digest(manifestRaw),
      releaseCodeCommit: manifest.codeCommit ?? null, releaseScoreSourceSha256: manifest.scoreSourceSha256 ?? null,
      releaseExportedAt: manifest.exportedAt, assets: manifest.files.filter((a: Asset) => RELEASE_ASSETS.includes(a.file as typeof RELEASE_ASSETS[number])),
      excludedBeforeEvidence: manifest.counts.excludedBeforeEvidence ?? null });
    store.db.exec("COMMIT");
  } catch (error) { if (store.db.inTransaction) store.db.exec("ROLLBACK"); throw error; }
  const readiness = await activateFreshRegistry(store, now);
  return { marker: "INGEST_RELEASE_IMPORTED", imported: seen.size, ...readiness, provenance: store.state("seed") };
}
