// Freezes the live source set (docs/cre/RUNBOOK.md "Freeze"): validates the review core's
// FrozenConfiguration, saves it where the snapshot service reads it, pins its hash in the
// mirror's production config, and prints the Vercel variables that must match.
//
//   bun run scripts/freeze.ts <frozen-configuration.json> --account 0x… [--write]
//
// Without --write it only checks and prints. Commit the two written files, then redeploy
// the mirror (CRE deploy Action) and the Vercel project.
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
const mirrorConfigPath = new URL("../../cre-workflows/mirror/config.production.json", import.meta.url);
if (write) {
  await Bun.write(livePath, `${JSON.stringify(configuration, null, 2)}\n`);
  const mirror = await Bun.file(mirrorConfigPath).json();
  await Bun.write(mirrorConfigPath, `${JSON.stringify({ ...mirror, frozenConfigurationHash: hash }, null, 2)}\n`);
  console.log("  wrote packages/backend/frozen/live.json and mirror/config.production.json");
}

console.log(`
Set on the Vercel project (one set for both services; must match the mirror config):
  CONFIGURATION_PATH=frozen/live.json  FROZEN_CONFIGURATION_HASH=${hash}  HL_ACCOUNT=${configuration.account}
Then commit, redeploy mirror (CRE deploy Action, production-settings) and both services.`);
if (!write) console.log("\nCheck only; re-run with --write to save the files.");
