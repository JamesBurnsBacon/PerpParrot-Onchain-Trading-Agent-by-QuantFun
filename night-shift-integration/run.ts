import { parseArgs } from 'node:util';
import { runPipeline } from './pipeline.ts';
const {values}=parseArgs({args:process.argv.slice(2),options:{data:{type:'string'},out:{type:'string'},btc:{type:'string'},ticks:{type:'string',default:'2'},'fail-after':{type:'string'}}});
const ticks=Number(values.ticks);
if(!Number.isInteger(ticks)||ticks<1||ticks>2)throw new Error('--ticks must be 1 or 2; a fixed archive expires before a third bucket');
if(values['fail-after']&&!['ingest','evaluate','dashboard','return-first','drawdown-first'].includes(values['fail-after']))throw new Error('unknown --fail-after stage');
await runPipeline({dataDir:values.data,out:values.out,btc:values.btc,ticks,failAfter:values['fail-after']});
