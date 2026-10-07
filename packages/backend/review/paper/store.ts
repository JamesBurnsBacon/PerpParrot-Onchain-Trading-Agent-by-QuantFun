// @env node
import {z} from '../../../shared/src/zod.ts';
import type {Rpc} from '../supabase.ts';
import type {CommitteeReceipt} from '../committee/types.ts';
import {validateCommitteeReceipt} from '../committee/workflow.ts';
import {validateFrozenConfiguration} from '../../../shared/src/frozen-runtime.ts';
import type {FrozenConfiguration} from '../../../shared/src/frozen-runtime.ts';
import type {PaperStore,PaperSession,PaperEvent} from './types.ts';
const sessionSchema=z.object({id:z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/),review:z.unknown().refine(value=>value!==undefined),configuration:z.unknown().refine(value=>value!==undefined),paused:z.boolean()}).strict();
export class SupabasePaperStore implements PaperStore {
  private readonly rpc:Rpc;
  constructor(rpc:Rpc){this.rpc=rpc;}
  private call(name:string,args:Record<string,unknown>):Promise<unknown>{return this.rpc.call(name,args,AbortSignal.timeout(5000));}
  async load(session:string):Promise<PaperSession>{
    const item=sessionSchema.parse(await this.call('load_paper_session',{p_session:session}));
    if(item.id!==session)throw new Error('paper session mismatch');
    const review=item.review as CommitteeReceipt|null,configuration=item.configuration as FrozenConfiguration|null;
    if(review)validateCommitteeReceipt(review,review.manifest.createdAtMs);
    if(configuration){validateFrozenConfiguration(configuration);if(!review||configuration.reviewHash!==review.receiptHash)throw new Error('unbound paper configuration');}
    return {id:item.id,review,configuration,paused:item.paused};
  }
  async pause(session:string,configurationHash:string,paused:boolean):Promise<void>{await this.call('set_paper_pause',{p_session:session,p_configuration_hash:configurationHash,p_paused:paused});}
  async review(session:string,receipt:CommitteeReceipt):Promise<void>{await this.call('save_paper_review',{p_session:session,p_receipt:receipt});}
  async freeze(session:string,receiptHash:string,configuration:FrozenConfiguration):Promise<void>{await this.call('freeze_paper_session',{p_session:session,p_receipt_hash:receiptHash,p_configuration:configuration});}
  async event(session:string,key:string,payload:PaperEvent):Promise<void>{await this.call('record_paper_event',{p_session:session,p_key:key,p_payload:payload});}
  async get(session:string,key:string):Promise<PaperEvent|null>{const value=await this.call('get_paper_event',{p_session:session,p_key:key});if(value===null)return null;return z.object({mode:z.literal('PAPER'),economicAuthority:z.literal(false)}).passthrough().parse(value);}
}
