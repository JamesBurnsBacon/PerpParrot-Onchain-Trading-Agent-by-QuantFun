// Freezes the live source set (docs/cre/RUNBOOK.md "Freeze"): validates the review core's
// FrozenConfiguration, saves it where the snapshot service reads it, pins its hash in the
// mirror's production config, and prints the Railway variables that must match.
//
//   bun run scripts/freeze.ts <frozen-configuration.json> --account 0x… [--write]
//
// Without --write it only checks and prints. Commit the two written files, then redeploy
// the mirror (CRE deploy Action) and both Railway services.
import { type FrozenConfiguration } from "../../shared/frozen";
import { unlink } from "node:fs/promises";
import { prepareFreezeDeployment, writeFreezeDeployment } from "../src/freeze-deployment";

const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--") && !/^0x/.test(a));
const accountIndex = process.argv.indexOf("--account");
const accountArg = accountIndex >= 0 ? process.argv[accountIndex + 1]?.toLowerCase() : undefined;
const write = process.argv.includes("--write");
if (!file || !accountArg) {
  console.error("usage: freeze.ts <frozen-configuration.json> --account 0x… [--write]");
  process.exit(2);
}

const configuration = (await Bun.file(file).json()) as FrozenConfiguration;
const livePath = new URL("../frozen/live.json", import.meta.url);
const mirrorConfigPath = new URL("../../cre-workflows/mirror/config.production.json", import.meta.url);
const prepared = prepareFreezeDeployment(configuration, accountArg, await Bun.file(mirrorConfigPath).json(), Date.now());

const hash = configuration.configurationHash;
const invested = configuration.sources.reduce((sum, s) => sum + s.weightUnits, 0) / 1e6;
console.log(`✓ valid frozen configuration ${hash}`);
console.log(`  account ${configuration.account}, ${configuration.sources.length} sources, ${(invested * 100).toFixed(1)}% invested, ${configuration.policy.bucket}/${configuration.policy.mode}`);

if (write) {
  const pathFor = (path: "live" | "mirror") => path === "live" ? livePath : mirrorConfigPath;
  await writeFreezeDeployment(prepared, {
    read: async (path) => {
      const file = Bun.file(pathFor(path));
      return await file.exists() ? file.text() : undefined;
    },
    write: async (path, contents) => { await Bun.write(pathFor(path), contents); },
    remove: async (path) => { if (await Bun.file(pathFor(path)).exists()) await unlink(pathFor(path)); },
  });
  console.log("  wrote packages/backend/frozen/live.json and mirror/config.production.json");
}

console.log(`
Set on Railway (both must match the mirror config):
  snapshot service  CONFIGURATION_PATH=frozen/live.json  FROZEN_CONFIGURATION_HASH=${hash}
  executor          FROZEN_CONFIGURATION_HASH=${hash}  HL_ACCOUNT=${configuration.account}
                    MAX_REPORT_TTL_SECONDS=${prepared.environment.MAX_REPORT_TTL_SECONDS}  MAX_GROSS_LEVERAGE=${prepared.environment.MAX_GROSS_LEVERAGE}
Then commit, redeploy mirror (CRE deploy Action, production-settings) and both services.`);
if (!write) console.log("\nCheck only; re-run with --write to save the files.");
