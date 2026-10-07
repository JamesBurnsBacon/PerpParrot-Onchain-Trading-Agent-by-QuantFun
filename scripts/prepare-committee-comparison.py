"""Build an isolated paper comparison runtime, defaulting to the current Top40 cohort.
Run: python3 scripts/prepare-committee-comparison.py work/<experiment>/runtime
Never modifies production files. Only research capacity/version, mode and deadline differ.
"""
from pathlib import Path
import argparse,hashlib,json,re,shutil,subprocess

parser=argparse.ArgumentParser();parser.add_argument('output');parser.add_argument('--finalists',type=int,default=40);parser.add_argument('--deadline-ms',type=int,default=900000)
args=parser.parse_args();root=Path(__file__).resolve().parent.parent;out=Path(args.output).resolve();count=args.finalists;deadline=args.deadline_ms
if count<5 or count>40 or deadline<1000 or deadline>900000:raise SystemExit('Research capacity must be 5..40; deadline 1000..900000ms')
if not out.is_relative_to(root/'work') or out.exists():raise SystemExit('Choose a new directory inside this checkout/work')
base=json.loads((root/'packages/shared/schemas/candidate-curation-frame.schema.json').read_text())['properties']['candidates']['maxItems']
version=f'research-{count}-v1';out.mkdir(parents=True)
for rel in ['packages/backend/review','packages/backend/src','packages/backend/scripts','packages/backend/fixtures','packages/shared']:
 shutil.copytree(root/rel,out/rel,ignore=shutil.ignore_patterns('node_modules','.env*','work'))
rel='supabase/migrations/20261007120000_pipeline.sql';(out/rel).parent.mkdir(parents=True);shutil.copy2(root/rel,out/rel)
(out/'packages/backend/node_modules').symlink_to((root/'packages/backend/node_modules').resolve(),target_is_directory=True)
source_hashes={str(p.relative_to(out)):hashlib.sha256(p.read_bytes()).hexdigest() for p in out.rglob('*') if p.is_file() and not p.is_symlink()}
changes=[]
def write(rel,text):
 before=(out/rel).read_bytes();(out/rel).write_text(text)
 changes.append({'path':str(rel),'beforeSha256':hashlib.sha256(before).hexdigest(),'afterSha256':hashlib.sha256(text.encode()).hexdigest()})
for name in ['candidate-curation-frame','role-consensus','risk-consensus','redteam-consensus','bucket-manifest']:
 rel=Path('packages/shared/schemas')/(name+'.schema.json');schema=json.loads((out/rel).read_text())
 def update(v):
  if isinstance(v,dict):
   if v.get('const')=='1.1.0':v['const']=version
   if v.get('maximum')==base-1:v['maximum']=count-1
   if v.get('maxItems')==base:v['maxItems']=count
   if v.get('maxItems')==base*(base-1)//2:v['maxItems']=count*(count-1)//2
   for x in v.values():update(x)
  elif isinstance(v,list):
   for x in v:update(x)
 update(schema);write(rel,json.dumps(schema,indent=2)+'\n')
rel=Path('packages/shared/src/contracts.ts');s=(out/rel).read_text();assert s.count("CONTRACT_VERSION = '1.1.0'")==1
write(rel,s.replace("CONTRACT_VERSION = '1.1.0'",f"CONTRACT_VERSION = '{version}'"))
rel=Path('packages/shared/src/review-evidence.ts');s=(out/rel).read_text();assert s.count(f'.max({base-1})')==3 and s.count(f'.max({base})')==1 and s.count(f'.max({base*(base-1)//2})')==1
write(rel,s.replace(f'.max({base-1})',f'.max({count-1})').replace(f'.max({base})',f'.max({count})').replace(f'.max({base*(base-1)//2})',f'.max({count*(count-1)//2})'))
rel=Path('packages/backend/review/workflow.ts');s=(out/rel).read_text();bounds=re.findall(r'deps.agentTimeoutMs<=(\d+)',s);assert len(bounds)==1
production_deadline=int(bounds[0]);write(rel,re.sub(r'deps.agentTimeoutMs<=\d+',f'deps.agentTimeoutMs<={deadline}',s))
rel=Path('packages/backend/fixtures/review-policy.json');s=json.loads((out/rel).read_text());s['policy']['mode']='SIMULATION';write(rel,json.dumps(s,indent=2)+'\n')
rel=Path('packages/backend/scripts/strict-gate-check.ts');s=(out/rel).read_text();marker='const url=process.env.DATABASE_URL;';assert s.count(marker)==1
s,n=re.subn(r'MAX_RESEARCH_FINALISTS=\d+,MAX_RESEARCH_TIMEOUT_MS=\d+',f'MAX_RESEARCH_FINALISTS={count},MAX_RESEARCH_TIMEOUT_MS={deadline}',s);assert n==1
s=s.replace(marker,f"if(!values['local-dir']||!values.offline||values.finalists!=='{count}'||values.gate!=='strict')throw new Error('research runtime requires local, offline, strict Top{count}');\n"+marker)
s=s.replace('const report={provider:',f"const report={{researchOnly:true,economicAuthority:false,researchContract:'{version}',provider:");write(rel,s)
manifest={'baseHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'generatorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'sourceFileHashes':source_hashes,
 'researchOnly':True,'economicAuthority':False,'changes':changes,'unchangedRules':['candidateGate','riskDecision','compile/weights/pair checks','Red-Team rebuild/exclusion','five-source minimum','assessment closure','system prompts'],
 'sourceProductionDeadlineMs':production_deadline,'limits':{'candidateCount':count,'candidateIds':f'0..{count-1}','pairs':count*(count-1)//2,'allowedDeadlineMs':deadline,'mode':'SIMULATION','schemaVersion':version}}
(out/'research-runtime.json').write_text(json.dumps(manifest,indent=2)+'\n');print(json.dumps({'runtime':str(out),'patchedFiles':len(changes),'researchOnly':True,'finalists':count}))
