// Read-only dry run of the snapshot cross-check (SNAPSHOT_VERIFY) against the live APIs.
//
//   NOWNODES_API_KEY=… bun run scripts/verify-live-dryrun.ts [--config <frozen-configuration.json>]
//
// Builds a snapshot of the configuration's sources from the official API (default: fixtures/frozen-configuration.json),
// then checks it against NOWNodes twice:
//   REAL      the snapshot as read. Expected: verified. Anything else is worth looking at before SNAPSHOT_VERIFY is on.
//   TAMPERED  a copy that claims a $50k position the account does not hold and doubles its real ones.
//             Expected: mismatch. This is the positive control: it shows the check fires on live data.
// Sends no orders and writes nothing. The key comes from the environment only and is never printed.
// Exit 0 only when REAL is verified and TAMPERED is a mismatch. One run is one moment in time: it does not
// replace watching the verification counters on /pipeline once the check is on.
import { buildSnapshot } from "../src/snapshot";
import { hlReader, info } from "../src/hyperliquid";
import { nownodesPerp, verifySnapshot } from "../src/snapshot-verify";
import type { FrozenConfiguration } from "../../shared/frozen";

const key = process.env.NOWNODES_API_KEY;
if (!key) {
  console.error("set NOWNODES_API_KEY (read from the environment, never printed)");
  process.exit(2);
}

const configAt = process.argv.indexOf("--config");
const configPath = configAt >= 0 ? process.argv[configAt + 1] : undefined;
if (configAt >= 0 && (!configPath || configPath.startsWith("--"))) {
  console.error("--config needs a path to a frozen configuration file");
  process.exit(2);
}
const configuration = (await Bun.file(configPath ?? new URL("../fixtures/frozen-configuration.json", import.meta.url).pathname).json()) as FrozenConfiguration;

const names = async (dex: string) => ((await info<{ universe?: { name: string }[] }>({ type: "meta", ...(dex ? { dex } : {}) })).universe ?? []).map((u) => u.name);
const eligible = [...(await names("")), ...(await names("xyz"))];
console.log(`eligible assets: ${eligible.length}; sources: ${configuration.sources.length}`);

const snapshot = await buildSnapshot(configuration, eligible, Math.floor(Date.now() / 1000), Date.now, hlReader);
console.log(`snapshot read from the official API; positions per source: ${snapshot.sources.map((s) => s.positions.length).join(", ")}`);

const options = { mode: "on" as const, second: nownodesPerp(key), official: hlReader.perp, log: (m: string, d?: Record<string, unknown>) => console.log("log:", m, d) };
const real = await verifySnapshot(snapshot, options);
console.log("REAL     :", JSON.stringify({ verdict: real.verdict, sources: real.sources, retried: real.retried, ms: real.ms, diffs: real.diffs.length, unverified: real.unverified.length }));

const tampered = structuredClone(snapshot);
const first = tampered.sources[0];
if (!first) {
  console.error("the configuration has no sources");
  process.exit(2);
}
const invented = eligible.find((a) => !first.positions.some((p) => p.asset === a)) ?? "BTC";
first.positions.push({ asset: invented, notionalE6: "50000000000" }); // $50k that is not there
for (const p of first.positions) if (p.asset !== invented) p.notionalE6 = (BigInt(p.notionalE6) * 2n).toString();
const bad = await verifySnapshot(tampered, options);
console.log("TAMPERED :", JSON.stringify({ verdict: bad.verdict, retried: bad.retried, ms: bad.ms, diffs: bad.diffs.length, first: bad.diffs[0]?.asset ?? null }));

const ok = real.verdict === "verified" && bad.verdict === "mismatch";
console.log(ok ? "OK: verified as read, mismatch when tampered." : "NOT OK: see the lines above.");
process.exit(ok ? 0 : 1);
