import {
  bytesToBase64,
  consensusIdenticalAggregation,
  CronCapability,
  type CronPayload,
  handler,
  HTTPClient,
  ok,
  prepareReportRequest,
  Runner,
  type Runtime,
} from "@chainlink/cre-sdk";
import { z } from "zod";
import type { MirrorReport } from "../../shared/report";
import { encodeReportBody, toEnvelope } from "./report";

const configSchema = z.object({
  schedule: z.string(),
  // z.string().url() needs URL, which the WASM runtime lacks.
  executorUrl: z.string().startsWith("http"),
  frozenSetHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});

export type Config = z.infer<typeof configSchema>;

// Spike fixture until slices → net → diff is built (README §4.7 step 3).
const FIXTURE = {
  snapshotId: "fixture-0001",
  equityE6: 470_000_000n,
  targets: [
    { asset: "BTC", notionalE6: 1_200_000_000n },
    { asset: "ETH", notionalE6: -350_000_000n },
    { asset: "xyz:MSFT", notionalE6: 60_000_000n },
  ],
};

export const buildMirrorReport = (config: Config, scheduledSeconds: bigint): MirrorReport => ({
  runId: `mirror-${scheduledSeconds}`,
  snapshotId: FIXTURE.snapshotId,
  asOf: scheduledSeconds,
  frozenSetHash: config.frozenSetHash as `0x${string}`,
  equityE6: FIXTURE.equityE6,
  targets: FIXTURE.targets,
});

// Spike: sign a targets report and POST it to the executor (README §4.13).
// Every DON node sends its own copy; the executor dedupes by keccak256(rawReport).
export const onCronTrigger = (runtime: Runtime<Config>, payload: CronPayload): string => {
  const { config } = runtime;
  const scheduled = payload.scheduledExecutionTime?.seconds ?? BigInt(Math.floor(runtime.now().getTime() / 1000));
  const mirrorReport = buildMirrorReport(config, scheduled);

  const report = runtime.report(prepareReportRequest(encodeReportBody(mirrorReport))).result();

  const delivered = new HTTPClient()
    .sendRequest(
      runtime,
      (sendRequester) =>
        ok(
          sendRequester
            .sendReport(report, (r) => ({
              url: config.executorUrl,
              method: "POST",
              body: bytesToBase64(new TextEncoder().encode(JSON.stringify(toEnvelope(r)))),
              headers: { "Content-Type": "application/json" },
              cacheSettings: { store: true, maxAge: "60s" },
            }))
            .result(),
        ),
      consensusIdenticalAggregation<boolean>(),
    )()
    .result();

  if (!delivered) throw new Error("Executor rejected the report");
  runtime.log(`delivered ${mirrorReport.runId}: ${mirrorReport.targets.length} targets`);
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
