// Local executor endpoint for `cre workflow simulate mirror`. Verifies and logs
// reports; it does not trade. Run: bun run dev
import { createPublicClient, http, type Hex } from "viem";
import { mainnet } from "viem/chains";
import { handleReport } from "./handler";
import { registrySigners } from "./signers";
import type { VerifyMode } from "./verify";

const env = process.env;
const port = Number(env.PORT ?? 8787);
const verifyReports = env.VERIFY_REPORTS !== "false";

if (!verifyReports && env.NODE_ENV === "production") {
  throw new Error("VERIFY_REPORTS=false is not allowed in production");
}

const mode: VerifyMode = verifyReports
  ? {
      kind: "registry",
      signers: registrySigners(
        createPublicClient({ chain: mainnet, transport: http(env.ETH_MAINNET_RPC_URL ?? "https://ethereum-rpc.publicnode.com") }),
      ),
      workflowOwner: (env.WORKFLOW_OWNER ?? "") as Hex,
    }
  : { kind: "simulation" };

const claimed = new Set<string>();

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== "/reports") return new Response("not found", { status: 404 });

    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }

    const result = await handleReport(payload, {
      mode,
      frozenSetHash: env.FROZEN_SET_HASH ?? "",
      maxAgeSeconds: Number(env.MAX_REPORT_AGE_SECONDS ?? 300),
      now: () => Math.floor(Date.now() / 1000),
      claim: async (id) => !claimed.has(id) && Boolean(claimed.add(id)),
      execute: async (r) => {
        console.log(`[execute] ${r.body.runId} report=${r.id} don=${r.donId} owner=${r.workflowOwner} signers=${r.signers.length}`);
        for (const t of r.body.targets) {
          console.log(`  ${t.asset.padEnd(10)} ${(Number(t.notionalE6) / 1e6).toFixed(2)} USD`);
        }
      },
    });
    console.log(`[${result.status}] ${JSON.stringify(result.body)}`);
    return Response.json(result.body, { status: result.status });
  },
});

console.log(`executor dev server on :${port}/reports (verify=${verifyReports ? "registry" : "simulation"})`);
