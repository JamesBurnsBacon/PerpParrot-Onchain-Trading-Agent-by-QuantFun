import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {postJson} from '../../shared/src/bounded-http.ts';
import type {Rpc} from '../../executor/src/supabase-store.ts';
const itemSchema=z.object({id:z.string().regex(/^[A-Za-z0-9:_-]{1,140}$/),workflow_id:z.string().regex(/^[A-Za-z0-9:_-]{1,100}$/),slot:z.number().int().nonnegative().safe()});
/** Service worker; leased outbox, acknowledgment only after confirmed delivery.
 * Telegram has no idempotency key: ambiguous delivery can repeat the alert ID. */
export async function deliverOneAlert(rpc:Rpc,token:string,chatId:string,now:()=>number,fetcher:typeof fetch=fetch):Promise<'EMPTY'|'DELIVERED'|'RETRY'> {
 if(!/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)||! /^-?[0-9]{1,20}$/.test(chatId))throw new Error('invalid alert configuration');
 const lease=randomUUID(),signal=AbortSignal.timeout(10000);
 const raw=await rpc.call('claim_alert',{p_token:lease,p_now:now()},signal);if(raw===null)return 'EMPTY';
 const item=itemSchema.parse(raw);
 try {
  const response=await postJson(`https://api.telegram.org/bot${token}/sendMessage`,{chat_id:chatId,text:`PerpParrot ${item.workflow_id}: two consecutive mirror failures. Positions held. Slot ${item.slot}. Alert ${item.id}.`},{},signal,fetcher);
  if(!z.object({ok:z.literal(true)}).safeParse(response).success)return 'RETRY';
  const ack=await rpc.call('ack_alert',{p_id:item.id,p_token:lease,p_now:now()},signal);
  return ack===true?'DELIVERED':'RETRY';
 }catch {return 'RETRY';}
}
