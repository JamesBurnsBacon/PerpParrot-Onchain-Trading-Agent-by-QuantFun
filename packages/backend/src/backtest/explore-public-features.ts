import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deriveSourceFeatures, spearman } from "./source-features";

const DAY = 86_400_000;
const permutations = 20_000;
const baselinePath = process.argv[2] ?? "work/backtests/public-20261006-v2.json";
const evidencePath = process.argv[3] ?? "work/backtests/public-evidence-20261006.json";
const outputPath = process.argv[4] ?? "work/backtests/feature-exploration-20261006.json";

const hash = (value: unknown): string => JSON.stringify(value);
const rank = (values: number[]): number[] => {
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
};
const correlation = (a: number[], b: number[]): number | null => {
  if (a.length !== b.length || a.length < 3) return null;
  const x = rank(a); const y = rank(b);
  const mx = x.reduce((s, v) => s + v, 0) / x.length;
  const my = y.reduce((s, v) => s + v, 0) / y.length;
  const cov = x.reduce((s, v, i) => s + (v - mx) * (y[i] - my), 0);
  const sx = Math.sqrt(x.reduce((s, v) => s + (v - mx) ** 2, 0));
  const sy = Math.sqrt(y.reduce((s, v) => s + (v - my) ** 2, 0));
  return sx === 0 || sy === 0 ? null : cov / (sx * sy);
};
const permutationP = (x: number[], y: number[], observed: number, seed: number): number => {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  let extreme = 0;
  for (let trial = 0; trial < permutations; trial++) {
    const shuffled = [...y];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const candidate = correlation(x, shuffled);
    if (candidate !== null && Math.abs(candidate) >= Math.abs(observed) - 1e-12) extreme++;
  }
  return (extreme + 1) / (permutations + 1);
};
const fdr = (items: { pValue: number }[]): number[] => {
  const order = items.map((item, index) => ({ index, p: item.pValue })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(items.length);
  let running = 1;
  for (let i = order.length - 1; i >= 0; i--) {
    running = Math.min(running, order[i].p * order.length / (i + 1));
    adjusted[order[i].index] = running;
  }
  return adjusted;
};

type Artifact = { result: { cutoffMs: number; asOfMs: number; sources: { address: string; rank: number; selected: boolean; testReturn: number }[] }; raw: { address: string; month: { accountValueHistory: [number, number][] } }[] };
type Evidence = { windowStartMs: number; windowEndMs: number; addresses: string[]; data: Record<string, Record<string, { records: Record<string, unknown>[]; count: number; requests: { from: number; to: number; count: number }[]; threshold: number; failed: string[] }>> };

async function main(): Promise<void> {
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Artifact;
  const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as Evidence;
  if (evidence.windowStartMs !== baseline.result.cutoffMs - 14 * DAY || evidence.windowEndMs !== baseline.result.cutoffMs) throw new Error("feature window does not end at the frozen score cutoff");
  const labels = new Map(baseline.result.sources.map((row) => [row.address.toLowerCase(), row]));
  const cohort = new Set(evidence.addresses.map((address) => address.toLowerCase()));
  const terminalComplete = (collection: Evidence["data"][string][string]): boolean => {
    if (collection.failed.length > 0) return false;
    const ranges = new Set(collection.requests.map((request) => `${request.from}:${request.to}`));
    return collection.requests.every((request) => {
      const middle = Math.floor((request.from + request.to) / 2);
      const hasChildren = ranges.has(`${request.from}:${middle}`) && ranges.has(`${middle + 1}:${request.to}`);
      return hasChildren || request.count < collection.threshold || request.to - request.from <= 60_000;
    });
  };
  const rows = baseline.raw.map((source) => {
    const address = source.address.toLowerCase();
    const data = evidence.data[address];
    const label = labels.get(address);
    if (!data || !label) throw new Error(`missing aligned feature or outcome row ${address}`);
    const complete = Object.values(data).every(terminalComplete);
    const history = source.month.accountValueHistory.filter(([timestamp]) => timestamp <= evidence.windowStartMs);
    const startingEquity = history.at(-1)?.[1] ?? null;
    const derived = deriveSourceFeatures({
      address,
      startMs: evidence.windowStartMs,
      cutoffMs: evidence.windowEndMs,
      startingEquity,
      evidence: {
        userFillsByTime: data.userFillsByTime.records,
        userFunding: data.userFunding.records,
        userNonFundingLedgerUpdates: data.userNonFundingLedgerUpdates.records,
      },
    });
    return { address, rank: label.rank, selected: label.selected, holdoutReturn: label.testReturn, featureWindowComplete: complete, features: derived };
  });
  const names = Object.keys(rows[0].features) as (keyof typeof rows[number]["features"])[];
  const correlations = names.map((name, index) => {
    const x = rows.map((row) => row.features[name]);
    const y = rows.map((row) => row.holdoutReturn);
    const observed = spearman(x, y);
    const paired = rows.filter((row) => row.features[name] !== null);
    if (observed.rho === null || paired.length < 4) return { feature: name, n: observed.n, spearmanRho: observed.rho, permutationP: null as number | null };
    return { feature: name, n: observed.n, spearmanRho: observed.rho, permutationP: permutationP(paired.map((row) => row.features[name]!), paired.map((row) => row.holdoutReturn), observed.rho, 20261006 + index) };
  });
  const testable = correlations.filter((row): row is typeof row & { permutationP: number } => row.permutationP !== null);
  const qValues = fdr(testable.map(({ permutationP }) => ({ pValue: permutationP })));
  testable.forEach((row, index) => Object.assign(row, { bhQValue: qValues[index] }));

  const counterparties = new Map<string, Set<string>>();
  const direct = new Map<string, { events: number; usd: number }>();
  for (const address of evidence.addresses) {
    for (const event of evidence.data[address.toLowerCase()].userNonFundingLedgerUpdates.records) {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type !== "send") continue;
      const from = typeof delta.user === "string" ? delta.user.toLowerCase() : null;
      const to = typeof delta.destination === "string" ? delta.destination.toLowerCase() : null;
      if (!from || !to) continue;
      for (const [wallet, counterparty] of [[from, to], [to, from]] as const) {
        if (cohort.has(wallet)) {
          if (!counterparties.has(wallet)) counterparties.set(wallet, new Set());
          counterparties.get(wallet)!.add(counterparty);
        }
      }
      if (cohort.has(from) && cohort.has(to)) {
        const key = `${from}->${to}`;
        const current = direct.get(key) ?? { events: 0, usd: 0 };
        current.events++;
        const amount = Number(delta.usdcValue ?? delta.amount ?? 0);
        if (Number.isFinite(amount) && amount >= 0) current.usd += amount;
        direct.set(key, current);
      }
    }
  }
  const links = [...counterparties.keys()].flatMap((a, i, wallets) => wallets.slice(i + 1).flatMap((b) => {
    const shared = [...counterparties.get(a)!].filter((counterparty) => counterparties.get(b)!.has(counterparty));
    return shared.length ? [{ a, b, sharedCounterpartyCount: shared.length }] : [];
  }));
  const report = {
    schemaVersion: 1,
    methodology: {
      claim: "exploratory association only; this uses the already-inspected holdout and cannot validate a new predictor",
      featureWindow: { startMs: evidence.windowStartMs, endMsExclusiveIntentInclusiveApi: evidence.windowEndMs },
      outcomeWindow: { startMsExclusive: baseline.result.cutoffMs, endMsInclusive: baseline.result.asOfMs },
      sourceCount: rows.length,
      completeSourceCount: rows.filter((row) => row.featureWindowComplete).length,
      nullsAreMissingNotZero: true,
      pValues: `two-sided Monte Carlo permutation test (${permutations} permutations per feature); Benjamini-Hochberg q-values across testable features; descriptive only at n=${rows.length}`,
      caveats: ["The outcome holdout was already inspected in the previous analysis; these feature correlations are post hoc and must not be treated as independent confirmation.", "The current leaderboard cohort is survivorship-biased and n is small; sparse accounts create many zero/tied features.", "Ledger endpoint data is public event evidence, not proof of common control, collusion, or intent.", "Selected model performance was not re-run after adding these features; no new feature is promoted into scoring."],
    },
    featureOutcomeCorrelations: correlations,
    rows,
    walletLinks: { directTransfersWithinCohort: [...direct].map(([key, value]) => ({ key, ...value })), sharedCounterpartyPairs: links },
  };
  const output = resolve(outputPath);
  await import("node:fs/promises").then(({ mkdir }) => mkdir(dirname(output), { recursive: true }));
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ output, sourceCount: rows.length, completeSources: report.methodology.completeSourceCount, featureOutcomeCorrelations: correlations, walletLinks: report.walletLinks }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
