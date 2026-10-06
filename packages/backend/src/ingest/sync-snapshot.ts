import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { digest } from "./store";
import { addressSchema, decimalSchema, summarizePortfolio, type Candidate, type CollectionRecord } from "./types";

export type DbRow = Record<string, unknown>;
export type Table = "ingest_runs" | "ingest_candidates" | "ingest_portfolios" | "ingest_sources";
const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const candidateSchema = z.object({
  address: addressSchema, accountValueOrTvlUsd: decimalSchema,
  knownHypercoreVault: z.boolean(),
}).passthrough();
const recordSchema = z.object({
  address: addressSchema,
  classification: z.object({ kind: z.enum(["trader", "hypercore-vault", "erc4626-vault"]) }).passthrough().nullable(),
  classificationError: z.string().nullable(), portfolioError: z.string().nullable(),
  portfolio: z.object({ path: z.string(), sha256: hashSchema }).passthrough().nullable(),
}).passthrough();

export async function loadSnapshot(output: string, requestedRunId?: string) {
  const root = await realpath(output);
  const read = async (relative: string) => {
    const path = await realpath(resolve(root, relative));
    if (!path.startsWith(root + sep)) throw new Error("Snapshot path escapes output directory");
    return readFile(path, "utf8");
  };
  const runId = runIdSchema.parse(requestedRunId ?? JSON.parse(await read("latest.json")).runId);
  const manifestPath = `runs/${runId}/manifest.json`;
  const rawManifest = await read(manifestPath);
  const manifest = z.object({
    schemaVersion: z.literal("ingest.v1"), runId: runIdSchema,
    status: z.enum(["complete", "partial"]),
    stats: z.object({ eligibleUniqueAddresses: z.number().int(), shortlisted: z.number().int() }).passthrough(),
    files: z.object({ candidates: z.string(), shortlist: z.string(), records: z.string() }),
    sources: z.object({ leaderboard: z.unknown(), vaults: z.unknown() }),
  }).passthrough().parse(JSON.parse(rawManifest));
  if (manifest.runId !== runId) throw new Error("Run ID does not match manifest");
  const archive: Record<string, string> = { [manifestPath]: rawManifest };
  for (const path of Object.values(manifest.files)) archive[path] = await read(path);
  const candidates = z.array(candidateSchema).parse(JSON.parse(archive[manifest.files.candidates])) as Candidate[];
  const shortlist = z.array(candidateSchema).parse(JSON.parse(archive[manifest.files.shortlist])) as Candidate[];
  const records = z.array(recordSchema).parse(JSON.parse(archive[manifest.files.records])) as CollectionRecord[];
  const byAddress = new Map(candidates.map((c) => [c.address, c]));
  const selected = new Set(shortlist.map((c) => c.address));
  const recorded = new Set(records.map((r) => r.address));
  if (candidates.length !== manifest.stats.eligibleUniqueAddresses || records.length !== manifest.stats.shortlisted
    || byAddress.size !== candidates.length || selected.size !== shortlist.length || recorded.size !== records.length
    || selected.size !== recorded.size || shortlist.some((c) => !isDeepStrictEqual(c, byAddress.get(c.address)))
    || records.some((r) => !selected.has(r.address))) throw new Error("Snapshot counts or addresses do not match");
  const kinds = new Map(records.map((r) => [r.address, r.classification?.kind ?? null]));
  const candidateRows: DbRow[] = candidates.map((c) => ({
    run_id: runId, address: c.address, account_value_or_tvl_usd: c.accountValueOrTvlUsd,
    kind: c.knownHypercoreVault ? "hypercore-vault" : kinds.get(c.address) ?? null,
    shortlisted: selected.has(c.address), candidate: c,
  }));
  const portfolioRows: DbRow[] = [];
  for (const record of records) {
    let portfolio: unknown = null;
    if (record.portfolio) {
      const raw = await read(record.portfolio.path);
      if (digest(raw) !== record.portfolio.sha256) throw new Error("Portfolio hash mismatch");
      archive[record.portfolio.path] = raw;
      // Preserve invalid payload text in the archive; do not manufacture valid history.
      try { portfolio = JSON.parse(raw); } catch { if (!record.portfolioError) throw new Error("Invalid portfolio JSON"); }
      if (!record.portfolioError) summarizePortfolio(portfolio);
    } else if (!record.portfolioError) throw new Error("Portfolio missing without an error record");
    portfolioRows.push({ run_id: runId, address: record.address, record, portfolio });
  }
  const objects: { path: string; bytes: Uint8Array }[] = [];
  const sourceRows: DbRow[] = [];
  for (const name of ["leaderboard", "vaults"] as const) {
    const source = z.object({ path: z.string(), sha256: hashSchema, bytes: z.number().int() })
      .passthrough().parse(manifest.sources[name]);
    const raw = await read(source.path);
    if (digest(raw) !== source.sha256 || Buffer.byteLength(raw) !== source.bytes) throw new Error("Source hash mismatch");
    const path = `sources/${source.sha256}.json.gz`;
    objects.push({ path, bytes: gzipSync(raw) });
    sourceRows.push({ run_id: runId, name, source, storage_path: path });
  }
  const rawArchive = JSON.stringify({ format: "perpparrot-ingest-archive.v1", files: archive });
  const archivePath = `runs/${runId}/${digest(rawArchive)}.json.gz`;
  objects.push({ path: archivePath, bytes: gzipSync(rawArchive) });
  const run: DbRow = {
    run_id: runId, manifest, manifest_sha256: digest(rawManifest), archive_path: archivePath,
    candidate_count: candidates.length, portfolio_count: records.length,
  };
  return { runId, run, candidateRows, portfolioRows, sourceRows, objects };
}

export type Snapshot = Awaited<ReturnType<typeof loadSnapshot>>;
