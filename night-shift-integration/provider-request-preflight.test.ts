import {test,expect} from 'bun:test';
import {paperFixture} from '../tests/support/paper-lifecycle-fixture.ts';
import {snapshotCommitment} from '../packages/shared/src/commitments.ts';
import {compactProviderEvidence,preflightProviderRequests} from './provider-request-preflight.ts';

test('25-finalist real request encoder fits fixed budgets by thinning presentation without changing policy or metrics',async()=>{
 const f=paperFixture({async call(){return null;}}),now=1_791_300_000_000;
 const frame=structuredClone(f.input.frame);frame.asOfMs=now;frame.expiresAtMs=now+60_000;
 frame.candidates=Array.from({length:25},(_,candidate)=>({...structuredClone(frame.candidates[0]),candidate}));
 frame.pairs=Array.from({length:25},(_,a)=>Array.from({length:24-a},(_,j)=>({a,b:a+j+1,correlation:0.1234567890123456,currentExposureOverlap:0.2345678901234567,linkedSource:false}))).flat();
 const addresses=new Map(frame.candidates.map(c=>[c.candidate,'0x'+String(c.candidate+1).padStart(40,'0')]));
 frame.snapshotHash=snapshotCommitment(frame,addresses);
 const evidence={asOfMs:now,finalists:frame.candidates.map(c=>({...structuredClone(f.input.rich.finalists[0]),candidate:c.candidate,
  equityCurve:Array.from({length:40},(_,i)=>({atMs:now-(39-i)*60_000,pnlUsd:123456789.12345678+i*11.111111})),
  positions:Array.from({length:8},(_,i)=>({market:'xyz:ASSET-'+i,signedNotionalUsd:123456789.12345678/(i+1),leverage:5,liquidationDistance:0.1234567890123456}))})),
  pairs:frame.pairs.map(({currentExposureOverlap,...p})=>p)};
 const bundle={frame,policy:f.input.policy,addresses:[...addresses],evidence},before=JSON.stringify(bundle);
 await expect(preflightProviderRequests(bundle)).rejects.toThrow();
 const result=await compactProviderEvidence(bundle);
 expect(JSON.stringify(bundle)).toBe(before);expect(result.preflight.externalProviderCalls).toBe(0);
 expect(result.preflight.requests).toHaveLength(6);expect(result.preflight.requests.every(r=>r.bytes<=115000&&r.modelInputAnonymous)).toBe(true);
 expect(result.evidence.finalists).toHaveLength(25);expect(result.presentation.after.curvePoints).toBeLessThan(result.presentation.before.curvePoints);
 for(const [i,row] of result.evidence.finalists.entries()){
  expect(row.equityCurve.length).toBeGreaterThanOrEqual(26);expect(row.equityCurve[0]).toEqual(evidence.finalists[i].equityCurve[0]);
  expect(row.equityCurve.at(-1)).toEqual(evidence.finalists[i].equityCurve.at(-1));
  expect(result.committee.finalists[i].metrics).toEqual(frame.candidates[i].metrics);
 }
 const again=await compactProviderEvidence(bundle);expect(again).toEqual(result);
},30_000);
