import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parsePortfolio } from "../score/parse";
import { deriveSourceFeatures, spearman, type SourceFeatures } from "./source-features";

const trials = 20_000;
const cohortPath = process.argv[2] ?? "work/backtests/active-quality-cohort-20261006.json";
const backtestPath = process.argv[3] ?? "work/backtests/active-quality-backtest-20261006.json";
const eventPath = process.argv[4] ?? "work/backtests/active-quality-ledger-features-20261006.json";
const outputPath = process.argv[5] ?? "work/backtests/active-feature-exploration-20261006.json";

type Cohort = { trainingWindow: { startMs: number; cutoffMs: number }; accepted: { address: string; portfolio: unknown; trainingFills: Record<string, unknown>[]; fillCountCensoredAt2000: boolean; fillHash: string }[] };
type EventCapture = { trainingWindow: { startMs: number; cutoffMs: number }; data: Record<string, Record<string, { records: Record<string, unknown>[]; complete: boolean; errors: string[] }>> };
type Result = { asOfMs: number; result: { sources: { address: string; rank: number; selected: boolean; testReturn: number }[] } };

function rank(values: number[]): number[] {
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end].value === sorted[start].value) end++;
    const value = (start + 1 + end) / 2;
    for (let index = start; index < end; index++) ranks[sorted[index].index] = value;
    start = end;
  }
  return ranks;
}

function pearson(x: number[], y: number[]): number | null {
  const rx = rank(x); const ry = rank(y);
  const mx = rx.reduce((sum, value) => sum + value, 0) / rx.length;
  const my = ry.reduce((sum, value) => sum + value, 0) / ry.length;
  const covariance = rx.reduce((sum, value, i) => sum + (value - mx) * (ry[i] - my), 0);
  const sx = Math.sqrt(rx.reduce((sum, value) => sum + (value - mx) ** 2, 0));
  const sy = Math.sqrt(ry.reduce((sum, value) => sum + (value - my) ** 2, 0));
  return sx === 0 || sy === 0 ? null : covariance / (sx * sy);
}

function permutationP(x: number[], y: number[], observed: number, seed: number): number {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  let extreme = 0;
  for (let trial = 0; trial < trials; trial++) {
    const shuffled = [...y];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const candidate = pearson(x, shuffled);
    if (candidate !== null && Math.abs(candidate) >= Math.abs(observed) - 1e-12) extreme++;
  }
  return (extreme + 1) / (trials + 1);
}

function benjaminiHochberg(values: number[]): number[] {
  const order = values.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const result = new Array<number>(values.length);
  let running = 1;
  for (let i = order.length - 1; i >= 0; i--) {
    running = Math.min(running, order[i].p * values.length / (i + 1));
    result[order[i].index] = running;
  }
  return result;
}

