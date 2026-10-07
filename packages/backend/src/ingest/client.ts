export const SOURCES = {
  leaderboard: 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard',
  vaults: 'https://stats-data.hyperliquid.xyz/Mainnet/vaults',
  info: 'https://api.hyperliquid.xyz/info',
  hyperevm: 'https://rpc.hyperliquid.xyz/evm',
} as const;
export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}
export type ReadClient = { rpc(method: 'eth_blockNumber' | 'eth_chainId' | 'eth_getCode' | 'eth_call', params: unknown[]): Promise<`0x${string}`> };
export type Budget = {
  reserve(scope: 'info' | 'rpc', weight: number): Promise<{id?: string; waitMs: number}>;
  cooldown?(scope:'info'|'rpc',ms:number):Promise<void>;
  refund(id: string, actual: number): Promise<void>;
};
export type Transport = (url:string,init?:RequestInit)=>Promise<Response>;

export class BudgetClient implements ReadClient {
  requests=0; retries=0; rateLimited=0; infoWeight=0; rpcRequests=0;
  constructor(private budget: Budget, readonly signal: AbortSignal, private fetcher: Transport=fetch,
    private sleep: (ms:number)=>Promise<void>=Bun.sleep) {}
  async wait(ms:number) {
    for(let left=ms;left>0;left-=250){this.signal.throwIfAborted();await this.sleep(Math.min(250,left));}
    this.signal.throwIfAborted();
  }
  async request(url:string, body?:object, weight=20, cost?: (value:unknown)=>number):Promise<unknown> {
    if(!Object.values(SOURCES).includes(url as typeof SOURCES.info))throw new Error('Unsupported data endpoint');
    const scope=url===SOURCES.hyperevm?'rpc':'info';
    for(let attempt=0;attempt<3;attempt++){
      this.signal.throwIfAborted();
      let reservation;
      do { reservation=await this.budget.reserve(scope,weight); if(reservation.waitMs)await this.wait(reservation.waitMs); }
      while(!reservation.id);
      this.signal.throwIfAborted();this.requests++;
      if(scope==='info')this.infoWeight+=weight;else this.rpcRequests++;
      let res:Response;
      try {res=await this.fetcher(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',
        'User-Agent':'PerpParrot-ingest/1.0'},body:body?JSON.stringify(body):undefined,redirect:'error',
        signal:AbortSignal.any([this.signal,AbortSignal.timeout(body?25_000:150_000)])});}
      catch {this.signal.throwIfAborted();if(attempt===2)throw new Error('Source network/timeout failure');this.retries++;await this.wait(1000*2**attempt);continue;}
      if(!res.ok){
        await res.body?.cancel();
        const header=res.headers.get('retry-after'),seconds=header===null?NaN:Number(header);
        const parsed=Number.isFinite(seconds)?seconds*1000:header?Date.parse(header)-Date.now():NaN;
        const delay=Number.isFinite(parsed)?Math.max(0,parsed):1000*2**attempt;
        if(res.status===429){this.rateLimited++;await this.budget.cooldown?.(scope,delay);}
        if((res.status===429||res.status>=500)&&attempt<2){
          this.retries++;await this.wait(delay);continue;
        }
        throw new Error(`Source HTTP ${res.status}`);
      }
      const reader=res.body?.getReader();if(!reader)throw new Error('Missing source response');
      const chunks:Uint8Array[]=[];let size=0;
      try {for(;;){this.signal.throwIfAborted();const {done,value}=await reader.read();if(done)break;
        size+=value.length;if(size>96*1024*1024)throw new Error('Source response too large');chunks.push(value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      const value:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(cost){const actual=cost(value);if(!Number.isSafeInteger(actual)||actual<1||actual>weight)throw new Error('Invalid response weight');
        await this.budget.refund(reservation.id,actual);if(scope==='info')this.infoWeight-=weight-actual;}
      return value;
    }
    throw new Error('Source retries exhausted');
  }
  async rpc(method:'eth_blockNumber'|'eth_chainId'|'eth_getCode'|'eth_call',params:unknown[]):Promise<`0x${string}`>{
    const d=await this.request(SOURCES.hyperevm,{jsonrpc:'2.0',id:1,method,params},1) as {result?:unknown;error?:{code:number;message:string}};
    if(d.error)throw new RpcError(d.error.code,d.error.message);
    if(typeof d.result!=='string'||!/^0x[0-9a-fA-F]*$/.test(d.result))throw new Error('Invalid RPC result');
    return d.result as `0x${string}`;
  }
}
