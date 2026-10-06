import { z } from "zod";
import { parsePortfolio, validateSeries, type ScoreInput } from "../score";
import { historyBefore, mergeHistory, normalizedMonth, type HistoryRow } from "./history";
import { toScoreInput } from "./score-input";
import { addressSchema, decimalSchema, type Candidate, type CollectionRecord } from "./types";
import type { DbRow, Snapshot, Table } from "./sync-snapshot";

// Both adapters expose the same rows. The remote adapter needs only SELECT access.
export type ScoreSnapshot = Pick<Snapshot, "run" | "candidateRows" | "portfolioRows">;
export type SnapshotReader = { read(table: Table, runId: string): Promise<DbRow[]> };
export type LoadIssue = { runId: string; address: string | null; stage: "input" | "history"; reason: string };

const runIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const runSchema = z.object({
  run_id: runIdSchema,
  candidate_count: z.number().int().nonnegative(), portfolio_count: z.number().int().nonnegative(),
  manifest: z.object({
    runId: runIdSchema, status: z.literal("complete"),
    startedAt: z.string().datetime(), finishedAt: z.string().datetime(),
  }).passthrough(),
}).passthrough();
const candidateSchema = z.object({
  address: addressSchema, accountValueOrTvlUsd: decimalSchema,
  valueSource: z.enum(["leaderboard-account-value", "hypercore-vault-tvl"]),
  sources: z.array(z.enum(["leaderboard", "hypercore-vault-list"])),
  name: z.string().nullable(), knownHypercoreVault: z.boolean(), leaderAddress: addressSchema.nullable(),
});
const kindSchema = z.enum(["trader", "hypercore-vault", "erc4626-vault"]);
const candidateRowSchema = z.object({
  run_id: runIdSchema, address: addressSchema, account_value_or_tvl_usd: decimalSchema,
  kind: kindSchema.nullable(), shortlisted: z.boolean(), candidate: candidateSchema,
});
const recordSchema = z.object({
  address: addressSchema,
  classification: z.object({
    kind: kindSchema,
    evidence: z.enum(["vault-list", "no-hyperevm-code", "erc4626-probes", "contract-probes-failed"]),
  }).passthrough().nullable(),
  classificationError: z.string().nullable(), portfolioError: z.string().nullable(),
  portfolio: z.object({
    path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), fetchedAt: z.string().datetime(),
    windows: z.unknown(),
  }).nullable(),
});
const portfolioRowSchema = z.object({
  run_id: runIdSchema, address: addressSchema, record: recordSchema, portfolio: z.unknown(),
});

function checkedRun(snapshot: ScoreSnapshot) {
  const run = runSchema.parse(snapshot.run);
  if (run.run_id !== run.manifest.runId) throw new Error("Run ID disagrees with manifest");
  if (Date.parse(run.manifest.startedAt) > Date.parse(run.manifest.finishedAt)) throw new Error("Invalid run time range");
  if (run.candidate_count !== snapshot.candidateRows.length || run.portfolio_count !== snapshot.portfolioRows.length) {
    throw new Error("Snapshot row counts disagree with manifest import");
  }
  return run;
}

function joinedRows(snapshot: ScoreSnapshot) {
  const run = checkedRun(snapshot);
  const candidates = snapshot.candidateRows.map(r => candidateRowSchema.parse(r));
  const portfolios = snapshot.portfolioRows.map(r => portfolioRowSchema.parse(r));
  const byAddress = new Map(candidates.map(c => [c.address, c]));
  if (byAddress.size !== candidates.length || new Set(portfolios.map(p => p.address)).size !== portfolios.length) {
    throw new Error("Duplicate snapshot address");
  }
  for (const c of candidates) {
    if (c.run_id !== run.run_id || c.address !== c.candidate.address
      || c.account_value_or_tvl_usd !== c.candidate.accountValueOrTvlUsd) throw new Error("Candidate row identity/value mismatch");
  }
  if (candidates.filter(c => c.shortlisted).length !== portfolios.length) throw new Error("Shortlist coverage mismatch");
  const rows = portfolios.map(p => {
    const c = byAddress.get(p.address);
    if (p.run_id !== run.run_id || p.address !== p.record.address || !c?.shortlisted) throw new Error("Portfolio row identity/shortlist mismatch");
    if (c.kind !== (p.record.classification?.kind ?? null)
      && !(c.candidate.knownHypercoreVault && p.record.classification === null)) throw new Error("Classification columns disagree");
    if (c.candidate.knownHypercoreVault && p.record.classification && p.record.classification.kind !== "hypercore-vault") {
      throw new Error("Official vault classification mismatch");
    }
    const fetchedAt = p.record.portfolio?.fetchedAt;
    if (fetchedAt && (Date.parse(fetchedAt) < Date.parse(run.manifest.startedAt)
      || Date.parse(fetchedAt) > Date.parse(run.manifest.finishedAt))) throw new Error("Portfolio fetch outside run");
    return { candidate: c.candidate as Candidate, record: p.record as CollectionRecord, raw: p.portfolio };
  });
  return { run, rows };
}

