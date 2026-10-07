// Local A/B cohort builder. No API calls and no change to the production pick.
// Input snapshots and address-bearing selections stay under gitignored work/.
import {parseArgs} from 'node:util';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,relative,sep} from 'node:path';
import {isHighFrequency} from '../../packages/backend/src/pipeline/derive.ts';
import {scoreCandidates,type ScoreInput} from '../../packages/backend/src/score/index.ts';

const {values}=parseArgs({options:{inputs:{type:'string'},output:{type:'string'}}});
if(!values.inputs||!values.output)throw new Error('usage: bun scripts/research/recent-performance-control.ts --inputs <private ScoreInput JSON> --output <work/subdir>');
const work=resolve('work'),output=resolve(values.output),rel=relative(work,output);
if(rel===''||rel==='..'||rel.startsWith(`..${sep}`)||rel.startsWith(sep))throw new Error('output must be a subdirectory of gitignored work/');
const rows=JSON.parse(await readFile(values.inputs,'utf8')) as (ScoreInput&{ordersPerDay?:number|null})[];
if(!Array.isArray(rows)||rows.some(x=>typeof x.address!=='string'))throw new Error('invalid ScoreInput array');
const inputs=rows.filter(x=>!isHighFrequency(x.ordersPerDay??null));
const standard=scoreCandidates(inputs,{finalists:40});
const recent=scoreCandidates(inputs,{finalists:40,lookbackDays:30});
if(standard.finalists.length!==40||recent.finalists.length!==40)throw new Error('both score groups need 40 distinct finalists');
const byInput=new Map(inputs.map(x=>[x.address.toLowerCase(),x]));
const byRecent=new Map(recent.candidates.map(x=>[x.address.toLowerCase(),x]));
const standardKinds=standard.finalists.reduce((n,a)=>{
  const kind=byInput.get(a.toLowerCase())?.kind;
  if(kind==='trader')n.trader++;else n.vault++;
  return n;
},{trader:0,vault:0});
const pool=recent.candidates.filter(x=>x.eligible&&x.cloneOf===null&&typeof x.metrics?.periodReturn==='number'&&Number.isFinite(x.metrics.periodReturn));
const byReturn=(a:(typeof pool)[number],b:(typeof pool)[number])=>
  b.metrics!.periodReturn!-a.metrics!.periodReturn!||a.address.localeCompare(b.address);
const returnGroup=[
  ...pool.filter(x=>x.pool==='trader').sort(byReturn).slice(0,standardKinds.trader),
  ...pool.filter(x=>x.pool==='vault').sort(byReturn).slice(0,standardKinds.vault),
].map(x=>x.address);
if(returnGroup.length!==40||scoreCandidates(returnGroup.map(a=>byInput.get(a.toLowerCase())!),{finalists:40}).finalists.length!==40)
  throw new Error('recent-return group is underfilled after Score eligibility or clone checks');
const summary=(addresses:string[])=>{
  const values=addresses.map(a=>byRecent.get(a.toLowerCase())?.metrics?.periodReturn)
    .filter((n):n is number=>typeof n==='number'&&Number.isFinite(n)).sort((a,b)=>a-b);
  return {count:addresses.length,validRecentReturns:values.length,
    medianRecentReturn:values.length?(values[Math.floor((values.length-1)/2)]+values[Math.floor(values.length/2)])/2:null,
    meanRecentReturn:values.length?values.reduce((a,b)=>a+b,0)/values.length:null,
    positive:values.filter(n=>n>0).length,over5Pct:values.filter(n=>n>=0.05).length,
    over10Pct:values.filter(n=>n>=0.1).length};
};
const baselineSet=new Set(standard.finalists.map(a=>a.toLowerCase()));
const aggregate={population:rows.length,afterNoHft:inputs.length,kinds:standardKinds,
  standard90:summary(standard.finalists),recentScore30:summary(recent.finalists),
  recentReturn30:summary(returnGroup),recentScoreOverlap:recent.finalists.filter(a=>baselineSet.has(a.toLowerCase())).length,
  recentReturnOverlap:returnGroup.filter(a=>baselineSet.has(a.toLowerCase())).length,
  note:'Same point-in-time inputs and Score eligibility; recent-return group changes the final ranking only. Committee policy remains identical.'};
await mkdir(output,{recursive:true});
await Promise.all([
  writeFile(resolve(output,'summary.json'),JSON.stringify(aggregate,null,2)),
  writeFile(resolve(output,'recent-return40-inputs.json'),JSON.stringify(returnGroup.map(a=>byInput.get(a.toLowerCase()))),{mode:0o600}),
]);
console.log(JSON.stringify(aggregate,null,2));
