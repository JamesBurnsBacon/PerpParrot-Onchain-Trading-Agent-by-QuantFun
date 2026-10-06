import {z} from 'zod';
import type {PreviewStore,RunKey,PreviewClaim} from './recovery.ts';
export interface Rpc {call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>}
const claimSchema=z.object({claimed:z.boolean(),state:z.enum(['PREPARED','UNKNOWN','TERMINAL']),nonce:z.number().int().nonnegative().safe(),receipt:z.unknown()});
export class SupabasePreviewStore implements PreviewStore {
  private readonly rpc:Rpc;
  constructor(rpc:Rpc){this.rpc=rpc;}
  private args(key:RunKey){return {p_chain:key.chain,p_account:key.account,p_run:key.run,p_hash:key.hash};}
  private async call(name:string,args:Record<string,unknown>){return this.rpc.call(name,args,AbortSignal.timeout(5000));}
  async claim(key:RunKey,signer:string,nowMs:number):Promise<PreviewClaim>{const value=claimSchema.parse(await this.call('claim_preview',{...this.args(key),p_signer:signer,p_now:nowMs}));return {...value,receipt:value.receipt};}
  async unknown(key:RunKey):Promise<void>{await this.call('mark_preview_unknown',this.args(key));}
  async finish(key:RunKey,receipt:unknown):Promise<void>{await this.call('finish_preview',{...this.args(key),p_receipt:receipt});}
}
