import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readiness} from '../packages/backend/src/readiness.ts';
import {deliverOneAlert} from '../packages/backend/src/alerts.ts';
test('deployment checklist cannot treat local checks as verified deployed gates',()=>{
 const commit='a'.repeat(40);assert.equal(readiness([],commit,3000).ready,false);
 assert.ok(readiness([{gate:'executor-durable-recovery',artifact:'local database test',commit,verifiedAtMs:2900,environment:'LOCAL'}],commit,3000).missing.includes('executor-durable-recovery'));
 assert.throws(()=>readiness([{gate:'funded-canary',artifact:'x',commit:'b'.repeat(40),verifiedAtMs:2900,environment:'DEPLOYED'}],commit,3000));
});
test('alert worker acknowledges confirmed sends and leaves failed delivery for retry',async()=>{
 let acks=0;const rpc={async call(name:string){if(name==='claim_alert')return {id:'mirror:11',workflow_id:'mirror',slot:11};acks++;return true;}};
 assert.equal(await deliverOneAlert(rpc,'123:test-token','123',()=>3000,async()=>new Response(JSON.stringify({ok:true}))), 'DELIVERED');assert.equal(acks,1);
 assert.equal(await deliverOneAlert(rpc,'123:test-token','123',()=>3000,async()=>new Response('sensitive key error',{status:503})), 'RETRY');assert.equal(acks,1);
});
