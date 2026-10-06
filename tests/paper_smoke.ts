/** Reproducible synthetic end-to-end check. No network or signing credentials. */
import {fixture} from './support/mirror-fixture.ts';
import {runPaperMirror} from '../packages/cre-workflows/mirror/runner.ts';
import {createPaperReport} from '../packages/shared/src/paper-report.ts';
import {PaperExecutor} from '../packages/executor/src/paper.ts';
const input=fixture();
const result=await runPaperMirror({configuration:input.configuration,sampleSeed:'0x'+'c'.repeat(64),markets:input.markets,runId:input.runId,maxStateAgeMs:input.maxStateAgeMs,deadlineMs:1000},{
  async confirmedFreeze(){return input.confirmedFreeze;},
  async snapshot(){return input.snapshot;},
  async account(address){const state=address===input.account.address?input.account:input.checks.find(state=>state.address===address);if(!state)throw new Error('missing synthetic state');return state;},
},()=>input.nowMs);
if(result.status!=='READY')throw new Error(result.reason);
const report=createPaperReport(result.plan,input.configuration,input.nowMs);
const executor=new PaperExecutor();
const receipt=executor.execute(report,input,input.nowMs);
const replay=executor.execute(report,input,input.nowMs);
if(JSON.stringify(receipt)!==JSON.stringify(replay))throw new Error('non-idempotent replay');
console.log(JSON.stringify({fixture:'SYNTHETIC',mode:'PAPER',status:'PASS',receipt},null,2));
