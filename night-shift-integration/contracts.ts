import { createHash } from 'node:crypto';
import { z } from 'zod';

// Ratios are fractions (0.05 = 5%); clocks are UTC epoch milliseconds.
export const VERSION = 'night-pipeline.v2';
export const BUCKET_MS = 600_000;
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
  throw new Error('Protocol only permits finite JSON values');
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const byteDigest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hash = z.string().regex(/^[0-9a-f]{64}$/);
export const eventSchema = z.object({
  schemaVersion: z.literal(VERSION), trigger: z.enum(['REPLAY', 'TICK']),
  bucketMs: z.number().int().positive(), sourceAsOfMs: z.number().int().positive(),
  sourceHash: hash, codeHash: hash, sourceKind: z.enum(['REAL_ARCHIVE', 'SYNTHETIC_FIXTURE']),
}).strict().superRefine((x, ctx) => {
  if (x.bucketMs % BUCKET_MS) ctx.addIssue({code: 'custom', message: 'bucket must align to ten minutes'});
  if (x.sourceAsOfMs > x.bucketMs || x.bucketMs - x.sourceAsOfMs > 1_200_000)
    ctx.addIssue({code: 'custom', message: 'source must precede bucket by at most twenty minutes'});
});
export type Event = z.infer<typeof eventSchema>;
export const runId = (e: Event) => `${VERSION}-${e.bucketMs}-${digest(e).slice(0, 16)}`;
export const envelopeSchema = z.object({
  schemaVersion: z.literal('night-artifact.v1'), runId: z.string(), stage: z.string(),
  inputHash: hash, bodyHash: hash, economicAuthority: z.literal(false), body: z.unknown(),
}).strict();
export type Envelope = z.infer<typeof envelopeSchema>;
export const algorithmSchema = z.enum(['return-first.v1', 'drawdown-first.v1']);
export type Algorithm = z.infer<typeof algorithmSchema>;
export const allocationSchema = z.object({
  schemaVersion: z.literal('night-allocation.v1'), algorithm: algorithmSchema,
  cutoffMs: z.number().int().positive(), eligible: z.number().int().nonnegative(),
  sources: z.array(z.object({address: z.string().regex(/^0x[0-9a-f]{40}$/), weight: z.number().finite().positive().max(1),
    trainReturn: z.number().finite(), trainDrawdown: z.number().finite().min(0).max(1), capitalUsd: z.number().finite().positive(),
  }).strict()).max(5), cashWeight: z.number().finite().min(0).max(1),
}).strict().superRefine((x, ctx) => {
  if (new Set(x.sources.map(s => s.address)).size !== x.sources.length ||
      Math.abs(x.sources.reduce((a, s) => a + s.weight, x.cashWeight) - 1) > 1e-9)
    ctx.addIssue({code: 'custom', message: 'duplicate source or weights do not sum to one'});
});
export type Allocation = z.infer<typeof allocationSchema>;
