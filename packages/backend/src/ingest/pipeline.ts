import { randomUUID } from "node:crypto";
import { classify } from "./classify";
import { ReadClient, SOURCES } from "./client";
import { discover } from "./discovery";
import { digest, SnapshotStore, type SourceEntry, type SourceName } from "./store";
import { MIN_EQUITY_USD, summarizePortfolio, type CollectionRecord } from "./types";

export type IngestOptions = {
  output: string;
  limit: number;
  cacheHours: number;
  refresh: boolean;
  onProgress?: (message: string) => void;
};

export async function ingest(options: IngestOptions, dependencies?: {
  downloads?: ReadClient;
  info?: ReadClient;
  rpc?: ReadClient;
}) {
  const store = new SnapshotStore(options.output);
  const downloads = dependencies?.downloads ?? new ReadClient({ spacingMs: 0 });
  const info = dependencies?.info ?? new ReadClient({ spacingMs: 1500 });
  const rpc = dependencies?.rpc ?? new ReadClient({ spacingMs: 200 });
  const log = options.onProgress ?? (() => {});
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const dir = `runs/${runId}`;
  const sourceRecords: Partial<Record<SourceName, SourceEntry & { cacheHit: boolean; path: string }>> = {};
  const load = async (name: SourceName) => {
    const url = SOURCES[name];
    const cached = options.refresh ? null : await store.cached(name, url, options.cacheHours * 3600000);
    log(`${name}: ${cached ? "cache hit" : "downloading"}`);
    const raw = cached?.raw ?? await downloads.request(url, undefined, 180000, 64 * 1024 * 1024);
    const entry = cached?.entry ?? await store.cache(name, raw, url, new Date().toISOString());
    sourceRecords[name] = { ...entry, cacheHit: !!cached, path: `blobs/${entry.sha256}.json` };
    return JSON.parse(raw) as unknown;
  };
  // Store a journal before making requests so interrupted runs are visible.
  await store.json(`${dir}/manifest.json`, { schemaVersion: "ingest.v1", runId, startedAt, status: "running" });
  try {
    const [leaderboard, vaults] = await Promise.all([load("leaderboard"), load("vaults")]);
    const discovery = discover(leaderboard, vaults, options.limit);
    await store.json(`${dir}/candidates.json`, discovery.candidates);
    await store.json(`${dir}/shortlist.json`, discovery.shortlist);
    log(`prefilter: ${discovery.stats.eligibleUniqueAddresses} unique addresses; collecting ${discovery.shortlist.length}`);
    let blockNumber: `0x${string}` | null = null;
    let chainId: string | null = null;
    let chainError: string | null = null;
    if (discovery.shortlist.some((c) => !c.knownHypercoreVault)) {
      try {
        chainId = await rpc.rpc("eth_chainId", []);
        blockNumber = await rpc.rpc("eth_blockNumber", []);
        if (blockNumber === "0x") throw new Error("Missing block number");
      } catch (e) { chainError = (e as Error).message; }
    }
    const records: CollectionRecord[] = [];
    for (const [index, candidate] of discovery.shortlist.entries()) {
      const record: CollectionRecord = {
        address: candidate.address, classification: null, classificationError: null,
        portfolio: null, portfolioError: null,
      };
      try {
        if (!candidate.knownHypercoreVault && !blockNumber) throw new Error(chainError ?? "No HyperEVM block available");
        record.classification = await classify(candidate, rpc, blockNumber ?? "0x0");
      } catch (e) { record.classificationError = (e as Error).message; }
      try {
        const raw = await info.request(SOURCES.info, { type: "portfolio", user: candidate.address });
        const fetchedAt = new Date().toISOString();
        const path = `${dir}/portfolios/${candidate.address}.json`;
        await store.write(path, raw);
        record.portfolio = { path, sha256: digest(raw), fetchedAt, windows: null };
        record.portfolio.windows = summarizePortfolio(JSON.parse(raw));
      } catch (e) { record.portfolioError = (e as Error).message; }
      records.push(record);
      // Each completed address is durable even if the next request or process fails.
      await store.json(`${dir}/records/${candidate.address}.json`, record);
      log(`[${index + 1}/${discovery.shortlist.length}] ${candidate.address} ${record.classification?.kind ?? "unknown"} portfolio=${record.portfolioError ? "error" : "ok"}`);
    }
    await store.json(`${dir}/records.json`, records);
    const failures = records.filter((r) => r.classificationError || r.portfolioError).length;
    const manifest = {
      schemaVersion: "ingest.v1", runId, startedAt, finishedAt: new Date().toISOString(),
      status: failures ? "partial" : "complete",
      config: { minAccountValueOrTvlUsd: MIN_EQUITY_USD, limit: options.limit, cacheHours: options.cacheHours },
      selection: "accountValueOrTvlUsd descending, address ascending; collection priority only, not a performance score",
      sources: sourceRecords,
      chain: { url: SOURCES.hyperevm, chainId, blockNumber, error: chainError },
      stats: { ...discovery.stats, successfulPortfolios: records.filter((r) => !r.portfolioError).length, failedAddresses: failures },
      files: { candidates: `${dir}/candidates.json`, shortlist: `${dir}/shortlist.json`, records: `${dir}/records.json` },
      limitations: [
        "Current-snapshot universe, not a historical survivor-free universe.",
        "Raw portfolio windows are saved without resampling, return calculation, scoring or history-length filtering.",
        "ERC-4626 labeling checks bytecode and two read methods; it is a heuristic, not a contract audit.",
        "Source file capture, account queries and HyperEVM block are separately timestamped, not one atomic exchange snapshot.",
        "Unknown classification/network errors are recorded and never relabeled as traders.",
      ],
    };
    await store.json(`${dir}/manifest.json`, manifest);
    // Do not replace the latest usable dataset with a partial/error run.
    if (!failures) await store.json("latest.json", { runId, manifest: `${dir}/manifest.json` });
    return manifest;
  } catch (error) {
    await store.json(`${dir}/manifest.json`, {
      schemaVersion: "ingest.v1", runId, startedAt, finishedAt: new Date().toISOString(),
      status: "failed", sources: sourceRecords, error: (error as Error).message,
    });
    throw error;
  }
}
