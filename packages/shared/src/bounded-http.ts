/** Server-side transport only (bounded size and time); never used from the browser. Model calls
 * pass their agent timeout (long outputs take well over 10 s). */
export async function postJson(url:string,body:unknown,headers:Record<string,string>,signal:AbortSignal,fetcher:typeof fetch=fetch,timeoutMs=10000):Promise<unknown> {
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]);
  const response=await fetcher(url,{method:'POST',redirect:'error',signal:bounded,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  if(!response.ok||!response.body)throw new Error('upstream request failed');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let length=0;
  try {while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>1_000_000)throw new Error('upstream response exceeds budget');chunks.push(part.value);}}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new Error('invalid upstream JSON');}
}
