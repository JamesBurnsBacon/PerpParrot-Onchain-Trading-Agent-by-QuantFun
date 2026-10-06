/** Exact bounded decimal arithmetic. Exchange values never pass through Number. */
export interface Decimal {n:bigint; d:bigint}
export function decimal(value:string):Decimal {
  if(typeof value!=='string'||! /^-?(0|[1-9][0-9]{0,23})(\.[0-9]{1,18})?$/.test(value))throw new Error('invalid decimal');
  const negative=value.startsWith('-'),text=negative?value.slice(1):value;
  const [whole,fraction='']=text.split('.');
  return {n:BigInt(whole+fraction)*(negative?-1n:1n),d:10n**BigInt(fraction.length)};
}
export function abs(n:bigint):bigint{return n<0n?-n:n;}
export function ceilDiv(n:bigint,d:bigint):bigint {if(n<0n||d<=0n)throw new Error('invalid unsigned division');return (n+d-1n)/d;}
export function units(value:string,places:number):bigint {
  if(!Number.isInteger(places)||places<0||places>18)throw new Error('invalid decimal scale');
  const {n,d}=decimal(value),scaled=n*10n**BigInt(places);
  if(scaled%d!==0n)throw new Error('decimal exceeds precision');
  return scaled/d;
}
export function formatUnits(n:bigint,places:number):string {
  if(!Number.isInteger(places)||places<0||places>18)throw new Error('invalid decimal scale');
  const digits=abs(n).toString().padStart(places+1,'0');
  const text=places===0?digits:digits.slice(0,-places)+'.'+digits.slice(-places);
  return (n<0n?'-':'')+text.replace(/(\.[0-9]*?)0+$/,'$1').replace(/\.$/,'');
}
/** Positive perp price rounded toward the allowed slippage interval: down for
 * buys, up for sells; five significant digits and 6-szDecimals maximum decimals.
 * Integer prices remain valid even when their significant-digit count exceeds 5. */
export function perpLimit(mark:string,szDecimals:number,bps:number,buy:boolean):string {
  if(!Number.isInteger(szDecimals)||szDecimals<0||szDecimals>6||!Number.isInteger(bps)||bps<0||bps>1000)throw new Error('invalid price policy');
  const p=decimal(mark);if(p.n<=0n)throw new Error('nonpositive mark');
  const n=p.n*BigInt(buy?10000+bps:10000-bps),d=p.d*10000n;
  let exponent=0;
  if(n>=d) {let whole=n/d;while(whole>=10n){whole/=10n;exponent++;}}
  else {let scaled=n;while(scaled<d){scaled*=10n;exponent--;}}
  const places=Math.min(6-szDecimals,Math.max(0,4-exponent));
  const scale=10n**BigInt(places);
  const rounded=buy?n*scale/d:ceilDiv(n*scale,d);
  if(rounded===0n)throw new Error('price rounds to zero');
  // Rounding must not produce a price outside the permitted side of mark.
  if(buy?rounded*p.d<p.n*scale:rounded*p.d>p.n*scale)throw new Error('no executable tick inside slippage bound');
  return formatUnits(rounded,places);
}
