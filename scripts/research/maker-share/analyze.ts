#!/usr/bin/env bun
// Tests whether formation-window maker share predicts forward performance (README §4.2/§8 "Maker share: a plus or
// an exclusion?"). Reads only the cache fetch.ts wrote; never touches the network.
//
//   bun scripts/research/maker-share/analyze.ts [--out=work/maker-share] [--iterations=5000] [--period=1]
//
// Prints the report and writes dataset.csv, results.json and report.txt next to the cache (suffixed -p2 for
// --period=2, whose forward window is coarse: no Sharpe, and its drawdown is understated).
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAccount, type Account, type LeaderboardRow } from "./dataset";
import { createClient } from "./hl";
import {
  bootstrap, mannWhitney, median, ols, quantile, rng, shuffle, spearman, spearmanPermutation, zRanks,
} from "./stats";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = arg("out", "work/maker-share");
const iterations = Number(arg("iterations", "5000"));
const period = Number(arg("period", "1"));
const suffix = period === 1 ? "" : `-p${period}`;
const THRESHOLDS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
const MIN_GROUP = 10;

const client = createClient(out, { offline: true });
const { sample } = JSON.parse(await readFile(join(out, `sample${suffix}.json`), "utf8")) as {
  sample: { address: string; status: string }[];
};
const { leaderboardRows } = await client.file<{ leaderboardRows: LeaderboardRow[] }>("", "leaderboard.json");
const vaultList = await client.file<{ summary: { vaultAddress: string } }[]>("", "vaults.json");
const vaults = new Set(vaultList.map((v) => v.summary.vaultAddress.toLowerCase()));
const rows = new Map(leaderboardRows.map((r) => [r.ethAddress.toLowerCase(), r]));
const accounts: Account[] = [];
for (const { address } of sample) accounts.push(await loadAccount(client, rows.get(address)!, vaults, (period - 1) * 30));

type Row = {
  address: string;
  kind: string;
  maker: number;
  makerByCount: number;
  fills: number;
  capped: boolean;
  feeRate: number;
  accountValue0: number;
  turnover: number; // formation notional / account value at t0, per day (a floor when capped)
  pastReturn: number | null;
  fwdReturn: number;
  fwdSharpe: number | null;
  fwdMaxDrawdown: number;
};
const data: Row[] = accounts
  .filter((a) => a.status === "ok" && a.forward && a.maker!.makerShare !== null)
  .map((a) => ({
    address: a.address,
    kind: a.kind,
    maker: a.maker!.makerShare!,
    makerByCount: a.maker!.makerShareByCount!,
    fills: a.maker!.fills,
    capped: a.fillsCapped!,
    feeRate: a.maker!.feeRate!,
    accountValue0: a.accountValue0!,
    turnover: a.maker!.volume / a.accountValue0! / 30,
    pastReturn: a.formation?.totalReturn ?? null,
    fwdReturn: a.forward!.totalReturn,
    fwdSharpe: a.forward!.sharpe,
    fwdMaxDrawdown: a.forward!.maxDrawdown,
  }));

const lines: string[] = [];
const say = (s = "") => lines.push(s);
const pct = (x: number | null) => (x === null ? "  —  " : `${(x * 100).toFixed(1)}%`);
const num = (x: number | null, d = 2) => (x === null ? "—" : x.toFixed(d));
const pval = (p: number) => (p < 0.001 ? "<0.001" : p.toFixed(3));
const pad = (s: string | number, w: number) => String(s).padStart(w);
const random = rng(42);

// 1. Funnel
const byStatus = Object.groupBy(accounts, (a) => a.status);
say(`MAKER SHARE vs FORWARD PERFORMANCE · period ${period} · ${data.length} accounts`);
say(`funnel: ${accounts.length} sampled → ${Object.entries(byStatus).map(([k, v]) => `${k} ${v!.length}`).join(", ")}`);
const blind = (byStatus.formationTrades ?? []).filter((a) => (a.maker?.fills ?? 0) === 0 && a.monthVlm >= 100e6);
say(`blind spot: ${blind.length} accounts had no formation fills served but ≥ $100M forward-month volume ` +
  `(beyond HL's ~10k recent-fills cap: likely the heaviest makers/HFT, not measurable here)`);
