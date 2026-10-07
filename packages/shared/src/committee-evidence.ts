import {validate} from './validate.ts';
import {validateEvidence,byteLength} from './review-evidence.ts';
import {commitment,verifyInputCommitments} from './commitments.ts';
import type {Binding,Frame,Policy} from './contracts.ts';
import type {Evidence} from './review-evidence.ts';
/** Evidence sent with each model call. ~1 MB (about 250k tokens) fits the model's context with room
 * for prompts and output; the earlier 105 KB came from Chainlink CRE's HTTP limits (removed). */
export const COMMITTEE_PAYLOAD_BYTES=1_000_000;
export interface CommitteeEvidence {
  schemaVersion:Binding['schemaVersion'];snapshotHash:string;policyHash:string;asOfMs:number;
  finalists:({candidate:number;kind:Frame['candidates'][number]['kind'];metrics:Frame['candidates'][number]['metrics']} & Pick<Evidence['finalists'][number],'equityCurve'|'positions'|'patterns'>)[];
  pairs:Frame['pairs'];evidenceHash:string;
}
/** Server/offline bridge. Models receive anonymous evidence; addresses remain in
 * the independently validated frame commitment and are never prompt content. */
export function bindCommitteeEvidence(frame:Frame,policy:Policy,addresses:ReadonlyMap<number,string>,value:unknown):CommitteeEvidence {
  validate('candidate-curation-frame',frame);validate('bucket-policy',policy);
  const evidence=validateEvidence(value);
  const ids=frame.candidates.map(c=>c.candidate);
  if(new Set(ids).size!==ids.length||addresses.size!==ids.length||new Set(addresses.values()).size!==ids.length||ids.some(id=>!/^0x[0-9a-f]{40}$/.test(addresses.get(id)??'')))throw new Error('invalid committee mapping');
  if(!verifyInputCommitments(frame,policy,addresses)||evidence.asOfMs!==frame.asOfMs||evidence.finalists.length!==frame.candidates.length)throw new Error('committee evidence binding mismatch');
  const finalists=evidence.finalists.map(finalist=>{
    const candidate=frame.candidates.find(candidate=>candidate.candidate===finalist.candidate);
    if(!candidate||candidate.kind!==finalist.kind)throw new Error('committee identity mismatch');
    const metricPairs=[['historyDays','historyDays'],['timeInMarket','timeInMarket'],['medianHoldMinutes','medianHoldMinutes'],['makerShare','makerShare'],['maxDrawdown','maxDrawdown']] as const;
    for(const [field,metric] of metricPairs)if(finalist[field]!==candidate.metrics[metric])throw new Error('contradictory finalist metrics');
    const result={candidate:finalist.candidate,kind:finalist.kind,metrics:structuredClone(candidate.metrics),equityCurve:finalist.equityCurve,positions:finalist.positions,patterns:finalist.patterns};
    if(byteLength(result)>4096)throw new Error('combined finalist exceeds 4 KB');
    return result;
  });
  if(frame.pairs.length!==evidence.pairs.length||new Set(frame.pairs.map(p=>`${Math.min(p.a,p.b)}:${Math.max(p.a,p.b)}`)).size!==frame.pairs.length)throw new Error('incomplete committee matrix');
  for(const pair of evidence.pairs){const original=frame.pairs.find(p=>p.a===pair.a&&p.b===pair.b||p.a===pair.b&&p.b===pair.a);if(!original||original.correlation!==pair.correlation||original.linkedSource!==pair.linkedSource)throw new Error('contradictory committee matrix');}
  const payload={schemaVersion:frame.schemaVersion,snapshotHash:frame.snapshotHash,policyHash:frame.policyHash,asOfMs:frame.asOfMs,finalists,pairs:structuredClone(frame.pairs).sort((a,b)=>a.a-b.a||a.b-b.b)};
  if(byteLength(payload)>COMMITTEE_PAYLOAD_BYTES)throw new Error('committee payload exceeds reserved request budget');
  return {...payload,evidenceHash:commitment('perpparrot:committee-evidence:v1',payload)};
}