/** Reads only completed, immutable snapshots; never invokes a sync/write or the Hyperliquid API. */
export async function readScoreSnapshot(reader: SnapshotReader, runId: string): Promise<ScoreSnapshot> {
  runIdSchema.parse(runId);
  const runs = await reader.read("ingest_runs", runId);
  if (runs.length !== 1 || runs[0].run_id !== runId || runs[0].sync_status !== "complete") throw new Error("Score requires one sync_status=complete run");
  const [candidateRows, portfolioRows] = await Promise.all([
    reader.read("ingest_candidates", runId), reader.read("ingest_portfolios", runId),
  ]);
  const snapshot = { run: runs[0], candidateRows, portfolioRows };
  joinedRows(snapshot);
  return snapshot;
}

/** Pure rows -> ScoreInput[] conversion. History observations after this run are never used. */
export function buildScoreInputs(current: ScoreSnapshot, older: ScoreSnapshot[] = [],
  fillsByAddress: ReadonlyMap<string, unknown> = new Map()) {
  const target = joinedRows(current);
  const cutoff = Date.parse(target.run.manifest.finishedAt);
  const issues: LoadIssue[] = [];
  const historyRows: HistoryRow[] = [];
  const selected = new Set(target.rows.map(r => r.candidate.address));
  const acquiredAt = new Map(target.rows.map(r => [r.candidate.address, Date.parse(r.record.portfolio?.fetchedAt ?? "")]));
  const sourceRunIds: string[] = [];
  const ignoredFutureRuns: string[] = [];
  const ignoredFutureObservations: { runId: string; address: string }[] = [];
  const seen = new Set([target.run.run_id]);
  for (const snapshot of older) {
    const run = checkedRun(snapshot);
    if (seen.has(run.run_id)) throw new Error("Duplicate current/history run ID");
    seen.add(run.run_id);
    if (Date.parse(run.manifest.finishedAt) > cutoff) { ignoredFutureRuns.push(run.run_id); continue; }
    const history = joinedRows(snapshot);
    sourceRunIds.push(run.run_id);
    for (const { candidate, record, raw } of history.rows) {
      if (!selected.has(candidate.address)) continue;
      try {
        if (record.portfolioError || !record.portfolio) throw new Error("Missing or failed historical portfolio");
        if (Date.parse(record.portfolio.fetchedAt) > (acquiredAt.get(candidate.address) ?? cutoff)) {
          ignoredFutureObservations.push({ runId: run.run_id, address: candidate.address });
          continue;
        }
        const points = normalizedMonth(candidate.address, raw, record.portfolio.fetchedAt, run.run_id);
        if (points.some(p => p.tsMs > Date.parse(record.portfolio!.fetchedAt))) throw new Error("History timestamp after fetch");
        historyRows.push(...points);
      } catch (error) {
        issues.push({ runId: run.run_id, address: candidate.address, stage: "history", reason: String(error) });
      }
    }
  }
  const merged = mergeHistory(historyRows);
  // Score can only compare shared timestamps. Off-grid revisions must not silently
  // enter its return series; preserve the audit and fall back to the current windows.
  const excludedAddresses = new Set(merged.mismatches.map(m => m.address.toLowerCase()));
  const inputs: ScoreInput[] = [];
  for (const { candidate, record, raw } of target.rows) {
    try {
      if (!record.portfolio) throw new Error("Missing portfolio evidence");
      const input = toScoreInput(candidate, record, raw, fillsByAddress.get(candidate.address));
      if (!input) throw new Error("Unverified classification or failed portfolio");
      const { month, allTime } = parsePortfolio(raw);
      // Keep invalid series visible to Score as unknown, including their links, but never silently repair them.
      if (!validateSeries(month) || !validateSeries(allTime)) {
        issues.push({ runId: target.run.run_id, address: input.address, stage: "input", reason: "Invalid/missing month or allTime series; Score validation applies" });
      }
      const histories = [month, allTime].filter(h => h !== null);
      if (histories.some(h => [...h.accountValueHistory, ...h.pnlHistory].some(([ts]) => ts > Date.parse(record.portfolio!.fetchedAt)))) {
        throw new Error("Portfolio timestamp after fetch");
      }
      if (excludedAddresses.has(input.address)) {
        issues.push({ runId: target.run.run_id, address: input.address, stage: "history",
          reason: "Conflicting stored history; history excluded, current month/allTime retained" });
      } else {
        input.history = historyBefore(merged.rows, input.address, month?.pnlHistory[0]?.[0] ?? 0);
      }
      inputs.push(input);
    } catch (error) {
      issues.push({ runId: target.run.run_id, address: candidate.address, stage: "input", reason: String(error) });
    }
  }
  inputs.sort((a, b) => a.address.localeCompare(b.address));
  return {
    inputs, issues, sourceRun: target.run.run_id, asOf: target.run.manifest.finishedAt,
    sourceRunIds: sourceRunIds.sort(), ignoredFutureRuns: ignoredFutureRuns.sort(), ignoredFutureObservations,
    counts: { selected: target.rows.length, loaded: inputs.length, omitted: target.rows.length - inputs.length,
      unknownTradeCount: inputs.filter(i => i.tradeCount === null).length,
      withHistory: inputs.filter(i => i.history !== null).length },
    historyAudit: { inputPoints: historyRows.length, uniquePoints: merged.rows.length, mismatches: merged.mismatches,
      excludedAddresses: [...excludedAddresses].sort() },
  };
}
