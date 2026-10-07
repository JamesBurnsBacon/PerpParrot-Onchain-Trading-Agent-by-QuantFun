// Fault-injection demo for the info read path (docs/ops/DEPLOY.md "NOWNodes failover").
//
//   bun run scripts/chaos-read-demo.ts [--reads 200] [--outage 50:150] [--status 429] [--json]
//
// Runs the real router (`makeRoutedFetch`) over a simulated network twice, with the same outage on the
// official API: once with the default routing (official only) and once with INFO_ROUTING=overflow.
// Nothing here touches the network, a key, or production; the router is only handed a fake `fetch`.
//
// What is simulated, and what is not: both providers answer the same synthetic account state, so the
// counts show what the router does, not what NOWNodes' real answers look like. Latency is virtual,
// using the medians measured on 2026-10-07 (official 0.21 s, NOWNodes 0.36 s). The reader retries a
// 429 twice like PacedInfo does but without its waits, so an outage that outlasts the retries
// stays an outage in both runs.
import { makeRoutedFetch, type RouterOptions } from "../src/pipeline/info-router";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const READS = Number(arg("reads", "200"));
const [OUT_FROM, OUT_TO] = arg("outage", "50:150").split(":").map(Number) as [number, number];
const OUTAGE_STATUS = Number(arg("status", "429"));
const JSON_OUT = process.argv.includes("--json");
if (![READS, OUT_FROM, OUT_TO, OUTAGE_STATUS].every(Number.isFinite) || READS < 1) {
  console.error("usage: chaos-read-demo.ts [--reads N] [--outage FROM:TO] [--status 429|500|503] [--json]");
  process.exit(2);
}

const OFFICIAL = "https://api.hyperliquid.xyz/info";
const OFFICIAL_MS = 210;
const NOWNODES_MS = 360;
const ATTEMPTS = 3; // the first read plus PacedInfo's two retries on a 429

const stateFor = (user: string) => ({
  marginSummary: { accountValue: "100000.0" },
  assetPositions: [{ position: { coin: "BTC", szi: "0.5", user } }],
});

type Result = {
  arm: string;
  reads: number;
  ok: number;
  failed: number;
  failovers: number;
  officialRequests: number;
  nownodesRequests: number;
  virtualSeconds: number;
};

const run = async (arm: string, env: Record<string, string>): Promise<Result> => {
  let clock = 0;
  let officialCalls = 0; // index of the official request, used to place the outage
  const fetchImpl = async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { type: string; user: string };
    if (url === OFFICIAL) {
      const n = officialCalls++;
      clock += OFFICIAL_MS;
      if (n >= OUT_FROM && n < OUT_TO) return new Response("injected outage", { status: OUTAGE_STATUS });
    } else {
      clock += NOWNODES_MS;
    }
    return new Response(JSON.stringify(stateFor(body.user)), { status: 200 });
  };
  const router = makeRoutedFetch({
    env: () => env,
    fetchImpl: fetchImpl as unknown as RouterOptions["fetchImpl"],
    now: () => clock,
    log: () => {},
  });

  let ok = 0;
  let failed = 0;
  for (let i = 0; i < READS; i++) {
    const init = () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "clearinghouseState", user: `0x${i.toString(16).padStart(40, "0")}` }) });
    let good = false;
    for (let attempt = 0; attempt < ATTEMPTS && !good; attempt++) {
      try {
        const res = await router(OFFICIAL, init());
        good = res.ok;
        if (good) await res.json();
      } catch {
        good = false;
      }
    }
    if (good) ok++;
    else failed++;
  }
  const s = router.stats();
  return { arm, reads: READS, ok, failed, failovers: s.fallbacks, officialRequests: s.official.requests, nownodesRequests: s.nownodes.requests, virtualSeconds: Math.round(clock / 100) / 10 };
};

// A key is required for NOWNodes routing to engage; this one is a placeholder for the fake network.
const results = [
  await run("official only (default)", {}),
  await run("overflow (NOWNodes failover)", { INFO_ROUTING: "overflow", NOWNODES_API_KEY: "demo-not-a-real-key" }),
];

if (JSON_OUT) {
  console.log(JSON.stringify({ outage: { from: OUT_FROM, to: OUT_TO, status: OUTAGE_STATUS }, results }, null, 2));
} else {
  console.log(`Outage on the official API: requests ${OUT_FROM}-${OUT_TO - 1} answer ${OUTAGE_STATUS}. ${READS} account reads, simulated network.\n`);
  const rows = results.map((r) => ({
    run: r.arm,
    "reads ok": r.ok,
    "reads failed": r.failed,
    failovers: r.failovers,
    "official requests": r.officialRequests,
    "NOWNodes requests": r.nownodesRequests,
    "virtual s": r.virtualSeconds,
  }));
  console.table(rows);
  console.log("Synthetic data and virtual latency: this shows the router's behavior, not NOWNodes' real answers.");
}
