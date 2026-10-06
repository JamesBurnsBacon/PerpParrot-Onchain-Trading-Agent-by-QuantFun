import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {Simulator} from './simulator.ts';
import {VERSION,digest,eventSchema,runId} from './contracts.ts';
import {probeModules} from './module-bridge.ts';
import {probeSchema} from './artifact-contracts.ts';
import {codeIdentity,writeJson} from './pipeline.ts';
import {renderDemo} from './render-demo.ts';
const {values}=parseArgs({options:{out:{type:'string',default:'night-shift-integration/out/demo'},'fail-after':{type:'string'}}});
const out=resolve(values.out!);mkdirSync(out,{recursive:true});
// Fixed logical time, fully synthetic data: repeatable on any date, no API credentials.
const event=eventSchema.parse({schemaVersion:VERSION,trigger:'REPLAY',sourceKind:'SYNTHETIC_FIXTURE',
  sourceAsOfMs:1791301200000,bucketMs:1791301200000,
  sourceHash:digest({fixture:'controlled-score-review-services.v2',models:'deterministic-rules'}),codeHash:codeIdentity()});
const runDirectory=join(out,runId(event));mkdirSync(runDirectory,{recursive:true});
const simulator=new Simulator(join(out,'state.sqlite'));
try{
  const proofs:unknown[]=[];
  const receipt=await simulator.run(event,async run=>{
    for(const algorithm of ['return-first.v1','drawdown-first.v1'] as const){
      const stage=algorithm.split('.')[0];
      const value=await run.step(stage,{algorithm,sourceKind:'SYNTHETIC_FIXTURE'},
        async()=>probeModules(join(runDirectory,stage+'-review-db'),algorithm,event.bucketMs),x=>probeSchema.parse(x));
      proofs.push(value);writeJson(join(out,stage+'.json'),value);
    }
  },{failAfter:values['fail-after']});
  const evidence={schemaVersion:'night-demo.v2',recordedAt:new Date().toISOString(),event,receipt,proofs,
    scope:'Offline controlled scenario; real team modules and SQL migrations; deterministic model adapters; exchange dry run; no real orders.'};
  writeJson(join(out,'evidence.json'),evidence);
  writeFileSync(join(out,'demo.html'),renderDemo(evidence));
  console.log(JSON.stringify({status:receipt.status,reused:receipt.steps.filter(x=>x.reused).length,
    proof:join(out,'evidence.json'),demo:join(out,'demo.html'),exchangeOrdersSubmitted:0}));
}finally{simulator.close();}
