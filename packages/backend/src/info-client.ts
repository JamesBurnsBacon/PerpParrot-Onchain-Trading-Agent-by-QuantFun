import {postJson} from '../../shared/src/bounded-http.ts';
import {parseClearinghouseState} from '../../shared/src/hyperliquid.ts';
import type {AccountState} from '../../shared/src/mirror-state.ts';
export type Fetch=typeof globalThis.fetch;
/** Fixed read-only endpoint, bounded streaming responses, no exchange signer. */
export class HyperliquidInfoClient {
  private readonly fetcher:Fetch;
  constructor(fetcher:Fetch=globalThis.fetch){this.fetcher=fetcher;}
  async account(address:string,nowMs:number,maxAgeMs:number,signal:AbortSignal):Promise<AccountState> {
    if(!/^0x[0-9a-f]{40}$/.test(address))throw new Error('invalid master account');
    const value=await postJson('https://api.hyperliquid.xyz/info',{type:'clearinghouseState',user:address},{},signal,this.fetcher);
    return parseClearinghouseState(value,address,nowMs,maxAgeMs);
  }
}
