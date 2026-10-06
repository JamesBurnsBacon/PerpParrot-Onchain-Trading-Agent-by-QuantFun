import {buildMirrorPlan} from '../../cre-workflows/mirror/core.ts';
import type {MirrorInput} from '../../cre-workflows/mirror/core.ts';
import {validatePaperReport} from '../../shared/src/paper-report.ts';
import type {Position} from '../../shared/src/mirror-plan.ts';

export interface PaperReceipt {mode:'PAPER';runId:string;reportHash:string;positions:Position[]}
/** In-memory local harness, NOT a durable production executor. Never submits
 * orders. It independently rebuilds evidence and rejects changed replays. */
export class PaperExecutor {
  private readonly receipts=new Map<string,PaperReceipt>();
  execute(report:unknown,input:MirrorInput,nowMs:number):PaperReceipt {
    const rebuilt=buildMirrorPlan({...input,nowMs});
    if(rebuilt.status!=='READY')throw new Error('paper evidence rejected');
    const verified=validatePaperReport(report,input.configuration,nowMs,rebuilt.plan.planHash);
    const key=`${verified.chainId}:${verified.account}:${verified.plan.runId}`;
    const existing=this.receipts.get(key);
    if(existing) {
      if(existing.reportHash!==verified.reportHash)throw new Error('conflicting paper replay');
      return structuredClone(existing);
    }
    const positions=new Map(input.account.positions.map(position=>[position.market,BigInt(position.notionalMicros)]));
    for(const delta of verified.plan.deltas)positions.set(delta.market,(positions.get(delta.market)??0n)+BigInt(delta.notionalMicros));
    const receipt:PaperReceipt={mode:'PAPER',runId:verified.plan.runId,reportHash:verified.reportHash,
      positions:[...positions].filter(([,amount])=>amount!==0n).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([market,amount])=>({market,notionalMicros:amount.toString()}))};
    this.receipts.set(key,structuredClone(receipt));
    return receipt;
  }
}