const t0s = data.map((d) => accounts.find((a) => a.address === d.address)!.t0!);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
say(`forward window starts ${day(Math.min(...t0s))}…${day(Math.max(...t0s))} (≈30 days); formation: the 30 days before`);
say();

// 2. Sample
const makers = data.map((d) => d.maker);
say(`kinds: ${data.filter((d) => d.kind === "trader").length} traders, ${data.filter((d) => d.kind === "vault").length} vaults · ` +
  `${data.filter((d) => d.capped).length} with a capped fills page (maker share from a partial sample)`);
say(`maker share (volume-weighted): p10 ${pct(quantile(makers, 0.1))} · p25 ${pct(quantile(makers, 0.25))} · ` +
  `median ${pct(median(makers))} · p75 ${pct(quantile(makers, 0.75))} · p90 ${pct(quantile(makers, 0.9))}`);
say(`  share of accounts with maker share = 0: ${pct(makers.filter((m) => m === 0).length / makers.length)}, ` +
  `≥ 0.5: ${pct(makers.filter((m) => m >= 0.5).length / makers.length)}, ≥ 0.9: ${pct(makers.filter((m) => m >= 0.9).length / makers.length)}`);
say();

// 3. Correlations
type Outcome = { key: string; label: string; get: (r: Row) => number | null; higherIsBetter: boolean };
const allOutcomes: Outcome[] = [
  { key: "fwdSharpe", label: "forward Sharpe (ann.)", get: (r) => r.fwdSharpe, higherIsBetter: true },
  { key: "fwdReturn", label: "forward 30d return", get: (r) => r.fwdReturn, higherIsBetter: true },
  { key: "fwdMaxDrawdown", label: "forward max drawdown", get: (r) => r.fwdMaxDrawdown, higherIsBetter: false },
  { key: "fwdPositive", label: "forward return > 0", get: (r) => (r.fwdReturn > 0 ? 1 : 0), higherIsBetter: true },
];
// Period 2's forward window has only the coarse allTime points: Sharpe needs the fine month window, and drawdown
// is kept but understated (a rank comparison still works, since spacing doesn't depend on maker share).
const outcomes = period === 1
  ? allOutcomes
  : allOutcomes.filter((o) => o.key !== "fwdSharpe").map((o) =>
    o.key === "fwdMaxDrawdown" ? { ...o, label: "fwd max drawdown (coarse)" } : o);
const outcome = (key: string) => outcomes.find((o) => o.key === key);
const pairs = (rs: Row[], o: Outcome, x: (r: Row) => number = (r) => r.maker) =>
  rs.filter((r) => o.get(r) !== null).map((r) => [x(r), o.get(r)!] as const);

const correlations: Record<string, unknown> = {};
say("SPEARMAN: maker share vs outcome (permutation p, bootstrap 95% CI)");
for (const o of outcomes) {
  const p = pairs(data, o);
  const xs = p.map(([x]) => x);
  const ys = p.map(([, y]) => y);
  const perm = spearmanPermutation(xs, ys, iterations, random);
  const ci = bootstrap(p.length, (idx) => spearman(idx.map((i) => xs[i]), idx.map((i) => ys[i])), 2000, random);
  correlations[o.key] = { n: p.length, rho: perm.rho, p: perm.p, ci };
  say(`  ${o.label.padEnd(24)} n=${pad(p.length, 3)}  ρ=${pad(num(perm.rho, 3), 6)}  p=${pad(pval(perm.p), 6)}  ` +
    `CI [${num(ci[0], 3)}, ${num(ci[1], 3)}]${o.higherIsBetter ? "" : "   (higher = worse)"}`);
}
say();

