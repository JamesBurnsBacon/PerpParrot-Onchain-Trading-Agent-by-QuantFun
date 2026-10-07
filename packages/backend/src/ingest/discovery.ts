import { z } from 'zod';
import {addressSchema,decimalSchema,compareUsd,type Candidate} from './types';
const row=z.object({ethAddress:addressSchema,accountValue:decimalSchema,displayName:z.string().nullable().optional(),
  windowPerformances:z.array(z.tuple([z.string(),z.object({pnl:decimalSchema})]))});
const vault=z.object({pnls:z.array(z.tuple([z.string(),z.array(decimalSchema)])),summary:z.object({vaultAddress:addressSchema,
  tvl:decimalSchema,name:z.string(),leader:addressSchema,isClosed:z.boolean(),relationship:z.object({type:z.string()}).nullable().optional()})});

export function discover(leaderboard:unknown,vaultList:unknown){
  const traders=z.object({leaderboardRows:z.array(row)}).parse(leaderboard).leaderboardRows;
  const vaults=z.array(vault).parse(vaultList),vaultAddresses=new Set(vaults.map(v=>v.summary.vaultAddress));
  if(vaultAddresses.size!==vaults.length||new Set(traders.map(t=>t.ethAddress)).size!==traders.length)throw new Error('Duplicate discovery address');
  const candidates:Candidate[]=[];
  for(const t of traders){
    const windows=new Map(t.windowPerformances);
    if(vaultAddresses.has(t.ethAddress)||compareUsd(t.accountValue,'10000')<0
      ||!['month','allTime'].every(w=>windows.has(w)&&compareUsd(windows.get(w)!.pnl,'0')>0))continue;
    candidates.push({address:t.ethAddress,accountValueOrTvlUsd:t.accountValue,valueSource:'leaderboard-account-value',
      sources:['leaderboard'],name:t.displayName??null,knownHypercoreVault:false,leaderAddress:null});
  }
  for(const {summary:s,pnls} of vaults){
    const windows=new Map(pnls);
    if(s.isClosed||s.relationship?.type==='child'||compareUsd(s.tvl,'10000')<0
      ||!['month','allTime'].every(w=>{const p=windows.get(w);return p&&p.length>=2&&compareUsd(p.at(-1)!,p[0])>0;}))continue;
    candidates.push({address:s.vaultAddress,accountValueOrTvlUsd:s.tvl,valueSource:'hypercore-vault-tvl',sources:['hypercore-vault-list'],
      name:s.name,knownHypercoreVault:true,leaderAddress:s.leader});
  }
  if(!candidates.length)throw new Error('Empty discovery result; previous registry retained');
  return {candidates:candidates.sort((a,b)=>a.address.localeCompare(b.address)),leaderboardRows:traders.length,vaultRows:vaults.length};
}
