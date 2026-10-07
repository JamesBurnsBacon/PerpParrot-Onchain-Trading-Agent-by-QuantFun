// Optional isolated local harness, never production. Runs the same SQL against PGlite's Postgres
// engine. It does not test Bun's network driver, locks or a Supabase deployment.
import {PGlite} from '@electric-sql/pglite';
import type {SQL} from 'bun';
export async function localReviewDb(directory:string):Promise<SQL> {
  const db=new PGlite(directory);
  await db.exec(await Bun.file(new URL('../../../supabase/migrations/20261007120000_pipeline.sql',import.meta.url)).text());
  const tag=(client:Pick<PGlite,'query'>)=>Object.assign(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.reduce((s,p,i)=>s+(i?`$${i}`:'')+p,'');
    return (await client.query(query,values.map(v=>v instanceof Date?v.toISOString():v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows;
  },{begin:async(fn:(tx:SQL)=>unknown)=>db.transaction(async tx=>fn(tag(tx) as unknown as SQL)),close:()=>db.close()});
  return tag(db) as unknown as SQL;
}
