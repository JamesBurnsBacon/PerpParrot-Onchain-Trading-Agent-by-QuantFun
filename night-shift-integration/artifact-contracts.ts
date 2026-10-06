import {z} from 'zod';
import {serviceProofSchema} from './service-loop.ts';
import {allocationSchema,algorithmSchema} from './contracts.ts';
const n=z.number().finite(), h=z.string().regex(/^0x[0-9a-f]{64}$/);
export const probeSchema=z.object({
  schemaVersion:z.literal('night-module-probe.v2'),sourceKind:z.literal('SYNTHETIC_FIXTURE'),economicAuthority:z.literal(false),algorithm:algorithmSchema,
  score:z.object({inputs:z.number().int(),eligible:z.number().int(),finalists:z.literal(5)}).strict(),
  allocation:allocationSchema,reviewStatus:z.literal('VALID'),reviewReceiptHash:h,configurationHash:h,
  fixtureAccount:z.string().regex(/^0x[0-9a-f]{40}$/),auditRows:z.number().int().min(3),
  databaseRestartVerified:z.literal(true),afterFreezePhase:z.literal('MONITOR'),targetGuardsRejected:z.literal(2),targetsRoundtrip:z.literal(true),serviceProof:serviceProofSchema,
  plan:z.object({orders:z.array(z.object({asset:z.string(),assetId:z.number().int(),isBuy:z.boolean(),price:z.string(),size:z.string(),
    reduceOnly:z.boolean(),notionalUsd:n,targetUsd:n,currentUsd:n}).strict()).length(5),
    skipped:z.array(z.object({asset:z.string(),reason:z.enum(['BELOW_DRIFT','BELOW_MIN_ORDER','UNKNOWN_MARKET','SIZE_ROUNDS_TO_ZERO','NOT_TRADABLE','LEVERAGE_FAILED']),targetUsd:n,currentUsd:n}).strict()),marginScale:n,initialMarginUsd:n}).strict(),
  fixtureFields:z.array(z.string()),reusedModules:z.array(z.string()),
}).strict();
export const dashboardBundleSchema=z.object({
  artifacts:z.array(z.object({days:z.number().int(),artifact:z.object({generatedAt:z.number().int(),window:z.string(),series:z.array(z.object({
    id:z.string(),label:z.string(),points:z.array(z.tuple([z.number().int(),n]))}).strict())}).strict()}).strict()).length(4),
  funnel:z.object({generatedAt:z.number().int(),steps:z.array(z.object({stage:z.string(),label:z.string(),count:z.number().int()}).strict()),
    finalists:z.array(z.object({address:z.string(),kind:z.string(),score:n,picked:z.boolean(),rationale:z.string().optional()}).strict()).optional()}).strict(),
}).strict();
