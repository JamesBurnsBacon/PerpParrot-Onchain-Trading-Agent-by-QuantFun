import {
  bytesToBase64,
  ConsensusAggregationByFields,
  consensusIdenticalAggregation,
  CronCapability,
  type CronPayload,
  handler,
  HTTPClient,
  identical,
  json,
  median,
  type NodeRuntime,
  ok,
  prepareReportRequest,
  Runner,
  type Runtime,
  text,
} from "@chainlink/cre-sdk";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as hexOf, hexToBytes as bytesOf } from "@noble/hashes/utils.js";
import { z } from "zod";
import { readAccountState, type PerpState, type PortfolioResponse } from "../../shared/account";
import { capGrossExposure, computeExposures, deviationBps, EXPOSURE_SCALE } from "../../shared/copy";
import type { MirrorReport } from "../../shared/report";
import { ELIGIBLE_DEXES } from "../../shared/snapshot";
import { encodeReportBody, toEnvelope } from "./report";
import { checkSnapshot, keccakUtf8, pickSample, snapshotSchema } from "./snapshot";

const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

const configSchema = z.object({
  schedule: z.string(),
  // z.string().url() needs URL, which the WASM runtime lacks.
  backendUrl: z.string().startsWith("http"),
  executorUrl: z.string().startsWith("http"),
  // configurationHash of the frozen configuration (README §4.7 freeze commitment).
  // It also fixes our HL account.
  frozenConfigurationHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  // 3 HTTP calls per source (core + xyz positions, portfolio equity). Budget:
  // 1 snapshot + 3 × spotCheckCount + 1 executor ≤ CRE's 15.
  spotCheckCount: z.number().int().min(1).max(4),
  maxDeviationBps: z.number().int().positive(),
  maxSnapshotAgeSeconds: z.number().int().positive(),
  // The executor rejects the report after asOf + reportTtlSeconds.
  reportTtlSeconds: z.number().int().positive(),
});

export type Config = z.infer<typeof configSchema>;

// What each node observes. Fields derived from the immutable snapshot must be
// identical across nodes; the live spot-check differs slightly, so it takes the median.
type Observation = {
  snapshotId: string;
  // From the frozen configuration.
  account: string;
  // keccak256 of the snapshot JSON bytes.
  snapshotHash: string;
  // JSON [{asset, exposureE9}] — kept small for the 25 KB consensus limit.
  exposures: string;
  maxDeviationBps: number;
};

const observe = (nodeRuntime: NodeRuntime<Config>, runAt: number, samplingKey: string): Observation => {
  const { config } = nodeRuntime;
  const http = new HTTPClient();

  const snapRes = http.sendRequest(nodeRuntime, { url: `${config.backendUrl}/snapshots/${runAt}`, method: "GET" }).result();
  if (!ok(snapRes)) throw new Error(`snapshot fetch failed: ${snapRes.statusCode}`);
  const raw = text(snapRes);
  const snapshot = snapshotSchema.parse(JSON.parse(raw));
  const sources = checkSnapshot(snapshot, {
    frozenConfigurationHash: config.frozenConfigurationHash,
    runAt,
    maxSnapshotAgeSeconds: config.maxSnapshotAgeSeconds,
  });

  const hlInfo = <T>(body: Record<string, unknown>): T => {
    const res = http
      .sendRequest(nodeRuntime, {
        url: HL_INFO_URL,
        method: "POST",
        body: bytesToBase64(new TextEncoder().encode(JSON.stringify(body))),
        headers: { "Content-Type": "application/json" },
      })
      .result();
    if (!ok(res)) throw new Error(`HL ${body.type} failed: ${res.statusCode}`);
    return json(res) as T;
  };
  const portfolio = (user: string) => hlInfo<PortfolioResponse>({ type: "portfolio", user });

  // Live view of a source: positions on each eligible dex plus its account value.
  const eligible = new Set(snapshot.eligibleAssets);
  const liveSource = (user: string) =>
    readAccountState(
      ELIGIBLE_DEXES.map((dex) => hlInfo<PerpState>({ type: "clearinghouseState", user, ...(dex ? { dex } : {}) })),
      portfolio(user),
      eligible,
    );

  // Which sources get spot-checked must be unpredictable to the backend, which built
  // the snapshot: HMAC keyed by a CRE secret the backend never sees (the review core's
  // mirror-spike design), over the snapshot the nodes are checking. Identical on every node.
  const snapshotHash = keccakUtf8(raw);
  const seed = hexOf(hmac(sha256, bytesOf(samplingKey.slice(2)), new TextEncoder().encode(`perpparrot:sample:v1:${runAt}:${snapshotHash}`)));
  const sample = pickSample(sources, seed, config.spotCheckCount);
  const maxDev = Math.max(...sample.map((s) => deviationBps(s, liveSource(s.address))));

  const maxGrossE9 = BigInt(Math.round(snapshot.configuration.policy.maxGrossLeverage * Number(EXPOSURE_SCALE)));
  const exposures = capGrossExposure(computeExposures(sources), maxGrossE9);

  return {
    snapshotId: snapshot.snapshotId,
    account: snapshot.configuration.account,
    snapshotHash,
    exposures: JSON.stringify(exposures.map((e) => ({ asset: e.asset, exposureE9: e.exposureE9.toString() }))),
    maxDeviationBps: maxDev,
  };
};

