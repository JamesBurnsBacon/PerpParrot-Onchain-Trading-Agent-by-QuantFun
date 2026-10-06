import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from '../tests/support/review-fixture.ts';
import type {FrozenConfiguration} from '../packages/shared/frozen.ts';
import type {Source,Policy,Frame} from '../packages/shared/src/contracts.ts';
import {buildMeasuredAssessment,runMeasuredService,type MeasuredContextInput} from './measured-service.ts';
const NOW=1_791_301_200_000;
function data(){
 const f=fixture(),configuration=f.configuration as unknown as FrozenConfiguration;
 const assets=['BTC','ETH','SOL','AVAX','HYPE'];
 const input:MeasuredContextInput={sourceKind:'SYNTHETIC_FIXTURE',asOfMs:NOW,marketResponses:{startedAtMs:NOW-4000,completedAtMs:NOW-3000,
  perpDexs:[null,{name:'xyz'}],core:[{collateralToken:0,universe:assets.map(name=>({name,szDecimals:5,maxLeverage:10}))},assets.map(()=>({markPx:'100',openInterest:'1000000',funding:'0.00001'}))],xyz:[{collateralToken:0,universe:[]},[]]},
  sourceReads:configuration.sources.map((s,i)=>({address:s.sourceAddress,startedAtMs:NOW-2000,completedAtMs:NOW-1000,
   portfolio:[['day',{accountValueHistory:[[NOW-1000,'100000']]}]],
   states:[{assetPositions:[{position:{coin:assets[i],szi:'1000',positionValue:'100000'}}]},{assetPositions:[]}]}))};
 const sources:Source[]=configuration.sources.map(s=>({candidate:s.candidate,sourceAddress:s.sourceAddress,weight:s.weightUnits/1e6,maxAllocation:s.ceilingUnits/1e6}));
 return {input,configuration,sources,policy:configuration.policy as unknown as Policy};
}
test('measured assessor preserves observed data, rejects unknown source and tests current executable coverage',async()=>{
 const {input,sources,policy}=data(),before=JSON.stringify(input),ctx=await buildMeasuredAssessment(input);
 const measured=ctx.measureSourceExecution(input.sourceReads[0],policy);
 expect(measured.executionCoverage).toBe(1);expect(measured.executionFit).toBeGreaterThan(90);
 expect(measured.scope).toBe('CURRENT_POSITION_PLANNER');expect(measured.plannedTargets).toBe(1);
 expect(ctx.assess(sources,{} as Frame,policy).withinPolicy).toBe(true);
 expect(ctx.assess([{...sources[0],sourceAddress:'0x'+'f'.repeat(40)}],{} as Frame,policy).withinPolicy).toBe(false);
 input.sourceReads[0].states[0]={assetPositions:[]};
 expect(()=>ctx.measureSourceExecution(input.sourceReads[0],policy)).toThrow('differs');
 expect(ctx.assess(sources,{} as Frame,policy).withinPolicy).toBe(true);
 expect(JSON.parse(before).sourceReads[0].states[0].assetPositions).toHaveLength(1);
});
test('measurement validation rejects missing dex, stale/future reads, stale equity and missing market data',async()=>{
 for(const change of [
  (x:MeasuredContextInput)=>{x.sourceReads[0].states.pop();},
  (x:MeasuredContextInput)=>{x.sourceReads[0].startedAtMs=NOW-120001;},
  (x:MeasuredContextInput)=>{x.marketResponses.completedAtMs=NOW+1;},
  (x:MeasuredContextInput)=>{(x.sourceReads[0].portfolio as any)[0][1].accountValueHistory[0][0]=NOW-120001;},
  (x:MeasuredContextInput)=>{x.marketResponses.core=[{collateralToken:0,universe:[]},[]];},
 ]){const {input}=data();change(input);await expect(buildMeasuredAssessment(input)).rejects.toThrow();}
});
test('full HTTP/SQL measured-cache route keeps fixture provenance explicit and resumes without extra orders',async()=>{
 const {input,configuration}=data(),outPath=mkdtempSync(join(tmpdir(),'measured-service-'));
 try{
  const result=await runMeasuredService({...input,outPath,configuration});
  expect(result.sourceKind).toBe('SYNTHETIC_FIXTURE');expect(result.dataKind).toBe('synthetic-fixture-responses');
  expect(result.liveOrdersSubmitted).toBe(0);expect(result.sourceCount).toBe(5);
  expect(result.plan.orders.length).toBe(5);expect(Object.values(result.checks).every(Boolean)).toBe(true);
  expect(result.sourceReadHashes.every(r=>r.completedAtMs===NOW-1000)).toBe(true);
  await expect(runMeasuredService({...input,outPath,configuration,sourceReads:input.sourceReads.slice(1)})).rejects.toThrow('not every frozen');
 }finally{rmSync(outPath,{recursive:true,force:true});}
},60_000);
test('current-position execution fit penalizes uncovered, too-small and margin-scaled legs',async()=>{
 const partial=data();(partial.input.sourceReads[0].states[0] as any).assetPositions.push({position:{coin:'UNLISTED',szi:'1000',positionValue:'100000'}});
 let context=await buildMeasuredAssessment(partial.input),row=context.measureSourceExecution(partial.input.sourceReads[0],partial.policy);
 expect(row.executionCoverage).toBeCloseTo(0.5);expect(row.executionFit).toBeLessThanOrEqual(50);expect(row.executionFit).toBeGreaterThan(0);
 const small=data();(small.input.sourceReads[0].states[0] as any).assetPositions[0].position.positionValue='1';
 context=await buildMeasuredAssessment(small.input);row=context.measureSourceExecution(small.input.sourceReads[0],small.policy);
 expect(row.executionFit).toBe(0);expect(row.plannedTargets).toBe(0);
 const leveraged=data();(leveraged.input.sourceReads[0].states[0] as any).assetPositions[0].position.positionValue='100000000';
 context=await buildMeasuredAssessment(leveraged.input);row=context.measureSourceExecution(leveraged.input.sourceReads[0],leveraged.policy);
 expect(row.marginScale).toBeLessThan(1);expect(row.executionFit).toBe(0);
});
test('full assessment measures netted targets while retaining worst-case gross and concentration bounds',async()=>{
 const netted=data();for(const [i,r] of netted.input.sourceReads.entries())r.states[0]={assetPositions:[{position:{coin:'BTC',szi:i<3?'1000':'-1000',positionValue:'100000'}}]};
 const context=await buildMeasuredAssessment(netted.input),assessment=context.assess(netted.sources,{} as Frame,netted.policy);
 expect(assessment.executableTargets).toBe(1);expect(assessment.grossLeverage).toBeCloseTo(netted.sources.reduce((n,s)=>n+s.weight,0));
 const flat=data();flat.input.sourceReads[0].states[0]={assetPositions:[]};
 const flatContext=await buildMeasuredAssessment(flat.input);
 expect(flatContext.measureSourceExecution(flat.input.sourceReads[0],flat.policy).executionCoverage).toBe(0);
 expect(flatContext.assess(flat.sources.map(s=>({...s,maxAllocation:s.weight})),{} as Frame,flat.policy).withinPolicy).toBe(false);
});

test('all-dex measurement includes unmirrored notional in the execution denominator',async()=>{
 const {input,policy}=data(),read=input.sourceReads[0];
 read.allStates=[...['','xyz'].map((dex,i)=>({dex,state:read.states[i],startedAtMs:read.startedAtMs,completedAtMs:read.completedAtMs})),
  {dex:'flx',state:{assetPositions:[{position:{coin:'flx:TSLA',szi:'1000',positionValue:'100000'}}]},startedAtMs:read.startedAtMs,completedAtMs:read.completedAtMs}];
 read.stateCoverage={declaredDexes:['','xyz','flx'],requestedDexes:['','xyz','flx'],complete:true};
 const context=await buildMeasuredAssessment(input),row=context.measureSourceExecution(read,policy);
 expect(row.executionCoverage).toBe(0.5);expect(row.executionFit).toBeLessThanOrEqual(50);
 expect(row.coverageScope).toBe('ALL_OBSERVED_DEXES');expect(row.observedGrossNotionalUsd).toBe(200000);
 read.stateCoverage.declaredDexes.push('vntl');read.stateCoverage.complete=false;
 expect((await buildMeasuredAssessment(input)).measureSourceExecution(read,policy).executionFit).toBe(0);
});
