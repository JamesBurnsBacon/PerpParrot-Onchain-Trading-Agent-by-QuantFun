// One-time go-live setup of our HL account, signed with the MASTER key by a human
// (docs/cre/RUNBOOK.md "Go live"). Read-only unless --apply is given.
//
//   HL_ACCOUNT=0x… bun run scripts/setup-account.ts                 # status only
//   HL_ACCOUNT=0x… HL_API_WALLET_ADDRESS=0x… HL_MASTER_KEY=0x… \
//     bun run scripts/setup-account.ts --apply                      # unified mode + approve the API wallet
//
// --apply does two things, each only if needed:
//   1. userSetAbstraction → "unifiedAccount": one USDC balance margins core and xyz perps.
//   2. approveAgent(HL_API_WALLET_ADDRESS, "perpparrot"): the executor's key can trade but not withdraw.
// It never moves funds.
import { HttpTransport } from "@nktkas/hyperliquid";
import { approveAgent, userSetAbstraction } from "@nktkas/hyperliquid/api/exchange";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { httpInfo } from "../src/hyperliquid";

const env = process.env;
const apply = process.argv.includes("--apply");
const account = env.HL_ACCOUNT?.toLowerCase();
if (!account || !/^0x[0-9a-f]{40}$/.test(account)) throw new Error("HL_ACCOUNT must be our HL master address");

const info = httpInfo();
const mode = await info<string>({ type: "userAbstraction", user: account });
const agents = await info<{ address: string; name: string; validUntil: number }[]>({ type: "extraAgents", user: account });
const apiWallet = env.HL_API_WALLET_ADDRESS?.toLowerCase();
const approved = apiWallet ? agents.find((a) => a.address.toLowerCase() === apiWallet) : undefined;

console.log(`account      ${account}`);
console.log(`mode         ${mode}${mode === "unifiedAccount" ? "" : "  (want unifiedAccount)"}`);
console.log(`API wallets  ${agents.length ? agents.map((a) => `${a.address} "${a.name}" until ${new Date(a.validUntil).toISOString()}`).join(", ") : "none"}`);
if (apiWallet) console.log(`executor key ${apiWallet} ${approved ? "approved" : "NOT approved"}`);

if (!apply) {
  console.log("\nRead-only. Re-run with --apply (and HL_MASTER_KEY, HL_API_WALLET_ADDRESS) to make changes.");
  process.exit(0);
}

const masterKey = env.HL_MASTER_KEY as Hex | undefined;
if (!masterKey || !/^0x[0-9a-fA-F]{64}$/.test(masterKey)) throw new Error("HL_MASTER_KEY is required with --apply");
const wallet = privateKeyToAccount(masterKey);
if (wallet.address.toLowerCase() !== account) throw new Error(`HL_MASTER_KEY is for ${wallet.address}, not HL_ACCOUNT`);
const config = { transport: new HttpTransport(), wallet };

if (mode !== "unifiedAccount") {
  await userSetAbstraction(config, { user: wallet.address, abstraction: "unifiedAccount" });
  console.log("set mode → unifiedAccount");
}
if (apiWallet && !approved) {
  await approveAgent(config, { agentAddress: apiWallet as Hex, agentName: "perpparrot" });
  console.log(`approved API wallet ${apiWallet}`);
}
console.log("done");
