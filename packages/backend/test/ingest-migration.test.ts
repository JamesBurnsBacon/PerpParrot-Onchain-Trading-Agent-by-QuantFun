import {expect,test} from 'bun:test';
import {PGlite} from '@electric-sql/pglite';
const migration=await Bun.file(new URL('../../../supabase/migrations/20261007110000_ingest_pipeline.sql',import.meta.url)).text();
test('legacy migration preserves all archived rows and keys, importing only latest completed cache',async()=>{
  const pg=new PGlite();try{
    await pg.exec('create role anon; create role authenticated; create role service_role;');
    await pg.exec(await Bun.file(new URL('./fixtures/legacy-ingest.sql',import.meta.url)).text());
    const a=`0x${'a'.repeat(40)}`;
    await pg.query(`insert into ingest_runs(run_id,manifest,manifest_sha256,archive_path,candidate_count,portfolio_count,sync_status,created_at)
      values('old','{}',$1,'old',1,1,'complete','2026-10-01'),('new','{}',$1,'new',1,1,'complete','2026-10-02'),
      ('partial','{}',$1,'partial',1,0,'uploading','2026-10-03')`,['0'.repeat(64)]);
    await pg.query(`insert into ingest_candidates select run_id,$1,'12000','trader',true,'{"address":"${a}"}'::jsonb from ingest_runs`,[a]);
    await pg.query(`insert into ingest_portfolios values ('old',$1,'{"classification":{"kind":"trader"},"portfolio":{"fetchedAt":"2026-10-01T00:00:00Z"}}','[]'),
      ('new',$1,'{"classification":{"kind":"trader"},"portfolio":{"fetchedAt":"2026-10-02T00:00:00Z"}}','[["saved"]]')`,[a]);
    await pg.query("insert into ingest_sources values('old','leaderboard','{}','private-path')");
    await pg.exec(migration);await pg.exec(migration);
    for(const [table,count] of [['ingest_runs',3],['ingest_candidates',3],['ingest_portfolios',2],['ingest_sources',1]]){
      expect((await pg.query(`select count(*)::int n from ingest_legacy.${table}`)).rows).toEqual([{n:count}]);
    }
    expect((await pg.query('select portfolio from public.ingest_portfolios')).rows).toEqual([{portfolio:[['saved']]}]);
    expect((await pg.query("select refreshed_at::text t from public.ingest_accounts")).rows[0]).toEqual({t:'2026-10-02 00:00:00+00'});
    expect((await pg.query("select count(*)::int n from public.ingest_runs")).rows).toEqual([{n:0}]);
    const access=await pg.query("select has_table_privilege('anon','public.ingest_portfolios','select') allowed");
    expect(access.rows).toEqual([{allowed:false}]);
    await expect(pg.query("delete from ingest_legacy.ingest_runs where run_id='old'")).rejects.toThrow();
  }finally{await pg.close();}
},30_000);
