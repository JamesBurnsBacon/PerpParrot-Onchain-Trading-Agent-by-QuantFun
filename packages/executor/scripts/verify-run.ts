// Re-verifies an executed run from the public run log, independently of the executor:
// DON signatures (Capability Registry on Ethereum mainnet), workflow owner, report ID,
// and that the snapshot the DON agreed on is the one the backend stored.
//
//   bun run scripts/verify-run.ts --executor https://… [--run <runId>] [--backend https://…]
//   add --simulation for runs from `cre workflow simulate` (local signing keys: only checks
//   that the signatures recover, not that they're registry signers)
import { createPublicClient, http, keccak256, stringToBytes, type Hex } from "viem";
import { mainnet } from "viem/chains";
import type { ReportEnvelope } from "../../shared/report";
import { registrySigners } from "../src/signers";
import { verifyEnvelope } from "../src/verify";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const executor = arg("executor") ?? "http://localhost:8787";
const backend = arg("backend");
const simulation = process.argv.includes("--simulation");
const owner = (arg("owner") ?? "0xc5feb3cf878c9ba42a776e9edf62a4558ab08b85") as Hex;

type Run = { id: string; runId: string; kind: string; status: string; dryRun: boolean; envelope?: ReportEnvelope };
const runs = (await (await fetch(`${executor}/runs?limit=200`)).json()) as Run[];
const wanted = arg("run");
// A CRE report is at least its 109-byte header (218 hex chars).
const run = runs.find((r) => r.kind !== "flatten" && (r.envelope?.report.length ?? 0) >= 218 && (!wanted || r.runId === wanted));
if (!run?.envelope) throw new Error(wanted ? `no run ${wanted} with a report` : "no runs with a report");

const verified = await verifyEnvelope(
  run.envelope,
  simulation
    ? { kind: "simulation" }
    : {
        kind: "registry",
        signers: registrySigners(createPublicClient({ chain: mainnet, transport: http(process.env.ETH_MAINNET_RPC_URL) })),
        workflowOwner: owner,
      },
);
const ok = (label: string, pass: boolean, detail = "") => {
  console.log(`${pass ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!pass) process.exitCode = 1;
};

const { body } = verified;
console.log(`run ${run.runId} (${run.status}${run.dryRun ? ", dry run" : ""})`);
ok(
  simulation ? "signatures recover" : "≥ f+1 DON signatures from the Capability Registry, pinned workflow owner",
  true,
  `${verified.signers.length} signers, DON ${verified.donId}, owner ${verified.workflowOwner}`,
);
ok("report ID = keccak256(report)", verified.id === run.id, verified.id);
console.log(`  configuration ${body.configurationHash}`);
console.log(`  account       ${body.account}`);
console.log(`  as of         ${new Date(Number(body.asOf) * 1000).toISOString()} (expires +${Number(body.expiresAt - body.asOf)} s)`);
console.log(`  exposures     ${body.exposures.map((e) => `${e.asset} ${(Number(e.exposureE9) / 1e9).toFixed(4)}`).join(", ")}`);

if (backend) {
  const snapshot = await (await fetch(`${backend}/snapshots/${body.asOf}`)).text();
  ok("snapshot hash matches the stored snapshot", keccak256(stringToBytes(snapshot)) === body.snapshotHash, body.snapshotHash);
}
