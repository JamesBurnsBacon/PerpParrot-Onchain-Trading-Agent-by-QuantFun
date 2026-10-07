import { z } from "zod";
import { demoData } from "../data";
import type { DashboardSnapshot, EndpointResult } from "../types";

// Narrow, read-only validation of fields actually used. Extra original evidence is preserved.
export const runSchema = z
  .object({
    id: z.string(),
    runId: z.string(),
    kind: z.enum(["mirror", "flatten"]),
    status: z.enum(["executed", "skipped_paused", "failed"]),
    dryRun: z.boolean(),
    startedAt: z.number(),
    finishedAt: z.number(),
    plan: z
      .object({
        orders: z.array(
          z
            .object({
              asset: z.string(),
              isBuy: z.boolean(),
              notionalUsd: z.number(),
              targetUsd: z.number(),
              currentUsd: z.number(),
            })
            .passthrough(),
        ),
        skipped: z.array(z.unknown()),
      })
      .passthrough()
      .optional(),
    results: z.array(z.object({ status: z.string() }).passthrough()).optional(),
  })
  .passthrough();
const pipelineSchema = z
  .object({
    accounts: z
      .object({ listed: z.number(), fresh: z.number(), errors: z.number() })
      .passthrough(),
    selections: z.array(z.unknown()),
    active: z.union([
      z
        .object({
          hash: z.string(),
          activated_at: z.string(),
          sources: z.array(
            z
              .object({
                candidate: z.number(),
                sourceAddress: z.string(),
                weightUnits: z.number(),
                ceilingUnits: z.number(),
              })
              .passthrough(),
          ),
        })
        .passthrough(),
      z.null(),
    ]),
  })
  .passthrough();
const paperSchema = z
  .object({
    lastRunAt: z.number().nullable(),
    books: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          startingEquityUsd: z.number(),
          equityUsd: z.number(),
          returnPct: z.number(),
          curve: z.array(z.tuple([z.number(), z.number()])),
        })
        .passthrough(),
    ),
  })
  .passthrough();
const statusSchema = z
  .object({
    dryRun: z.boolean(),
    account: z.string(),
    controls: z.object({ paused: z.boolean() }),
    lastRunAt: z.number().nullable(),
  })
  .passthrough();
const equitySchema = z
  .object({
    runs: z.number(),
    points: z.array(z.tuple([z.number(), z.number()])),
  })
  .passthrough();
const exposuresSchema = z
  .object({
    runAt: z.number(),
    exposures: z.array(
      z.object({ asset: z.string(), fraction: z.number() }).passthrough(),
    ),
  })
  .passthrough();
export type AdapterOptions = {
  mode: "demo" | "live";
  backendUrl?: string;
  executorUrl?: string;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
};
export function resolveApiBase(
  value: string | undefined,
  fallback: string,
): string {
  const base = value?.trim() || fallback;
  if (/[?#]/.test(base))
    throw new Error("API base URL must not contain a query or fragment");
  if (base.startsWith("/") && !base.startsWith("//"))
    return base.replace(/\/$/, "");
  const url = new URL(base);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(
      "API URL must use HTTP or HTTPS without embedded credentials",
    );
  return base.replace(/\/$/, "");
}
async function read(
  url: string,
  schema: z.ZodType,
  options: AdapterOptions,
): Promise<EndpointResult> {
  const timeout = AbortSignal.timeout(12_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      method: "GET",
      cache: "no-store",
      signal,
      credentials: "same-origin",
    });
    if (!response.ok)
      return { status: "unavailable", error: `HTTP ${response.status}` };
    const result = schema.safeParse(await response.json());
    return result.success
      ? { status: "available", data: result.data }
      : {
          status: "unavailable",
          error: "Response does not match the verified dashboard contract",
        };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (
      timeout.aborted ||
      (error instanceof Error && error.name === "TimeoutError")
    )
      return {
        status: "unavailable",
        error: "Request timed out. Check the service URL and network.",
      };
    if (error instanceof Error && error.name === "AbortError") throw error;
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : "Read failed",
    };
  }
}
export async function loadDashboard(
  options: AdapterOptions,
): Promise<DashboardSnapshot> {
  if (options.mode === "demo") return structuredClone(demoData);
  const backend = resolveApiBase(options.backendUrl, "/api/backend");
  const executor = resolveApiBase(options.executorUrl, "/api/executor");
  const definitions: [string, string, z.ZodType][] = [
    ["paper", `${backend}/paper`, paperSchema],
    ["runs", `${executor}/runs?summary=1&limit=144`, z.array(runSchema)],
    ["recent", `${executor}/runs?limit=8`, z.array(runSchema)],
    ["equity", `${executor}/equity`, equitySchema],
    ["status", `${executor}/status`, statusSchema],
    ["exposures", `${backend}/exposures`, exposuresSchema],
    ["pipeline", `${backend}/pipeline`, pipelineSchema],
  ];
  const results = await Promise.all(
    definitions.map(
      async ([name, url, schema]) =>
        [name, await read(url, schema, options)] as const,
    ),
  );
  // Real addresses/weights remain in pipeline evidence. No invented names, returns or drawdowns.
  return {
    mode: "live",
    loadedAt: new Date().toISOString(),
    sources: [],
    evidence: Object.fromEntries(results),
  };
}
export function countPlannedOrders(run: unknown): number {
  return runSchema.parse(run).plan?.orders.length ?? 0;
}
// Executed run is an executor status; it does not imply exchange fills. Consumers must inspect results.
