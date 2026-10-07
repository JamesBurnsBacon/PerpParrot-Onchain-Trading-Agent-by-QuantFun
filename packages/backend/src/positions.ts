export type LivePosition={market:string;signedNotionalUsd:number;leverage:number|null;liquidationDistance:number|null};
const round=(value:number,digits:number)=>{const scale=10**digits;return Math.round(value*scale)/scale;};
/** Hyperliquid clearinghouseState positions (one state per dex) as evidence rows, largest first. */
export function positionsFromStates(states:{assetPositions:{position:{coin:string;szi:string;positionValue:string;leverage?:{value:number}|null;liquidationPx?:string|null}}[]}[]):LivePosition[] {
  const rows=states.flatMap(state=>state.assetPositions.map(({position})=>{
    const size=Number(position.szi),value=Number(position.positionValue);
    if(!Number.isFinite(size)||!Number.isFinite(value)||size===0)throw new Error(`invalid position ${position.coin}`);
    const mark=value/Math.abs(size),liquidation=position.liquidationPx==null?null:Number(position.liquidationPx);
    const distance=liquidation===null||!Number.isFinite(liquidation)||!(mark>0)?null:Math.min(1,Math.abs(mark-liquidation)/mark);
    return {market:position.coin,signedNotionalUsd:round(Math.sign(size)*value,2),leverage:position.leverage?.value??null,liquidationDistance:distance===null?null:round(distance,4)};
  }));
  return rows.sort((a,b)=>Math.abs(b.signedNotionalUsd)-Math.abs(a.signedNotionalUsd)||(a.market<b.market?-1:1));
}
