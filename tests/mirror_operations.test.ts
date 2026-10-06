import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recordMirrorOutcome} from '../packages/cre-workflows/mirror/operations.ts';
test('second consecutive failure enqueues one durable alert; duplicates and later failures do not repeat it', () => {
  const initial={lastSlot:-1,consecutiveFailures:0,alertId:null};
  const first=recordMirrorOutcome(initial,100,false,'mirror');assert.equal(first.enqueueAlert,false);
  const second=recordMirrorOutcome(first.state,101,false,'mirror');assert.equal(second.enqueueAlert,true);
  assert.ok(second.state.alertId);
  const duplicate=recordMirrorOutcome(second.state,101,false,'mirror');assert.equal(duplicate.changed,false);
  const third=recordMirrorOutcome(second.state,102,false,'mirror');assert.equal(third.enqueueAlert,false);
  assert.equal(third.state.alertId,second.state.alertId);
  const lateSuccess=recordMirrorOutcome(third.state,101,true,'mirror');assert.equal(lateSuccess.changed,false);
  const recovery=recordMirrorOutcome(third.state,103,true,'mirror');assert.equal(recovery.state.consecutiveFailures,0);assert.equal(recovery.state.alertId,null);
});
test('missed slots require a watchdog event and do not manufacture consecutive failures', () => {
  const previous={lastSlot:100,consecutiveFailures:1,alertId:null};
  const skipped=recordMirrorOutcome(previous,102,false,'mirror');assert.equal(skipped.state.consecutiveFailures,1);assert.equal(skipped.enqueueAlert,false);
  assert.throws(() => recordMirrorOutcome(previous,NaN,false,'mirror'));
});
