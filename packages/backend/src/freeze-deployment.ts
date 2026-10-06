// Prepare the backend/mirror deployment pair before touching either artifact.
import { checkFrozenConfiguration, type FrozenConfiguration } from "../../shared/frozen";
import { keccakUtf8 } from "./snapshot";

export const prepareFreezeDeployment = (value: FrozenConfiguration, account: string, mirror: unknown, nowMs: number) => {
  // Own the inputs so later caller mutations cannot split the prepared pair.
  const configuration = structuredClone(value);
  checkFrozenConfiguration(keccakUtf8, configuration, configuration.configurationHash, nowMs);
  if (!/^0x[0-9a-f]{40}$/i.test(account) || configuration.account !== account.toLowerCase()) {
    throw new Error("freeze account mismatch");
  }
  if (!mirror || typeof mirror !== "object" || Array.isArray(mirror)) throw new Error("invalid mirror configuration");
  const config = structuredClone(mirror) as Record<string, unknown>;
  const fields = ["schedule", "backendUrl", "executorUrl", "frozenConfigurationHash", "spotCheckCount", "maxDeviationBps", "maxSnapshotAgeSeconds", "reportTtlSeconds"];
  if (Object.keys(config).sort().join(",") !== fields.sort().join(",")) throw new Error("unknown or missing mirror fields");
  if (config.schedule !== "0 */10 * * * *") throw new Error("mirror schedule must run every ten minutes");
  for (const name of ["backendUrl", "executorUrl"]) {
    if (typeof config[name] !== "string") throw new Error(`invalid ${name}`);
    const url = new URL(config[name]);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(`invalid production ${name}`);
  }
  for (const name of ["spotCheckCount", "maxDeviationBps", "maxSnapshotAgeSeconds", "reportTtlSeconds"]) {
    if (!Number.isSafeInteger(config[name]) || (config[name] as number) <= 0) throw new Error(`invalid ${name}`);
  }
  if ((config.spotCheckCount as number) > 4) throw new Error("mirror exceeds fifteen HTTP call budget");
  if ((config.maxDeviationBps as number) > 500) throw new Error("mirror deviation exceeds five percent");
  if (typeof config.frozenConfigurationHash !== "string" || !/^0x[0-9a-f]{64}$/.test(config.frozenConfigurationHash)) throw new Error("invalid mirror commitment");
  const previousMirrorJson = JSON.stringify(config);
  config.frozenConfigurationHash = configuration.configurationHash;
  return {
    configuration,
    previousMirrorJson,
    liveJson: `${JSON.stringify(configuration, null, 2)}\n`,
    mirrorJson: `${JSON.stringify(config, null, 2)}\n`,
    environment: {
      FROZEN_CONFIGURATION_HASH: configuration.configurationHash,
      HL_ACCOUNT: configuration.account,
      CONFIGURATION_PATH: "frozen/live.json",
      MAX_REPORT_TTL_SECONDS: String(config.reportTtlSeconds),
      MAX_GROSS_LEVERAGE: String(configuration.policy.maxGrossLeverage),
    },
  };
};

export type FreezeFiles = {
  read: (path: "live" | "mirror") => Promise<string | undefined>;
  write: (path: "live" | "mirror", contents: string) => Promise<void>;
  remove: (path: "live" | "mirror") => Promise<void>;
};

// Offline preparation only: stop services before deploying the resulting pair.
// Rollback handles ordinary I/O errors; process death still requires inspection.
export const writeFreezeDeployment = async (plan: ReturnType<typeof prepareFreezeDeployment>, files: FreezeFiles): Promise<void> => {
  const liveJson = plan.liveJson;
  const mirrorJson = plan.mirrorJson;
  const previousLive = await files.read("live");
  const previousMirror = await files.read("mirror");
  if (previousMirror === undefined) throw new Error("mirror configuration disappeared before write");
  if (JSON.stringify(JSON.parse(previousMirror)) !== plan.previousMirrorJson) throw new Error("mirror configuration changed since preparation");
  try {
    await files.write("live", liveJson);
    await files.write("mirror", mirrorJson);
  } catch (cause) {
    // Even a rejected write may have partially changed its target.
    const restored = await Promise.allSettled([
      previousLive === undefined ? files.remove("live") : files.write("live", previousLive),
      files.write("mirror", previousMirror),
    ]);
    const failures = restored.filter((r) => r.status === "rejected");
    if (failures.length) throw new AggregateError([cause, ...failures.map((r) => (r as PromiseRejectedResult).reason)], "freeze write and rollback failed; inspect both artifacts before deployment");
    throw new Error("freeze write failed; previous artifacts restored", { cause });
  }
};
