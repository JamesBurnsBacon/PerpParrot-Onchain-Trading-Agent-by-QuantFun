import {z} from 'zod';
import {commitment} from './commitments.ts';
export const hashSchema=z.string().regex(/^0x[0-9a-f]{64}$/);
const positive=z.string().regex(/^(0|[1-9][0-9]{0,23})(\.[0-9]{1,18})?$/).refine(value=>/[1-9]/.test(value));
export const orderSchema=z.object({market:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),asset:z.number().int().min(0).max(9999),
  isBuy:z.boolean(),limitPx:positive,size:positive,reduceOnly:z.boolean(),tif:z.literal('Ioc'),
  cloid:z.string().regex(/^0x[0-9a-f]{32}$/),}).strict();
export const previewSchema=z.object({schemaVersion:z.literal('2.0.0'),mode:z.literal('PREVIEW'),economicAuthority:z.literal(false),
  chainId:z.number().int().positive().safe(),account:z.string().regex(/^0x[0-9a-f]{40}$/),
  runId:z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/),configurationHash:hashSchema,policyHash:hashSchema,
  planHash:hashSchema,executionEvidenceHash:hashSchema,createdAtMs:z.number().int().nonnegative().safe(),expiresAtMs:z.number().int().nonnegative().safe(),
  orders:z.array(orderSchema).max(10),deferredReversals:z.array(z.string()).max(10),
  worstInitialMarginMicros:z.string().regex(/^(0|[1-9][0-9]{0,23})$/),feeReserveMicros:z.string().regex(/^(0|[1-9][0-9]{0,23})$/),
  reportHash:hashSchema,
}).strict();
export type ExecutionPreview=z.infer<typeof previewSchema>;
export function sealExecutionPreview(payload:Omit<ExecutionPreview,'reportHash'>):ExecutionPreview {
  return previewSchema.parse({...payload,reportHash:commitment('perpparrot:execution-preview:v1',payload)});
}
export function validateExecutionPreview(value:unknown,nowMs:number):ExecutionPreview {
  const report=previewSchema.parse(value),{reportHash,...payload}=report;
  if(!Number.isSafeInteger(nowMs)||nowMs<report.createdAtMs||nowMs>=report.expiresAtMs||report.expiresAtMs-report.createdAtMs>60000)throw new Error('invalid preview freshness');
  if(reportHash!==commitment('perpparrot:execution-preview:v1',payload)||new Set(report.orders.map(o=>o.cloid)).size!==report.orders.length||new Set(report.orders.map(o=>o.market)).size!==report.orders.length)throw new Error('invalid preview commitment or duplicate order');
  return report;
}