// 4. Threshold scan, with a max-|z| permutation adjustment across thresholds (Westfall–Young), since picking the
// best of ten cut-offs would otherwise find something by chance.
const scan = (rs: Row[], o: Outcome) => {
  const p = pairs(rs, o);
  const zAt = (xs: number[], ys: number[]) =>
    THRESHOLDS.map((t) => {
      const above = ys.filter((_, i) => xs[i] >= t);
      const below = ys.filter((_, i) => xs[i] < t);
      return above.length >= MIN_GROUP && below.length >= MIN_GROUP ? mannWhitney(above, below) : null;
    });
  const xs = p.map(([x]) => x);
  const ys = p.map(([, y]) => y);
  const observed = zAt(xs, ys);
  const maxNull: number[] = [];
  for (let i = 0; i < Math.min(iterations, 2000); i++) {
    const shuffled = shuffle(ys, random);
    maxNull.push(Math.max(0, ...zAt(xs, shuffled).map((r) => (r ? Math.abs(r.z) : 0))));
  }
  return THRESHOLDS.map((t, k) => {
    const above = p.filter(([x]) => x >= t).map(([, y]) => y);
    const below = p.filter(([x]) => x < t).map(([, y]) => y);
    const mw = observed[k];
    return {
      threshold: t,
      nAbove: above.length,
      nBelow: below.length,
      medianAbove: median(above),
      medianBelow: median(below),
      z: mw?.z ?? null,
      p: mw?.p ?? null,
      pAdjusted: mw ? (maxNull.filter((m) => m >= Math.abs(mw.z)).length + 1) / (maxNull.length + 1) : null,
    };
  });
};
const scans: Record<string, ReturnType<typeof scan>> = {};
for (const o of outcomes.filter((o) => o.key !== "fwdPositive")) {
  scans[o.key] = scan(data, o);
  say(`THRESHOLD SCAN · ${o.label}: maker share ≥ t vs < t (Mann–Whitney; p_adj = family-wise over all t)`);
  say(`     t   n≥t   n<t   median≥t   median<t       z      p   p_adj`);
  const fmt = o.key === "fwdSharpe" ? (x: number | null) => num(x) : pct;
  for (const r of scans[o.key]) {
    say(`  ${pad(r.threshold.toFixed(2), 4)} ${pad(r.nAbove, 5)} ${pad(r.nBelow, 5)} ${pad(fmt(r.medianAbove), 10)} ` +
      `${pad(fmt(r.medianBelow), 10)} ${pad(r.z === null ? "(n<10)" : num(r.z), 7)} ${pad(r.p === null ? "" : pval(r.p), 6)} ` +
      `${pad(r.pAdjusted === null ? "" : pval(r.pAdjusted), 7)}`);
  }
  say();
}

// 5. Buckets (fixed edges: most accounts sit at 0 maker share, so quantile buckets would collapse)
const EDGES = [0, 0.05, 0.25, 0.5, 0.75, 0.9, 1.0001];
say("BUCKETS by maker share");
const fine = period === 1;
say(`  bucket        n${fine ? "   median Sharpe" : ""}   median return   hit rate   median maxDD`);
const buckets = EDGES.slice(0, -1).map((lo, i) => {
  const hi = EDGES[i + 1];
  const rs = data.filter((r) => r.maker >= lo && r.maker < hi);
  const sharpes = rs.map((r) => r.fwdSharpe).filter((s): s is number => s !== null);
  const b = {
    range: `${(lo * 100).toFixed(0)}–${Math.min(100, hi * 100).toFixed(0)}%`,
    n: rs.length,
    medianSharpe: median(sharpes),
    medianReturn: median(rs.map((r) => r.fwdReturn)),
    hitRate: rs.length ? rs.filter((r) => r.fwdReturn > 0).length / rs.length : null,
    medianMaxDrawdown: median(rs.map((r) => r.fwdMaxDrawdown)),
  };
  say(`  ${b.range.padEnd(10)} ${pad(b.n, 4)}${fine ? ` ${pad(num(b.medianSharpe), 15)}` : ""} ${pad(pct(b.medianReturn), 15)} ` +
    `${pad(pct(b.hitRate), 10)} ${pad(pct(b.medianMaxDrawdown), 14)}`);
  return b;
});
say();