async function main(): Promise<void> {
  const cohort = JSON.parse(await readFile(cohortPath, "utf8")) as Cohort;
  const backtest = JSON.parse(await readFile(backtestPath, "utf8")) as Result;
  const capture = JSON.parse(await readFile(eventPath, "utf8")) as EventCapture;
  if (cohort.trainingWindow.startMs !== capture.trainingWindow.startMs || cohort.trainingWindow.cutoffMs !== capture.trainingWindow.cutoffMs) throw new Error("event window does not match frozen cohort window");
  const outcomes = new Map(backtest.result.sources.map((row) => [row.address.toLowerCase(), row]));
  const rows = cohort.accepted.flatMap((source) => {
    const address = source.address.toLowerCase();
    const outcome = outcomes.get(address);
    const events = capture.data[address];
    if (!outcome || !events || !events.userFunding.complete || !events.userNonFundingLedgerUpdates.complete || events.userFunding.errors.length || events.userNonFundingLedgerUpdates.errors.length) return [];
    const month = parsePortfolio(source.portfolio).month;
    if (!month) throw new Error(`missing monthly history: ${address}`);
    const priorPoints = month.accountValueHistory.filter(([time]) => time <= cohort.trainingWindow.startMs);
    const startingEquity = priorPoints.at(-1)?.[1] ?? null;
    const features = deriveSourceFeatures({
      address,
      startMs: cohort.trainingWindow.startMs,
      cutoffMs: cohort.trainingWindow.cutoffMs,
      startingEquity,
      evidence: {
        userFillsByTime: source.trainingFills,
        userFunding: events.userFunding.records,
        userNonFundingLedgerUpdates: events.userNonFundingLedgerUpdates.records,
      },
    });
    const completeFeatures: SourceFeatures = source.fillCountCensoredAt2000
      ? { ...features, fillCount: null, logTurnoverToEquity: null, makerNotionalShare: null, feeBpsOfNotional: null, assetNotionalHhi: null, logAssetCount: null }
      : features;
    return [{ address, rank: outcome.rank, selected: outcome.selected, holdoutReturn: outcome.testReturn, trainingFillCensored: source.fillCountCensoredAt2000, features: completeFeatures }];
  });
  if (rows.length < 5) throw new Error("too few complete evidence rows for exploration");
  const names = Object.keys(rows[0].features) as (keyof SourceFeatures)[];
  const correlations = names.map((name, index) => {
    const paired = rows.filter((row) => row.features[name] !== null);
    const result = spearman(paired.map((row) => row.features[name]), paired.map((row) => row.holdoutReturn));
    if (result.rho === null || paired.length < 4) return { feature: name, n: result.n, spearmanRho: result.rho, permutationP: null as number | null };
    return { feature: name, n: result.n, spearmanRho: result.rho, permutationP: permutationP(paired.map((row) => row.features[name]!), paired.map((row) => row.holdoutReturn), result.rho, 20261006 + index) };
  });
  const tested = correlations.filter((row): row is typeof row & { permutationP: number } => row.permutationP !== null);
  const q = benjaminiHochberg(tested.map((row) => row.permutationP));
  tested.forEach((row, index) => Object.assign(row, { bhQValue: q[index] }));

  const cohortAddresses = new Set(rows.map((row) => row.address));
  const counterparties = new Map<string, Set<string>>();
  const directTransfers = new Map<string, { count: number; usd: number }>();
  for (const row of rows) {
    for (const event of capture.data[row.address].userNonFundingLedgerUpdates.records) {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type !== "send") continue;
      const sender = typeof delta.user === "string" ? delta.user.toLowerCase() : null;
      const receiver = typeof delta.destination === "string" ? delta.destination.toLowerCase() : null;
      if (!sender || !receiver || sender === receiver) continue;
      const wallet = cohortAddresses.has(sender) ? sender : cohortAddresses.has(receiver) ? receiver : null;
      const other = wallet === sender ? receiver : wallet === receiver ? sender : null;
      if (wallet && other) {
        if (!counterparties.has(wallet)) counterparties.set(wallet, new Set());
        counterparties.get(wallet)!.add(other);
      }
      if (cohortAddresses.has(sender) && cohortAddresses.has(receiver)) {
        const key = `${sender}->${receiver}`;
        const item = directTransfers.get(key) ?? { count: 0, usd: 0 };
        item.count++;
        const value = Number(delta.usdcValue ?? (delta.token === "USDC" ? delta.amount : 0));
        if (Number.isFinite(value) && value >= 0) item.usd += value;
        directTransfers.set(key, item);
      }
    }
  }
  const walletAddresses = [...counterparties.keys()];
  const sharedCounterpartyPairs = walletAddresses.flatMap((a, index) => walletAddresses.slice(index + 1).flatMap((b) => {
    const common = [...counterparties.get(a)!].filter((item) => counterparties.get(b)!.has(item));
    return common.length ? [{ a, b, sharedCounterpartyCount: common.length }] : [];
  }));
  const ledgerCounts = rows.map((row) => ({ address: row.address, events: row.features.ledgerEventCount, counterparties: row.features.distinctTransferCounterparties }));
  const transferHeavy = [...ledgerCounts].sort((a, b) => b.events - a.events)[0];
  const sharedCount = new Map<string, Set<string>>();
  for (const [wallet, others] of counterparties) for (const other of others) {
    if (!sharedCount.has(other)) sharedCount.set(other, new Set());
    sharedCount.get(other)!.add(wallet);
  }
  const topSharedCounterparties = [...sharedCount]
    .filter(([, wallets]) => wallets.size > 1)
    .map(([counterparty, wallets]) => ({ counterparty, sourceWalletCount: wallets.size }))
    .sort((a, b) => b.sourceWalletCount - a.sourceWalletCount || a.counterparty.localeCompare(b.counterparty));
  const leaveOneSourceOut = correlations.map((row) => {
    const name = row.feature as keyof SourceFeatures;
    const points = rows.filter((item) => item.features[name] !== null);
    const values = points.map((item) => item.features[name]!);
    const labels = points.map((item) => item.holdoutReturn);
    const coefficients = points.map((_, skip) => spearman(values.filter((__, i) => i !== skip), labels.filter((__, i) => i !== skip)).rho).filter((value): value is number => value !== null);
    return { feature: name, minLeaveOneOutRho: coefficients.length ? Math.min(...coefficients) : null, maxLeaveOneOutRho: coefficients.length ? Math.max(...coefficients) : null };
  });
  const report = {
    schemaVersion: 1,
    sample: {
      screened: cohort.accepted.length,
      qualityQualified: rows.length,
      fillFeatureComplete: rows.filter((row) => !row.trainingFillCensored).length,
      leaderboardSelection: "deterministic random cohort from current public leaderboard; $10k+ equity; >=9 pre-cutoff portfolio points; >=10 fills in prior 14 days; no return threshold",
      cutoffMs: cohort.trainingWindow.cutoffMs,
      outcomeEndMs: backtest.asOfMs,
    },
    correlations: {
      method: `Spearman correlation; two-sided Monte Carlo permutation (${trials} trials/feature); BH q-values; descriptive only; null means unavailable/censored, not zero`,
      outcomes: correlations,
      leaveOneSourceOutSensitivity: leaveOneSourceOut,
    },
    walletNetwork: {
      directTransfersWithinCohort: [...directTransfers].map(([edge, value]) => ({ edge, ...value })),
      sharedCounterpartyPairs,
      topSharedCounterparties,
      topLedgerActivity: transferHeavy,
      interpretation: "Observable address flow is a lead for identity/funding investigation only; shared flows do not establish common control, copying, manipulation, or misconduct.",
    },
    rows,
    limitations: [
      "The earlier 12-wallet holdout has already been inspected; this is post-hoc discovery on another sample from the same dates, not independent confirmation.",
      "The cohort is current-leaderboard sampled and activity/equity conditioned, so survivorship and selection effects remain.",
      "Five of the 43 analyzed sources had fills capped at 2,000; fill-derived features are null for them. Funding/ledger data were recursively time-split and complete for all 43.",
      "Permutation p-values shuffle wallet labels as if rows were exchangeable; common market exposure and dependence between wallets can make these p-values anti-conservative. BH adjustment does not correct that dependence or post-hoc research selection.",
      "Account graph PnL may include flows and sampling artifacts; no feature has been tested in a ledger-reconciled copy-trade replay after fees or delayed execution.",
      "No feature is promoted into the production scorer from this study.",
    ],
  };
  const output = resolve(outputPath);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, sources: rows.length, censoredFillSources: rows.filter((row) => row.trainingFillCensored).length, correlations, walletNetwork: report.walletNetwork }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
