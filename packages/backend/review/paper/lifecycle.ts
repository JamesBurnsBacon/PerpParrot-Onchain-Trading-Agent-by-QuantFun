// @env node
import {z} from '../../../shared/src/zod.ts';
import {runCommitteeReview,validateCommitteeReceipt} from '../../../cre-workflows/review/committee/workflow.ts';
import type {CommitteeDependencies,CommitteeReceipt} from '../../../cre-workflows/review/committee/types.ts';
import {bindCommitteeEvidence} from '../../../shared/src/committee-evidence.ts';
import type {CommitteeEvidence} from '../../../shared/src/committee-evidence.ts';
import {proposeFreeze} from '../../../shared/src/frozen.ts';
import {validateFrozenConfiguration} from '../../../shared/src/frozen-runtime.ts';
import type {FrozenConfiguration} from '../../../shared/src/frozen-runtime.ts';
import {commitment} from '../../../shared/src/commitments.ts';
import type {Frame,Policy} from '../../../shared/src/contracts.ts';
import type {PaperStore} from './types.ts';
const monitoringSchema=z.object({evidenceHash:z.string().regex(/^0x[0-9a-f]{64}$/),
  concerns:z.array(z.object({candidate:z.number().int().min(0).max(24),kind:z.enum(['MARTINGALE','WASH_LIKE','CONCENTRATION','NEAR_LIQUIDATION','OFTEN_FLAT','TOO_FAST','MISSING_EVIDENCE']),severity:z.number().int().min(0).max(100)}).strict()).max(175),
}).strict();
export type MonitoringOutput=z.infer<typeof monitoringSchema>;
export interface PaperReviewInput {session:string;frame:Frame;policy:Policy;addresses:ReadonlyMap<number,string>;rich:unknown;nowMs:number}
export type PaperReviewResult={phase:'REVIEW';receipt:CommitteeReceipt}|{phase:'MONITOR';output:MonitoringOutput};
/** Frozen sessions have a disjoint callback: monitor cannot emit new weights. */
export async function reviewPaperSession(input:PaperReviewInput,store:PaperStore,deps:CommitteeDependencies,monitor:(evidence:CommitteeEvidence,configuration:FrozenConfiguration,signal:AbortSignal)=>Promise<unknown>):Promise<PaperReviewResult>{
  const saved={...input,frame:structuredClone(input.frame),policy:structuredClone(input.policy),addresses:new Map(input.addresses),rich:structuredClone(input.rich)};
  const session=await store.load(saved.session);
  if(session.configuration){
    const configuration=structuredClone(session.configuration);
    if(!Number.isSafeInteger(saved.nowMs)||!Number.isSafeInteger(deps.agentTimeoutMs)||deps.agentTimeoutMs<=0||deps.agentTimeoutMs>60000)throw new Error('invalid monitor clock/deadline');
    const fresh=():void=>{const current=deps.clock();if(!Number.isSafeInteger(current)||current<saved.nowMs||current<saved.frame.asOfMs||current>=saved.frame.expiresAtMs||current-saved.frame.asOfMs>saved.policy.maxFrameAgeMs)throw new Error('stale monitoring evidence');};
    fresh();
    if(saved.frame.asOfMs>saved.nowMs||saved.nowMs>=saved.frame.expiresAtMs||saved.nowMs-saved.frame.asOfMs>saved.policy.maxFrameAgeMs||commitment('perpparrot:policy:v1',saved.policy)!==configuration.policyHash)throw new Error('stale or changed monitoring policy');
    if(saved.addresses.size!==configuration.sources.length||configuration.sources.some(source=>saved.addresses.get(source.candidate)!==source.sourceAddress))throw new Error('monitoring source-set mismatch');
    const evidence=bindCommitteeEvidence(saved.frame,saved.policy,saved.addresses,saved.rich);
    const eventKey=`monitor:${evidence.evidenceHash}`,previous=await store.get(saved.session,eventKey);
    if(previous){
      const output=monitoringSchema.parse(previous.output);
      if(previous.configurationHash!==configuration.configurationHash||output.evidenceHash!==evidence.evidenceHash||output.concerns.some(item=>!configuration.sources.some(source=>source.candidate===item.candidate)))throw new Error('unbound saved monitoring result');
      fresh();return {phase:'MONITOR',output};
    }
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let raw:unknown;
    try{
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('monitor deadline'));},deps.agentTimeoutMs);});
      raw=await Promise.race([Promise.resolve().then(()=>monitor(structuredClone(evidence),structuredClone(configuration),controller.signal)),timeout]);
    }finally{if(timer!==undefined)clearTimeout(timer);controller.abort();}
    fresh();
    const output=monitoringSchema.parse(raw);
    if(new Set(output.concerns.map(item=>`${item.candidate}:${item.kind}`)).size!==output.concerns.length||output.evidenceHash!==evidence.evidenceHash||output.concerns.some(item=>!configuration.sources.some(source=>source.candidate===item.candidate)))throw new Error('unbound monitoring result');
    await store.event(saved.session,eventKey,{mode:'PAPER',economicAuthority:false,configurationHash:configuration.configurationHash,output});
    return {phase:'MONITOR',output};
  }
  const receipt=await runCommitteeReview(saved.frame,saved.policy,saved.addresses,saved.rich,saved.nowMs,deps);
  await store.review(saved.session,receipt);
  return {phase:'REVIEW',receipt};
}
/** Local paper freeze only; this never claims a confirmed chain deployment. The
 * receipt commitment includes rich evidence and audited model provenance. */
export async function freezePaperSession(store:PaperStore,session:string,receiptHash:string,account:string,chainId:number,nowMs:number):Promise<FrozenConfiguration>{
  const saved=await store.load(session);
  if(!saved.review||saved.review.receiptHash!==receiptHash)throw new Error('unknown paper review');
  if(saved.configuration){if(saved.configuration.account!==account||saved.configuration.chainId!==chainId)throw new Error('conflicting paper identity');return saved.configuration;}
  validateCommitteeReceipt(saved.review,nowMs);
  const proposed=proposeFreeze(saved.review.manifest,account,chainId,nowMs);
  const {configurationHash,...payload}={...proposed,reviewHash:receiptHash};
  const configuration={...payload,configurationHash:commitment('perpparrot:frozen:v1',payload)};
  validateFrozenConfiguration(configuration);
  await store.freeze(session,receiptHash,configuration);
  return configuration;
}
