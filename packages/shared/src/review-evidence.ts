import {z} from 'zod';
/** The anonymous per-finalist evidence the review models read (README §4.6): curve, positions and
 * fill patterns, plus the pair matrix. Strict: unknown keys and malformed series reject. */

const ratio = z.number().finite().min(0).max(1);
const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const position = z.object({
  market: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),
  signedNotionalUsd: z.number().finite(),
  leverage: z.number().finite().nonnegative().nullable(),
  liquidationDistance: ratio.nullable(),
}).strict();
const classExposure=z.object({longUsd:z.number().finite().nonnegative(),shortUsd:z.number().finite().nonnegative()}).strict();
export const exposureSchema=z.object({crypto:classExposure,gold:classExposure,oil:classExposure,other:classExposure}).strict();
export const finalistSchema = z.object({
  candidate: z.number().int().min(0).max(39),
  kind: z.enum(['TRADER', 'HYPERCORE_VAULT', 'ERC4626_HYPERCORE']),
  historyDays: z.number().int().min(0).max(10000),
  timeInMarket: ratio.nullable(),
  medianHoldMinutes: z.number().finite().nonnegative().nullable(),
  makerShare: ratio.nullable(),
  maxDrawdown: ratio.nullable(),
  equityCurve: z.array(z.object({atMs: timestamp, pnlUsd: z.number().finite()}).strict()).min(26).max(48),
  positions: z.array(position).max(12),
  patterns: z.object({
    increasesAfterLoss: ratio.nullable(),
    repeatedRoundTrips: ratio.nullable(),
    observedFills: z.number().int().min(0).max(10000).nullable(),
    costBasisAdds: z.number().int().nonnegative().optional(),
    closedEpisodes: z.number().int().nonnegative().optional(),
    continuityBreaks: z.number().int().nonnegative().optional(),
  }).strict(),
  exposureByClass: exposureSchema.optional(),
  measurement: z.object({
    version:z.literal('path-beta-v1'),
    fromMs:timestamp,toMs:timestamp,
    fillHistory:z.enum(['API_BOUNDED','TRUNCATED']),
    btcDailyPairs:z.number().int().min(0).max(31),
    exposureScope:z.literal('core+xyz current positions; all before detail cap'),
  }).strict().optional(),
}).strict();
export const evidenceSchema = z.object({
  asOfMs: timestamp,
  finalists: z.array(finalistSchema).min(1).max(40),
  pairs: z.array(z.object({
    a: z.number().int().min(0).max(39), b: z.number().int().min(0).max(39),
    correlation: z.number().finite().min(-1).max(1).nullable(), linkedSource: z.boolean(),
  }).strict()).max(780),
}).strict();
export type Evidence = z.infer<typeof evidenceSchema>;
export function byteLength(value: unknown): number {return new TextEncoder().encode(JSON.stringify(value)).length;}
function ensure(ok: boolean, reason: string): asserts ok {if (!ok) throw new Error(reason);}
export function validateEvidence(value: unknown): Evidence {
  const evidence = evidenceSchema.parse(value);
  const ids = evidence.finalists.map(finalist => finalist.candidate);
  ensure(new Set(ids).size === ids.length && ids.every((id, index) => index === 0 || ids[index - 1] < id), 'candidate IDs must be unique and sorted');
  for (const finalist of evidence.finalists) {
    ensure(byteLength(finalist) <= 4096, 'finalist exceeds 4 KB');
    ensure(finalist.equityCurve.every((point, index, points) => point.atMs <= evidence.asOfMs && (index === 0 || point.atMs > points[index - 1].atMs)), 'invalid curve time/order');
    ensure(new Set(finalist.positions.map(p => p.market)).size === finalist.positions.length, 'duplicate position market');
  }
  const pairs = new Set<string>();
  for (const pair of evidence.pairs) {
    const key = `${pair.a}:${pair.b}`;
    ensure(pair.a < pair.b && ids.includes(pair.a) && ids.includes(pair.b) && !pairs.has(key), 'invalid pair identity/order');
    pairs.add(key);
  }
  ensure(pairs.size === ids.length * (ids.length - 1) / 2, 'incomplete correlation matrix');
  return evidence;
}
