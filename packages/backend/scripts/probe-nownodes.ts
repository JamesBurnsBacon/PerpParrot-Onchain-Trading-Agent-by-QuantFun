// Prints which Hyperliquid info methods NOWNodes' copy serves right now, next to the router's allowlist.
//
//   NOWNODES_API_KEY=… bun run scripts/probe-nownodes.ts [--json]
//
// Sixteen small read-only requests to hype.nownodes.io, none to Hyperliquid. The key comes from the
// environment only and is never printed. Exit code 1 when the allowlist and the provider disagree.
import { probeCapabilities } from "../src/pipeline/capability-probe";
import { NOWNODES_CAPABLE } from "../src/pipeline/info-router";

const key = process.env.NOWNODES_API_KEY;
if (!key) {
  console.error("set NOWNODES_API_KEY (read from the environment, never printed)");
  process.exit(2);
}

const report = await probeCapabilities({ url: "https://hype.nownodes.io/info", key, allowlist: NOWNODES_CAPABLE });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.table(report.rows.map((r) => ({ method: r.method, status: r.status ?? "none", verdict: r.verdict, "on allowlist": r.allowlisted ? "yes" : "no", drift: r.drift ? "YES" : "", ms: r.ms })));
  console.log(report.narrowed.length ? `Allowlisted but not served (the router would stop using NOWNodes for): ${report.narrowed.join(", ")}` : "No allowlisted method was refused.");
  if (report.newlySupported.length) console.log(`Served but not allowlisted (shown only, never used automatically): ${report.newlySupported.join(", ")}`);
  const unclear = report.rows.filter((r) => r.verdict === "inconclusive").map((r) => r.method);
  if (unclear.length) console.log(`Inconclusive (timeout, 429 or 5xx; rerun): ${unclear.join(", ")}`);
}
process.exit(report.rows.some((r) => r.drift) ? 1 : 0);
