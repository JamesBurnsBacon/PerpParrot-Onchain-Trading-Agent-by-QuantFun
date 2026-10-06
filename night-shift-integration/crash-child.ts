// Invoked only by the recovery test: die after a durable checkpoint, before lock cleanup.
import {Simulator} from './simulator.ts';
import {VERSION,type Event} from './contracts.ts';
const event:Event={schemaVersion:VERSION,trigger:'REPLAY',bucketMs:1_800_000,sourceAsOfMs:1_800_000,
  sourceHash:'a'.repeat(64),codeHash:'b'.repeat(64),sourceKind:'SYNTHETIC_FIXTURE'};
const runtime=new Simulator(process.argv[2]);
await runtime.run(event,async run=>{
  await run.step('first',{},async()=>({value:42}),x=>x as {value:number});
  process.kill(process.pid,'SIGKILL');
});
