#!/usr/bin/env bun
// Draws a seeded random sample of leaderboard accounts and fetches what the maker-share study needs, until
// `--target` accounts pass the selection rules (dataset.ts). Responses are cached under --out, so a rerun resumes
// for free.
//
//   bun scripts/research/maker-share/fetch.ts [--target=200] [--seed=1] [--out=work/maker-share]
//                                              [--max-candidates=2000] [--min-alltime-vlm=1000000] [--period=1]
//
// --period=2 replays the test 30 days earlier (dataset.ts `lagDays`), into sample-p2.json.
//
// The pool is filtered on all-time volume only, not on current account value: the $10k floor is applied at t0
// from the portfolio history, so accounts that blew up in the forward window stay in the sample.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadAccount, windowOf, type Account, type LeaderboardRow } from "./dataset";
import { createClient } from "./hl";
import { rng, shuffle } from "./stats";

const arg = (name: string, fallback: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const target = Number(arg("target", "200"));
const seed = Number(arg("seed", "1"));
const out = arg("out", "work/maker-share");
const maxCandidates = Number(arg("max-candidates", "2000"));
const minAllTimeVlm = Number(arg("min-alltime-vlm", "1000000"));
const period = Number(arg("period", "1"));

await mkdir(out, { recursive: true });
const client = createClient(out);

console.log("loading leaderboard and vault list (cached after the first run)…");
const { leaderboardRows } = await client.file<{ leaderboardRows: LeaderboardRow[] }>(
  "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
  "leaderboard.json",
);
const vaultList = await client.file<{ summary: { vaultAddress: string } }[]>(
  "https://stats-data.hyperliquid.xyz/Mainnet/vaults",
  "vaults.json",
);
const vaults = new Set(vaultList.map((v) => v.summary.vaultAddress.toLowerCase()));

const pool = leaderboardRows.filter((r) => Number(windowOf(r, "allTime")?.vlm ?? 0) >= minAllTimeVlm);
const candidates = shuffle(pool, rng(seed)).slice(0, maxCandidates);
console.log(`pool: ${pool.length} of ${leaderboardRows.length} rows with all-time volume ≥ $${minAllTimeVlm}`);

const sample: { address: string; status: Account["status"] }[] = [];
const save = () =>
  writeFile(
    join(out, period === 1 ? "sample.json" : `sample-p${period}.json`),
    JSON.stringify({ period, seed, target, minAllTimeVlm, poolSize: pool.length, savedAtMs: Date.now(), sample }, null, 1),
  );
let ok = 0;
const started = Date.now();
for (const row of candidates) {
  if (ok >= target) break;
  const account = await loadAccount(client, row, vaults, (period - 1) * 30);
  sample.push({ address: account.address, status: account.status });
  if (account.status === "ok") ok++;
  if (sample.length % 10 === 0) {
    await save();
    const { requests, cacheHits } = client.stats();
    const minutes = ((Date.now() - started) / 60_000).toFixed(1);
    console.log(`${sample.length} tried, ${ok}/${target} kept · ${requests} requests, ${cacheHits} cached · ${minutes} min`);
  }
}
await save();

const counts = Object.entries(Object.groupBy(sample, (s) => s.status)).map(([k, v]) => `${k} ${v!.length}`);
console.log(`done: ${sample.length} tried → ${counts.join(", ")}`);
if (ok < target) console.log(`only ${ok} of ${target} kept; raise --max-candidates`);
