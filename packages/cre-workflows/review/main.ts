import { ConfidentialHTTPClient, CronCapability, handler, json, ok, Runner, type Runtime } from "@chainlink/cre-sdk";
import { z } from "zod";
import { buildAgentRequestBody, parseAgentResponse, type AgentOutput } from "./agent";
import { FIXTURE_FINALISTS } from "./fixtures";

const configSchema = z.object({
  schedule: z.string(),
  // z.string().url() needs URL, which the WASM runtime lacks.
  openaiUrl: z.string().startsWith("https://"),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  timeoutSeconds: z.number().int().positive(),
  // Vault DON secret owner: "" in simulation, the org ID when org-owned (README §4.14).
  secretsOwner: z.string(),
});

export type Config = z.infer<typeof configSchema>;

// Spike: one LLM call through Confidential HTTP. It runs once in an enclave, not
// on every node, and the API key is injected from the Vault DON via the template.
export const onCronTrigger = (runtime: Runtime<Config>): string => {
  const { config } = runtime;
  const finalists = FIXTURE_FINALISTS;

  const response = new ConfidentialHTTPClient()
    .sendRequest(runtime, {
      request: {
        url: config.openaiUrl,
        method: "POST",
        bodyString: buildAgentRequestBody(finalists, config),
        multiHeaders: {
          Authorization: { values: ["Bearer {{.openaiApiKey}}"] },
          "Content-Type": { values: ["application/json"] },
        },
        timeout: `${config.timeoutSeconds}s`,
      },
      vaultDonSecrets: [{ key: "openaiApiKey", owner: config.secretsOwner }],
    })
    .result();

  if (!ok(response)) {
    throw new Error(`OpenAI request failed with status ${response.statusCode}`);
  }

  const output: AgentOutput = parseAgentResponse(json(response), finalists);
  for (const pick of output.picks) {
    runtime.log(`pick ${pick.id} w=${pick.weight.toFixed(2)} flags=[${pick.redFlags.join("; ")}]`);
  }
  for (const r of output.rejected) {
    runtime.log(`reject ${r.id}: ${r.reason}`);
  }
  return JSON.stringify(output);
};

export const initWorkflow = (config: Config) => {
  const cron = new CronCapability();

  return [handler(cron.trigger({ schedule: config.schedule }), onCronTrigger)];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
