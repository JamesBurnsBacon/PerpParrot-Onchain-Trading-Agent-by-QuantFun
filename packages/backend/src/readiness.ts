/** Deployment checklist only; caller must verify artifacts. Never trading authorization. */
export interface GateEvidence {gate:string;artifact:string;verifiedAtMs:number;commit:string;environment:'LOCAL'|'DEPLOYED'}
const REQUIRED=['review-two-model-evaluation','review-live-llm-consensus','review-audit-persistence','freeze-deployed-identity','mirror-deployed-consensus','exchange-account-policy','executor-report-authentication','executor-durable-recovery','alerts-delivery','pause-flatten-drill','funded-canary'] as const;
export function readiness(evidence:GateEvidence[],commit:string,nowMs:number){
 if(!/^[0-9a-f]{40}$/.test(commit)||!Number.isSafeInteger(nowMs)||nowMs<0||new Set(evidence.map(item=>item.gate)).size!==evidence.length)throw new Error('invalid readiness evidence');
 for(const item of evidence)if(!REQUIRED.includes(item.gate as typeof REQUIRED[number])||!item.artifact||item.commit!==commit||!Number.isSafeInteger(item.verifiedAtMs)||item.verifiedAtMs>nowMs||!['LOCAL','DEPLOYED'].includes(item.environment))throw new Error('unbound readiness evidence');
 const missing=REQUIRED.filter(gate=>!evidence.some(item=>item.gate===gate&&item.environment==='DEPLOYED'));
 return {ready:missing.length===0,missing};
}
