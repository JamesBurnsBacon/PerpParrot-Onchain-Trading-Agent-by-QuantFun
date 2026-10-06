import {postJson} from '../../shared/src/bounded-http.ts';
/** Server-only service credential; never expose this client to browsers or CRE. */
export class SupabaseRpc {
  private readonly base:string;
  private readonly serviceKey:string;
  private readonly fetcher:typeof fetch;
  constructor(url:string,serviceKey:string,fetcher:typeof fetch=fetch){
    this.serviceKey=serviceKey;this.fetcher=fetcher;
    const parsed=new URL(url);
    if(parsed.protocol!=='https:'||! /^[a-z0-9-]+\.supabase\.co$/.test(parsed.hostname)||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.pathname!=='/'||!serviceKey||serviceKey.length>4096||/[\r\n]/.test(serviceKey))throw new Error('invalid database configuration');
    this.base=parsed.origin;
  }
  async call(name:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
    if(!['claim_preview','finish_preview','mark_preview_unknown','record_mirror_health','claim_alert','ack_alert','persist_review_audit'].includes(name))throw new Error('unknown database operation');
    return postJson(`${this.base}/rest/v1/rpc/${name}`,args,{apikey:this.serviceKey,Authorization:`Bearer ${this.serviceKey}`},signal,this.fetcher);
  }
}
