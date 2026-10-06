import {postJson} from '../../shared/src/bounded-http.ts';
import type {ReadOnlyRpc} from '../../executor/src/chain-authority.ts';
/** Read-only JSON-RPC allowlist. No eth_sendRawTransaction capability. */
export class EvmReadClient implements ReadOnlyRpc {
  private readonly url:string;private readonly fetcher:typeof fetch;
  constructor(url:string,fetcher:typeof fetch=fetch){const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.hash)throw new Error('invalid chain endpoint');this.url=url;this.fetcher=fetcher;}
  async request(method:string,params:unknown[],signal:AbortSignal):Promise<unknown>{
    if(!['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method))throw new Error('unsupported RPC operation');
    const value=await postJson(this.url,{jsonrpc:'2.0',id:1,method,params},{},signal,this.fetcher) as {jsonrpc?:unknown;id?:unknown;error?:unknown;result?:unknown};
    if(value===null||typeof value!=='object'||value.jsonrpc!=='2.0'||value.id!==1||value.error!==undefined||!Object.hasOwn(value,'result'))throw new Error('chain RPC failed');
    return value.result;
  }
}
