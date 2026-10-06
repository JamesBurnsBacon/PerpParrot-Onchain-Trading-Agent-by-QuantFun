import {z} from 'zod';
import {commitment} from './commitments.ts';
import {validateFrozenConfiguration} from './frozen.ts';
import type {FrozenConfiguration} from './frozen.ts';
import type {MirrorPlan} from './mirror-plan.ts';
const hash=z.string().regex(/^0x[0-9a-f]{64}$/);
const money=z.string().regex(/^(0|-?[1-9][0-9]{0,23})$/);
const unsigned=z.string().regex(/^(0|[1-9][0-9]{0,23})$/);
const timestamp=z.number().int().nonnegative().safe();
const position=z.object({market:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),notionalMicros:money}).strict();
const planSchema=z.object({
  mode:z.literal('PAPER'),runId:z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/),
  configurationHash:hash,snapshotHash:hash,accountHash:hash,validationHash:hash,
  asOfMs:timestamp,expiresAtMs:timestamp,targets:z.array(position).max(100),
  deltas:z.array(position.extend({reduceOnly:z.boolean()}).strict()).max(10),
  grossNotionalMicros:unsigned,projectedGrossNotionalMicros:unsigned,
  worstFillGrossNotionalMicros:unsigned,planHash:hash,
}).strict();
const schema=z.object({schemaVersion:z.literal('1.0.0'),mode:z.literal('PAPER'),
  chainId:z.number().int().positive().safe(),account:z.string().regex(/^0x[0-9a-f]{40}$/),
  plan:planSchema,reportHash:hash,
}).strict();
export type PaperReport=z.infer<typeof schema>;
/** Paper envelope deliberately distinct from the live rebalance-report contract. */
export function createPaperReport(plan: MirrorPlan, configuration: FrozenConfiguration, nowMs:number): PaperReport {
  const payload={schemaVersion:'1.0.0' as const,mode:'PAPER' as const,chainId:configuration.chainId,account:configuration.account,plan};
  return validatePaperReport({...payload,reportHash:commitment('perpparrot:paper-report:v1',payload)},configuration,nowMs,plan.planHash);
}
/** expectedPlanHash must come from independent local rebuilding of fresh evidence,
 * not from the incoming report. A self-consistent hash is not authorization. */
export function validatePaperReport(value:unknown,configuration:FrozenConfiguration,nowMs:number,expectedPlanHash:string):PaperReport {
  validateFrozenConfiguration(configuration);
  const result=schema.parse(value);
  if(!Number.isSafeInteger(nowMs)||nowMs<result.plan.asOfMs||nowMs>=result.plan.expiresAtMs)throw new Error('expired or future paper report');
  if(result.account!==configuration.account||result.chainId!==configuration.chainId||result.plan.configurationHash!==configuration.configurationHash)throw new Error('paper report authority mismatch');
  const {planHash,...plan}=result.plan;
  if(planHash!==expectedPlanHash||planHash!==commitment('perpparrot:mirror-plan:v1',plan))throw new Error('paper plan mismatch');
  const {reportHash,...payload}=result;
  if(reportHash!==commitment('perpparrot:paper-report:v1',payload))throw new Error('paper report commitment mismatch');
  return result;
}
