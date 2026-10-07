import {test} from 'node:test';
import assert from 'node:assert/strict';
import {localReviewDb} from '../packages/backend/scripts/local-review-db.ts';
// The local harness uses the root's existing PGlite dev dependency, not a production dependency.
test('isolated review harness stores exact JSON and rolls back failed transactions',async()=>{
  const sql=await localReviewDb('memory://');
  try {
    const [r]=await sql`insert into selection_runs(started_at,status,accounts) values(${new Date(0)},'running',25) returning id`;
    const payload={measured:{sample:{btcBeta:0.3}},additional:{sample:{patterns:{observedFills:0}}}};
    await sql`update selection_runs set finalists=${JSON.stringify(payload)}::text::jsonb where id=${r.id}`;
    assert.deepEqual((await sql`select finalists from selection_runs where id=${r.id}`)[0].finalists,payload);
    await assert.rejects(sql.begin(async tx=>{await tx`update selection_runs set status='failed' where id=${r.id}`;throw new Error('rollback');}),/rollback/);
    assert.equal((await sql`select status from selection_runs where id=${r.id}`)[0].status,'running');
  }finally{await sql.close();}
});