// 6. Controls: rank regression of each outcome on maker share plus past return, size and turnover. Turnover
// (notional / equity / day) stands in for leverage × trading frequency, which takers tend to run higher.
const controls: Record<string, unknown> = {};
for (const o of outcomes.filter((o) => o.key !== "fwdPositive")) {
  const rs = data.filter((r) => o.get(r) !== null && r.pastReturn !== null);
  // The maker term is either its rank, or a pure-taker indicator (maker share < 5%, the scan's lowest cut-off).
  const design = (sub: Row[], term: "rank" | "pureTaker") => [
    term === "rank" ? zRanks(sub.map((r) => r.maker)) : sub.map((r) => (r.maker < 0.05 ? 1 : 0)),
    zRanks(sub.map((r) => r.pastReturn!)),
    zRanks(sub.map((r) => Math.log(r.accountValue0))),
    zRanks(sub.map((r) => Math.log(r.turnover + 1e-9))),
  ];
  say(`CONTROLS · ${o.label}: rank-OLS on [maker term, past 30d return, log account value, log turnover], n=${rs.length}`);
  for (const term of ["rank", "pureTaker"] as const) {
    const fit = (sub: Row[]) => ols(design(sub, term), zRanks(sub.map((r) => o.get(r)!)));
    const beta = fit(rs);
    const ci = bootstrap(rs.length, (idx) => fit(idx.map((i) => rs[i]))[1], 2000, random);
    controls[`${o.key}:${term}`] = { n: rs.length, beta, makerCi: ci };
    say(`  ${term === "rank" ? "maker rank " : "pure taker "} ${pad(num(beta[1], 3), 6)} (95% CI ${num(ci[0], 3)}…${num(ci[1], 3)}) · ` +
      `past return ${num(beta[2], 3)} · size ${num(beta[3], 3)} · turnover ${num(beta[4], 3)}`);
  }
}
const withPast = data.filter((r) => r.pastReturn !== null);
say(`  maker vs turnover ρ=${num(spearman(data.map((r) => r.maker), data.map((r) => r.turnover)), 3)}, ` +
  `maker vs size ρ=${num(spearman(data.map((r) => r.maker), data.map((r) => Math.log(r.accountValue0))), 3)}, ` +
  `maker vs past return ρ=${num(spearman(withPast.map((r) => r.maker), withPast.map((r) => r.pastReturn!)), 3)}`);
say();

// 7. Sensitivity
say(`SENSITIVITY (Spearman ρ of maker share with ${period === 1 ? "forward Sharpe / " : ""}forward return)`);
const sensitivity: Record<string, unknown> = {};
const sens = (label: string, rs: Row[], x: (r: Row) => number = (r) => r.maker) => {
  const test = (o: Outcome | undefined) => {
    if (!o) return null;
    const p = pairs(rs, o, x);
    return spearmanPermutation(p.map(([a]) => a), p.map(([, b]) => b), 2000, random);
  };
  const ps = test(outcome("fwdSharpe"));
  const pr = test(outcome("fwdReturn"))!;
  sensitivity[label] = { n: rs.length, sharpe: ps, ret: pr };
  say(`  ${label.padEnd(30)} n=${pad(rs.length, 3)}  ` +
    (ps ? `Sharpe ρ=${pad(num(ps.rho, 3), 6)} (p ${pval(ps.p)})  ` : "") +
    `return ρ=${pad(num(pr.rho, 3), 6)} (p ${pval(pr.p)})`);
};
sens("all", data);
sens("traders only", data.filter((r) => r.kind === "trader"));
sens("uncapped fills only", data.filter((r) => !r.capped));
sens("maker share by fill count", data, (r) => r.makerByCount);
sens("≥ 100 formation fills", data.filter((r) => r.fills >= 100));
sens("account value ≥ $100k at t0", data.filter((r) => r.accountValue0 >= 100_000));
say();

const report = lines.join("\n");
console.log(report);

const columns = Object.keys(data[0] ?? {}) as (keyof Row)[];
await writeFile(join(out, `dataset${suffix}.csv`), [columns.join(","), ...data.map((r) => columns.map((c) => r[c]).join(","))].join("\n"));
await writeFile(
  join(out, `results${suffix}.json`),
  JSON.stringify({ period, n: data.length, funnel: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v!.length])),
    blindSpot: blind.length, correlations, scans, buckets, controls, sensitivity }, null, 1),
);
await writeFile(join(out, `report${suffix}.txt`), report);
console.log(`wrote dataset${suffix}.csv, results${suffix}.json, report${suffix}.txt in ${out}`);
