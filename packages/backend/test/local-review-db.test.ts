import {expect,test} from 'bun:test';
import {localReviewDb} from '../scripts/local-review-db';
// Same tagged SQL used by review(), including JSONB text casts and transaction rollback.
test('isolated review harness stores exact JSON and rolls back failed transactions',async()=>{
  const sql=await localReviewDb('memory://');
  try {
    const [r]=await sql`insert into selection_runs(started_at,status,accounts) values(${new Date(0)},'running',25) returning id`;
    const payload={measured:{sample:{btcBeta:0.3}},additional:{sample:{patterns:{observedFills:0}}}};
    await sql`update selection_runs set finalists=${JSON.stringify(payload)}::text::jsonb where id=${r.id}`;
    expect((await sql`select finalists from selection_runs where id=${r.id}`)[0].finalists).toEqual(payload);
    await expect(sql.begin(async tx=>{await tx`update selection_runs set status='failed' where id=${r.id}`;throw new Error('rollback');})).rejects.toThrow('rollback');
    expect((await sql`select status from selection_runs where id=${r.id}`)[0].status).toBe('running');
  }finally{await sql.close();}
});
