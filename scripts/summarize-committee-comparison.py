"""Compare two local research runs without exporting wallet addresses or raw evidence.
Usage: python3 scripts/summarize-committee-comparison.py first.json second.json output.json
A failed model is recorded as unavailable, never as zero passing candidates.
"""
import json,hashlib,sys
from pathlib import Path

def load(path):
 value=json.loads(path.read_text());report=value['report'];review=value['run'].get('review') or {}
 if report.get('preparedOnly') or not report.get('researchOnly') or report.get('researchContract')!=f"research-{report.get('finalists')}-v1" or report.get('finalists') not in [35,40] or report.get('cacheMisses'):
  raise ValueError('Expected a complete frozen Top35/Top40 research input')
 count=report['finalists']
 rows={}
 for record in review.get('audit',[]):
  if record['stage'] in ['role','risk']:
   output=record['output']['results']
   if sorted(x['candidate'] for x in output)!=list(range(count)):raise ValueError('Incomplete rating IDs')
   rows[record['stage']]={x['candidate']:x for x in output}
 complete=all(stage in rows for stage in ['role','risk'])
 summaries={x['candidate']:x for x in review.get('summary',[])}
 if complete and sorted(summaries)!=list(range(count)):raise ValueError('Incomplete candidate summary IDs')
 passed=[i for i,r in summaries.items() if r.get('gate') and not r['gate']['reasons']] if complete else None
 calls=report['modelCalls'];totals={k:sum(c.get('usage',{}).get(k,0) for c in calls) for k in ['prompt_tokens','completion_tokens','total_tokens']}
 details=[{k:c.get(k) for k in ['stage','model','httpStatus','finishReason','elapsedMs','errorType','errorCode','errorMessage']} for c in calls]
 modelConfigs=sorted(set(r['output']['modelConfigHash'] for r in review.get('audit',[])))
 summary={'candidateCount':count,'provider':report['provider'],'requestedModel':report['requestedModel'],'ratingsComplete':complete,'committeeComplete':complete and any(r['stage']=='redteam' for r in review.get('audit',[])) and not report.get('stageFailures'),'candidatePass':len(passed) if passed is not None else None,
  'passingCandidates':passed,'manifestStatus':report.get('manifest',{}).get('status'),'manifestReason':report.get('manifest',{}).get('reason'),
  'manifestSourceCount':len(report.get('manifest',{}).get('sources',[])),'freezeEligible':report.get('freezeEligible',False),'blockers':report.get('blockers') if complete else None,'tokens':totals,'calls':details,'modelConfigHashes':modelConfigs,
  'replayedStages':report.get('replayedStages',[]),'replayRunHash':report.get('replayRunHash'),'runtime':{k:report.get(k) for k in ['asOf','agentTimeoutMs','serial','stageSpacingMs','researchContract']},'sourceSha256':hashlib.sha256(path.read_bytes()).hexdigest()}
 return value,rows,summaries,summary

def compare(paths):
 left,right=[load(p) for p in paths];checks={}
 for field in ['asOf','agentTimeoutMs','serial','stageSpacingMs','researchContract']:
  checks[field]=left[3]['runtime'][field]==right[3]['runtime'][field]
 for stage in ['paper_role','paper_risk']:
  calls=[next((c for c in x[0]['report']['modelCalls'] if c['stage']==stage),None) for x in [left,right]]
  for field in ['evidenceHash','policyHash','snapshotHash','promptHash','schemaHash','userMessageHash','reasoningEffort','maxCompletionTokens']:
   checks[stage+'.'+field]=all(c is not None and field in c for c in calls) and calls[0][field]==calls[1][field]
 if not all(checks.values()):raise ValueError('Unmatched input or research conditions: '+str([k for k,v in checks.items() if not v]))
 a,b=left[3],right[3];count=a['candidateCount'];assert count==b['candidateCount'];result={'researchOnly':True,'economicAuthority':False,'candidateCount':count,'pairedRuns':1,'matchedConditions':checks,'models':[a,b],
  'evidenceHash':left[0]['report']['modelCalls'][0]['evidenceHash'],'policyHash':left[0]['report']['modelCalls'][0]['policyHash'],
  'limitations':['One frozen research cohort cannot establish accuracy, returns, or repeatability.','Same high label and output cap do not imply identical internal reasoning budgets.','Red-Team examines each model own compiled draft; its complete prompt need not match.','Public historical Score/fills and later positions are not a synchronized backtest.','Model availability failures are not candidate rejections.','Research contract version and deadline are isolated from the production settings; check the runtime provenance.']}
 if a['replayedStages'] or b['replayedStages']:result['limitations'].append('Resumed stages reuse validated provider observations, so this is not a continuous-run latency benchmark.')
 if a['ratingsComplete'] and b['ratingsComplete']:
  pa,pb=set(a['passingCandidates']),set(b['passingCandidates'])
  result['agreement']={'bothPass':sorted(pa&pb),'leftOnlyPass':sorted(pa-pb),'rightOnlyPass':sorted(pb-pa),'bothReject':sorted(set(range(count))-pa-pb),
   'binaryAgreement':(count-len(pa^pb))/count,'positiveJaccard':len(pa&pb)/len(pa|pb) if pa|pb else None}
  result['candidates']=[]
  for i in range(count):
   metrics=left[2][i]['metrics'];assert metrics==right[2][i]['metrics']
   row={'candidate':i,'kind':left[2][i]['kind'],'models':{}}
   for x in [left,right]:
    role,risk=x[1]['role'][i],x[1]['risk'][i]
    row['models'][x[3]['provider']]={'gateReasons':x[2][i]['gate']['reasons'],'roleConfidence':role['confidence'],'riskConfidence':risk['confidence'],'roleReject':role['reject'],'aggressiveFit':role['aggressiveFit'],
     'risks':{k:v for k,v in risk.items() if k not in ['candidate','confidence']}}
   result['candidates'].append(row)
 return result
if __name__=='__main__':
 result=compare([Path(sys.argv[1]),Path(sys.argv[2])]);Path(sys.argv[3]).write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'matched':True,'models':[{k:x[k] for k in ['requestedModel','ratingsComplete','candidatePass','manifestStatus','manifestReason']} for x in result['models']],'agreement':result.get('agreement')}))
