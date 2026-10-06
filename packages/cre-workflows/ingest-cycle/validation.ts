import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";

export const configSchema = z.object({
  mode: z.literal("local-simulation"),
  schedule: z.literal("0 */10 * * * *"),
  backendUrl: z.string().regex(/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/),
  maxAgeSeconds: z.number().int().min(1).max(900),
}).strict();
export type Config = z.infer<typeof configSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/), address = z.string().regex(/^0x[a-f0-9]{40}$/);
const ms = z.number().int().nonnegative().safe();
export const latestSchema = z.object({ runId: z.string().regex(/^ingest-[0-9]+$/), bucket: ms,
  completedAt: ms, artifactHash: hash, receiptHash: hash, count: z.literal(100) }).strict();
const receiptSchema = z.object({ schema: z.literal("ingest-cycle-receipt.v1"), runId: z.string(), bucket: ms,
  completedAt: ms, count: z.literal(100), scoreLabel: z.literal("STRICT_REPOSITORY_SCORE"),
  allowUnknown: z.array(z.string()).length(0), artifactHash: hash,
  selected: z.array(address).length(100), next: z.array(address).length(100), oldestFetchedAt: ms }).strict();

export function checkReceipt(latestValue: unknown, raw: string, now: number, maxAge: number) {
  const latest = latestSchema.parse(latestValue), receipt = receiptSchema.parse(JSON.parse(raw));
  if (bytesToHex(sha256(new TextEncoder().encode(raw))) !== latest.receiptHash) throw new Error("Receipt hash mismatch");
  if (receipt.runId !== latest.runId || receipt.bucket !== latest.bucket || receipt.completedAt !== latest.completedAt
    || receipt.artifactHash !== latest.artifactHash || receipt.runId !== `ingest-${receipt.bucket / 1000}`
    || receipt.bucket % 600_000 !== 0) throw new Error("Receipt identity mismatch");
  if (receipt.completedAt > now || receipt.oldestFetchedAt > receipt.completedAt
    || receipt.bucket > receipt.completedAt || receipt.completedAt - receipt.bucket > 1_200_000
    || now - receipt.completedAt > maxAge * 1000 || receipt.completedAt - receipt.oldestFetchedAt > 540_000) throw new Error("Stale/future receipt");
  if (new Set(receipt.selected).size !== 100 || new Set(receipt.next).size !== 100) throw new Error("Duplicate account in receipt");
  return { runId: receipt.runId, receiptHash: latest.receiptHash, artifactHash: receipt.artifactHash, count: receipt.count };
}
