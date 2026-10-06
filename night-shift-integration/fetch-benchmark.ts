// One public read, then reusable offline data. Does not load credentials or .env.
import {parseArgs} from 'node:util';
import {existsSync,mkdirSync,readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {DEFAULT_DATA,writeJson} from './pipeline.ts';
import {digest} from './contracts.ts';
const {values}=parseArgs({args:process.argv.slice(2),options:{data:{type:'string'},out:{type:'string'}}});
const manifest=JSON.parse(readFileSync(resolve(values.data??DEFAULT_DATA,'manifest.json'),'utf8'));
const day=86_400_000,end=Math.floor(Date.parse(manifest.exportedAt)/day)*day;
if(!Number.isSafeInteger(end))throw new Error('INVALID_ARCHIVE_DATE');
const request={type:'candleSnapshot',req:{coin:'BTC',interval:'1d',startTime:end-100*day,endTime:end}};
const out=resolve(values.out??resolve(import.meta.dir,'out/btc-candles.json'));
mkdirSync(dirname(out),{recursive:true});
if(existsSync(out)&&digest(JSON.parse(readFileSync(out,'utf8')).request)===digest(request)){
  console.log('BTC_CACHE_REUSED');
}else{
  const response=await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(request),signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw new Error(`BTC_HTTP_${response.status}`);
  const data=await response.json();
  if(!Array.isArray(data)||data.length<90||data.length>105)throw new Error('BTC_CANDLE_COVERAGE');
  writeJson(out,{request,observedAt:new Date().toISOString(),data});
  console.log(`BTC_CANDLES_SAVED ${data.length}`);
}
