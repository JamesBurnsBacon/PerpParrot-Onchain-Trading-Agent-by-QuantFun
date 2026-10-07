// Optional isolated local harness, never production. Runs the same SQL against PGlite's Postgres
// engine. It does not test Bun's network driver, locks or a Supabase deployment.
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
export interface LocalReviewSql {
  (strings:TemplateStringsArray,...values:unknown[]):Promise<Record<string,any>[]>;
  begin<T>(fn:(tx:LocalReviewSql)=>Promise<T>):Promise<T>;
  close():Promise<void>;
}
export async function localReviewDb(directory:string):Promise<LocalReviewSql> {
  const db=new PGlite(directory);
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261007120000_pipeline.sql',import.meta.url),'utf8'));
  const tag=(client:Pick<PGlite,'query'>):LocalReviewSql=>Object.assign(async(strings:TemplateStringsArray,...values:unknown[])=>{
    const query=strings.reduce((s,p,i)=>s+(i?`$${i}`:'')+p,'');
    return (await client.query<Record<string,any>>(query,values.map(v=>v instanceof Date?v.toISOString():v!==null&&typeof v==='object'?JSON.stringify(v):v))).rows;
  },{begin:async<T>(fn:(tx:LocalReviewSql)=>Promise<T>)=>db.transaction(tx=>fn(tag(tx))),close:()=>db.close()});
  return tag(db);
}