export const buildMirrorReport = (config: Config, runAt: number, obs: Observation): MirrorReport => {
  const exposures = JSON.parse(obs.exposures) as { asset: string; exposureE9: string }[];
  return {
    runId: `mirror-${runAt}`,
    snapshotHash: obs.snapshotHash as `0x${string}`,
    configurationHash: config.frozenConfigurationHash as `0x${string}`,
    account: obs.account as `0x${string}`,
    asOf: BigInt(runAt),
    expiresAt: BigInt(runAt + config.reportTtlSeconds),
    exposures: exposures.map((e) => ({ asset: e.asset, exposureE9: BigInt(e.exposureE9) })),
  };
};

// README §4.7: snapshot → spot-check → exposures → DON-signed report → executor.
// On any failure the run throws and the executor holds positions until the next run.
export const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const { config } = runtime;
  const runAt = Number(payload.scheduledExecutionTime?.seconds ?? BigInt(Math.floor(runtime.now().getTime() / 1000)));

  // 32-byte key from CRE secrets (Vault DON when deployed, .env in simulation).
  const samplingKey = runtime.getSecret({ id: "mirrorSamplingKey" }).result().value;
  if (!/^0x[0-9a-f]{64}$/.test(samplingKey) || /^0x0+$/.test(samplingKey)) throw new Error("invalid mirrorSamplingKey secret");

  const obs = runtime
    .runInNodeMode(
      observe,
      ConsensusAggregationByFields<Observation>({
        snapshotId: identical,
        account: identical,
        snapshotHash: identical,
        exposures: identical,
        maxDeviationBps: median,
      }),
    )(runAt, samplingKey)
    .result();

  runtime.log(`${obs.snapshotId}: spot-check max deviation ${obs.maxDeviationBps} bps`);
  if (obs.maxDeviationBps > config.maxDeviationBps) {
    throw new Error(`spot-check failed: ${obs.maxDeviationBps} bps > ${config.maxDeviationBps} bps`);
  }

  const mirrorReport = buildMirrorReport(config, runAt, obs);
  const report = runtime.report(prepareReportRequest(encodeReportBody(mirrorReport))).result();

  // The status code, not just ok: duplicates and acceptances are both 200, and a
  // rejection is the same 4xx on every node, so identical consensus holds either way.
  const status = new HTTPClient()
    .sendRequest(
      runtime,
      (sendRequester) =>
        sendRequester
          .sendReport(report, (r) => ({
            url: config.executorUrl,
            method: "POST",
            body: bytesToBase64(new TextEncoder().encode(JSON.stringify(toEnvelope(r)))),
            headers: { "Content-Type": "application/json" },
            cacheSettings: { store: true, maxAge: "60s" },
          }))
          .result().statusCode,
      consensusIdenticalAggregation<number>(),
    )()
    .result();

  if (status < 200 || status >= 300) throw new Error(`executor rejected the report: HTTP ${status}`);
  runtime.log(`delivered ${mirrorReport.runId}: ${mirrorReport.exposures.length} exposures`);
  return mirrorReport.runId;
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
