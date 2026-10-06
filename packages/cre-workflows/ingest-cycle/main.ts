import { bytesToBase64, consensusIdenticalAggregation, CronCapability, handler, HTTPClient, ok, Runner, text,
  type NodeRuntime, type Runtime } from "@chainlink/cre-sdk";
import { z } from "zod";
import { checkReceipt, configSchema, latestSchema, type Config } from "./validation";


const observe = (runtime: NodeRuntime<Config>, now: number): string => {
  const http = new HTTPClient();
  const bucket = Math.floor(now / 600_000) * 600_000;
  const response = http.sendRequest(runtime, { url: `${runtime.config.backendUrl}/ingest/trigger`, method: "POST",
    headers: { "Content-Type": "application/json" }, body: bytesToBase64(new TextEncoder().encode(JSON.stringify({ bucket }))),
    cacheSettings: { store: false } }).result();
  if (!ok(response)) throw new Error(`Ingest trigger failed: ${response.statusCode}`);
  const accepted = z.object({ accepted: z.literal(true), runId: z.literal(`ingest-${bucket / 1000}`), bucket: z.literal(bucket) }).strict().parse(JSON.parse(text(response)));
  const get = (path: string) => {
    const response = http.sendRequest(runtime, { url: `${runtime.config.backendUrl}${path}`, method: "GET", cacheSettings: { store: false } }).result();
    if (!ok(response)) throw new Error(`Ingest endpoint failed: ${response.statusCode}`);
    return text(response);
  };
  const latest = latestSchema.parse(JSON.parse(get("/ingest/latest")));
  const raw = get(`/ingest/receipts/${latest.receiptHash}`);
  return JSON.stringify({ requestedRunId: accepted.runId, ...checkReceipt(latest, raw, now, runtime.config.maxAgeSeconds) });
};

const onCronTrigger = (runtime: Runtime<Config>): string => {
  const observation = runtime.runInNodeMode(observe, consensusIdenticalAggregation<string>())(runtime.now().getTime()).result();
  const verified = JSON.parse(observation);
  const result = JSON.stringify({ mode: "local-simulation", status: verified.requestedRunId === verified.runId
    ? "current-batch-verified" : "previous-batch-verified-current-requested", ...verified });
  runtime.log(result);
  // Receiver-free: no report, signer, exchange call, or write capability exists.
  return result;
};
const initWorkflow = (config: Config) => [handler(new CronCapability().trigger({ schedule: config.schedule }), onCronTrigger)];
export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
