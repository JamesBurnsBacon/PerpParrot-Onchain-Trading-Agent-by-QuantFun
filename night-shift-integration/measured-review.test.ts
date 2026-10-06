import {test,expect} from 'bun:test';
import {setup,NOW,DAY} from '../tests/support/score-frame.ts';
import {buildReviewInput} from '../packages/backend/review/input.ts';
import {measureAccountEvidence,type ClearinghouseEvidence} from '../packages/backend/review/measured-evidence.ts';
import {verifyInputCommitments} from '../packages/shared/src/commitments.ts';
import {bindCommitteeEvidence} from '../packages/shared/src/committee-evidence.ts';
import {enrichMeasuredReview,measuredFlags,measuredDecisionDiagnostics} from './measured-review.ts';
import {candidateCompileFailures} from '../packages/backend/review/workflow.ts';
import type {Row} from '../packages/shared/src/contracts.ts';

test('measured patches preserve unknown values and rebind schema-valid flags, metrics and pair overlap',()=>{
 const args=setup(),built=buildReviewInput(args),originalHash=built.frame.snapshotHash;
 const states=new Map<string,ClearinghouseEvidence>(),measurements=new Map<string,ReturnType<typeof measureAccountEvidence>>(),executions=new Map<string,{executionCoverage:number;executionFit:number}>();
 for(const [id,address] of built.addresses){
  const state:ClearinghouseEvidence={asOfMs:NOW,complete:true,accountValueUsd:50_000,rawSha256:['a'.repeat(64)],
   positions:[{coin:'BTC',size:id===0?1:-1,signedNotionalUsd:id===0?100:-100,configuredLeverage:3,liquidationDistance:null}]};
  states.set(address,state);executions.set(address,{executionCoverage:1,executionFit:90});
  measurements.set(address,measureAccountEvidence({input:args.inputs[id],asOfMs:NOW,clearinghouse:state,
   fills:{rows:[],startMs:NOW-30*DAY,endMs:NOW,complete:true,pages:[{requestStartMs:NOW-30*DAY,requestEndMs:NOW,rawSha256:'b'.repeat(64),count:0}]}}));
 }
 enrichMeasuredReview(built,args.policy,measurements,executions,states);
 expect(built.frame.snapshotHash).not.toBe(originalHash);expect(verifyInputCommitments(built.frame,args.policy,built.addresses)).toBe(true);
 expect(bindCommitteeEvidence(built.frame,args.policy,built.addresses,built.evidence).evidenceHash).toBe(built.committee.evidenceHash);
 expect(built.frame.pairs[0].currentExposureOverlap).toBe(0);
 for(const c of built.frame.candidates){
  expect(c.metrics.medianHoldMinutes).toBeNull();expect(c.metrics.averageLeverage).toBeNull();expect(c.metrics.oosSharpe).toBeNull();
  expect(c.metrics.executionFit).toBe(90);expect(c.metrics.scoreFlags).toContain('leverage-unmeasured');
  expect(c.metrics.scoreFlags).toContain('current-position-execution');expect(c.metrics.scoreFlags.every(f=>/^[a-z][a-z-]{0,31}$/.test(f))).toBe(true);
 }
 expect([...measurements.values()][0].reasons).toContain('HISTORICAL_AVERAGE_LEVERAGE_UNMEASURED');
});
test('compact measurement taxonomy handles coin-specific reasons and signals truncation within contract bounds',()=>{
 const tags=measuredFlags(Array.from('abcdefghijklmnop',c=>'score-'+c),['POSITION_PATH_AMBIGUOUS:xyz:NVDA','HISTORICAL_AVERAGE_LEVERAGE_UNMEASURED']);
 expect(tags).toHaveLength(16);expect(tags).toContain('more-evidence-flags');expect(tags).toContain('current-cohort-holdout');
 expect(tags.every(f=>/^[a-z][a-z-]{0,31}$/.test(f))).toBe(true);
 expect(measuredFlags([],['POSITION_PATH_AMBIGUOUS:xyz:NVDA'])).toContain('ambiguous-position-path');
 expect(()=>measuredFlags(['UPPERCASE'],[])).toThrow('INVALID_SCORE_FLAG');
});
test('decision diagnostics match production mandatory compile gates without inventing missing evidence',()=>{
 const args=setup(),built=buildReviewInput(args),candidate=built.frame.candidates[0];
 const role:Row={candidate:0,confidence:80,reject:0,aggressiveFit:80};
 const risk:Row={candidate:0,confidence:80,drawdownRisk:20,leverageRisk:20,concentrationRisk:20,pathRisk:20,executionRisk:20,evidenceRisk:20};
 let result=measuredDecisionDiagnostics(built,args.policy,[role],[risk]);
 expect(result.candidates[0].failedPrerequisites).toEqual(candidateCompileFailures(candidate,args.policy,role,risk));
 expect(result.candidates[0].failedPrerequisites).toContain('OOS_SHARPE_UNKNOWN');
 expect(result.candidates[1].failedPrerequisites).toContain('ROLE_OBSERVATION_MISSING');
 Object.assign(candidate.metrics,{oosWindows:2,oosSharpe:1,oosSortino:1,oosMaxDrawdown:0.1,crossWindowStability:0.5,averageLeverage:1,medianHoldMinutes:60,executionFit:args.policy.minExecutionFit,executionCoverage:1});
 result=measuredDecisionDiagnostics(built,args.policy,[role],[risk]);expect(result.candidates[0].mandatoryPrerequisitesPassed).toBe(true);
 candidate.metrics.medianHoldMinutes=59;role.confidence=args.policy.minConfidence-1;risk.executionRisk=args.policy.riskRejectThreshold;
 result=measuredDecisionDiagnostics(built,args.policy,[role],[risk]);
 expect(result.candidates[0].failedPrerequisites).toEqual(['HOLDING_BELOW_ONE_HOUR','ROLE_CONFIDENCE_BELOW_POLICY','RISK_REJECTED']);
 expect(result.counts.HOLDING_BELOW_ONE_HOUR).toBe(1);expect(result.candidates[0].risk?.status).toBe('REJECT');
});
