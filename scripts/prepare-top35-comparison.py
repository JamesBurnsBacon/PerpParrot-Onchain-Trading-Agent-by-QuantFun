"""Create an explicit, local-only Top35 research runtime; never patch production schemas.
Run: python3 scripts/prepare-top35-comparison.py work/<experiment>/runtime
The copied runtime changes only candidate/pair capacity, research version, SIMULATION mode,
and the allowed request deadline. Candidate gates, weights, prompts and portfolio rules stay exact.
"""
from pathlib import Path
import hashlib,json,shutil,subprocess,sys

root=Path(__file__).resolve().parent.parent
out=Path(sys.argv[1]).resolve()
if not out.is_relative_to(root/'work') or out.exists():
 raise SystemExit('Choose a new directory inside this checkout/work')
out.mkdir(parents=True)
for rel in ['packages/backend/review','packages/backend/src','packages/backend/scripts','packages/backend/fixtures','packages/shared']:
 shutil.copytree(root/rel,out/rel,ignore=shutil.ignore_patterns('node_modules','.env*','work'))
rel='supabase/migrations/20261007120000_pipeline.sql'
(out/rel).parent.mkdir(parents=True);shutil.copy2(root/rel,out/rel)
# Reuse already installed libraries only; never copy credentials or account configuration.
(out/'packages/backend/node_modules').symlink_to((root/'packages/backend/node_modules').resolve(),target_is_directory=True)
changes=[]
def write(rel,text):
 before=(out/rel).read_bytes();(out/rel).write_text(text)
 changes.append({'path':str(rel),'beforeSha256':hashlib.sha256(before).hexdigest(),'afterSha256':hashlib.sha256(text.encode()).hexdigest()})
for name in ['candidate-curation-frame','role-consensus','risk-consensus','redteam-consensus','bucket-manifest']:
 rel=Path('packages/shared/schemas')/(name+'.schema.json');schema=json.loads((out/rel).read_text())
 def update(v):
  if isinstance(v,dict):
   if v.get('const')=='1.1.0':v['const']='research-35-v1'
   if v.get('maximum')==24:v['maximum']=34
   if v.get('maxItems')==25:v['maxItems']=35
   if v.get('maxItems')==300:v['maxItems']=595
   for x in v.values():update(x)
  elif isinstance(v,list):
   for x in v:update(x)
 update(schema);write(rel,json.dumps(schema,indent=2)+'\n')
rel=Path('packages/shared/src/contracts.ts');s=(out/rel).read_text();assert s.count("CONTRACT_VERSION = '1.1.0'")==1
write(rel,s.replace("CONTRACT_VERSION = '1.1.0'","CONTRACT_VERSION = 'research-35-v1'"))
rel=Path('packages/shared/src/review-evidence.ts');s=(out/rel).read_text();assert s.count('.max(24)')==3 and s.count('.max(25)')==1 and s.count('.max(300)')==1
write(rel,s.replace('.max(24)','.max(34)').replace('.max(25)','.max(35)').replace('.max(300)','.max(595)'))
rel=Path('packages/backend/review/workflow.ts');s=(out/rel).read_text();assert s.count('deps.agentTimeoutMs<=60000')==1
write(rel,s.replace('deps.agentTimeoutMs<=60000','deps.agentTimeoutMs<=300000'))
rel=Path('packages/backend/fixtures/review-policy.json');s=json.loads((out/rel).read_text());s['policy']['mode']='SIMULATION';write(rel,json.dumps(s,indent=2)+'\n')
# The local runner refuses non-local or live-data runs in this copied runtime.
rel=Path('packages/backend/scripts/strict-gate-check.ts');s=(out/rel).read_text();marker='const url=process.env.DATABASE_URL;';assert s.count(marker)==1
assert s.count('MAX_RESEARCH_FINALISTS=25,MAX_RESEARCH_TIMEOUT_MS=60000')==1
s=s.replace('MAX_RESEARCH_FINALISTS=25,MAX_RESEARCH_TIMEOUT_MS=60000','MAX_RESEARCH_FINALISTS=35,MAX_RESEARCH_TIMEOUT_MS=300000')
s=s.replace(marker,"if(!values['local-dir']||!values.offline||values.finalists!=='35'||values.gate!=='strict')throw new Error('research runtime requires local, offline, strict Top35');\n"+marker)
s=s.replace('const report={provider:',"const report={researchOnly:true,economicAuthority:false,researchContract:'research-35-v1',provider:")
write(rel,s)
manifest={'baseHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),'researchOnly':True,'economicAuthority':False,'changes':changes,
 'unchangedRules':['candidateGate','riskDecision','compile/weights/pair checks','Red-Team rebuild/exclusion','five-source minimum','assessment closure','system prompts'],
 'limits':{'candidateCount':35,'candidateIds':'0..34','pairs':595,'allowedDeadlineMs':300000,'mode':'SIMULATION','schemaVersion':'research-35-v1'}}
(out/'research-runtime.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'runtime':str(out),'patchedFiles':len(changes),'researchOnly':True}))
