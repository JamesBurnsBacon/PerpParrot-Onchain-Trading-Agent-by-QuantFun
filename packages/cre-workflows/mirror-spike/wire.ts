import {z} from 'zod';
import {validateFrozenConfiguration} from '../../shared/src/frozen-runtime.ts';
import type {FrozenConfiguration} from '../../shared/src/frozen-runtime.ts';
const hash=z.string().regex(/^0x[0-9a-f]{64}$/),address=z.string().regex(/^0x[0-9a-f]{40}$/);
const money=z.string().regex(/^(0|-?[1-9][0-9]{0,23})$/);
export const accountSchema=z.object({address,observedAtMs:z.number().int().nonnegative().safe(),equityMicros:money,
  positions:z.array(z.object({market:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),notionalMicros:money}).strict()).max(100)}).strict();
export const snapshotSchema=z.object({configurationHash:hash,publishedAtMs:z.number().int().nonnegative().safe(),sources:z.array(accountSchema).min(5).max(25),snapshotHash:hash}).strict();
export const mirrorConfigSchema=z.object({schedule:z.literal('0 */10 * * * *'),mode:z.literal('PAPER'),
  configuration:z.custom<FrozenConfiguration>(value=>{try{validateFrozenConfiguration(value as FrozenConfiguration);return true;}catch{return false;}}),
  snapshotUrl:z.string().url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash;}),
  rpcUrl:z.string().url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash;}),
  chainSelector:z.string().regex(/^[1-9][0-9]{0,19}$/),consumer:address,runtimeCodeHash:hash,forwarder:address,workflowOwner:address,reviewWorkflowId:hash,mirrorWorkflowId:hash,
  markets:z.array(z.object({market:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),maxAbsNotionalMicros:money,reduceOnly:z.boolean()}).strict()).min(1).max(100),
  maxStateAgeMs:z.number().int().min(1).max(60000),
}).strict();
export type MirrorConfig=z.infer<typeof mirrorConfigSchema>;
