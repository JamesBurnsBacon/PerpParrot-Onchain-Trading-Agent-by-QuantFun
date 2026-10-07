// Freezes the live source set (docs/ops/RUNBOOK.md "Freeze"): validates the review's
// FrozenConfiguration, saves it where the backend reads it, and prints the Vercel variables
// that must match (the backend and executor both pin its hash).
//
//   bun run scripts/freeze.ts <frozen-configuration.json> --account 0x… [--write]
//
// Without --write it only checks and prints. Commit frozen/live.json, set the variables, redeploy.
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "../src/snapshot";

const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^0x/.test(a));
const accountArg = process.argv[process.argv.indexOf("--account") + 1]?.toLowerCase();
const write = process.argv.includes("--write");
if (!file || !accountArg) {
  console.error("usage: freeze.ts <frozen-configuration.json> --account 0x… [--write]");
  process.exit(2);
}

const configuration = (await Bun.file(file).json()) as FrozenConfiguration;
checkFrozenConfiguration(keccakUtf8, configuration, configuration.configurationHash, Date.now());
if (configuration.account !== accountArg) {
  throw new Error(`configuration is for account ${configuration.account}, not ${accountArg}`);
}

const hash = configuration.configurationHash;
const invested = configuration.sources.reduce((sum, s) => sum + s.weightUnits, 0) / 1e6;
console.log(`✓ valid frozen configuration ${hash}`);
console.log(`  account ${configuration.account}, ${configuration.sources.length} sources, ${(invested * 100).toFixed(1)}% invested, ${configuration.policy.bucket}/${configuration.policy.mode}`);

const livePath = new URL("../frozen/live.json", import.meta.url);
if (write) {
  await Bun.write(livePath, `${JSON.stringify(configuration, null, 2)}\n`);
  console.log("  wrote packages/backend/frozen/live.json");
}

console.log(`
Set on the Vercel project (one set for both services), then redeploy:
  CONFIGURATION_PATH=frozen/live.json  FROZEN_CONFIGURATION_HASH=${hash}  HL_ACCOUNT=${configuration.account}
  MAX_GROSS_LEVERAGE=${configuration.policy.maxGrossLeverage}`);
if (!write) console.log("\nCheck only; re-run with --write to save frozen/live.json.");
