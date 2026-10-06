import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './support/mirror-fixture.ts';
import {validate} from '../packages/shared/src/validate.ts';
import {validateRuntimePolicy} from '../packages/shared/src/policy-runtime.ts';
test('CRE interpreted policy matches the canonical JSON schema across field boundaries',()=>{
 const policy=fixture().configuration.policy;
 for(const key of Object.keys(policy))for(const value of [undefined,null,-1,0,0.5,1,10,30,100,101,Number.MAX_SAFE_INTEGER,'LIVE','BALANCED','invalid']){
  const input={...policy,[key]:value};
  function accepts(check:(v:unknown)=>void){try{check(input);return true;}catch{return false;}}
  assert.equal(accepts(validateRuntimePolicy),accepts(v=>validate('bucket-policy',v)),`${key}:${String(value)}`);
 }
 validateRuntimePolicy(policy);assert.throws(()=>validateRuntimePolicy({...policy,extra:1}));
});
