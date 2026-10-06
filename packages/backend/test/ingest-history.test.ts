import {expect,test} from "bun:test";
import {normalizedMonth,mergeHistory,historyBefore} from "../src/ingest/history";
const window=(p:number[])=>({accountValueHistory:[[1000,"100"],[2000,"110"]],pnlHistory:[[1000,String(p[0])],[2000,String(p[1])]]});
const raw=()=>[["month",window([0,10])],["allTime",window([50,60])]];
test("normalizes using shared baseline, not resetting PnL each run",()=>{
 const rows=normalizedMonth('0xabc',raw(),'2026-10-06T00:00:00Z','old');
 expect(rows.map(r=>r.pnlAllTime)).toEqual([50,60]);
 expect(historyBefore(rows,'0xABC',2000)).toBeNull();
 expect(historyBefore(rows,'0xabc',3000)?.pnlHistory).toEqual([[1000,50],[2000,60]]);
});
test("deduplicates exact repeats and logs restatements while retaining newer evidence",()=>{
 const rows=normalizedMonth('0xabc',raw(),'2026-10-06T00:00:00Z','old');
 expect(mergeHistory([...rows,...rows]).rows).toHaveLength(2);
 const newer={...rows[1],pnlAllTime:65,fetchedAt:'2026-10-07T00:00:00Z',runId:'new'};
 const result=mergeHistory([newer,...rows]);expect(result.mismatches).toHaveLength(1);expect(result.rows[1].pnlAllTime).toBe(65);
});
test("orders fetch times numerically when ISO fractional precision differs",()=>{
 const rows=normalizedMonth('0xabc',raw(),'2026-10-06T00:00:00Z','old');
 const newer={...rows[0],pnlAllTime:55,fetchedAt:'2026-10-06T00:00:00.100Z',runId:'new'};
 expect(mergeHistory([newer,...rows]).rows[0].pnlAllTime).toBe(55);
});
test("rejects mismatching endpoints and overlapping histories",()=>{
 expect(()=>normalizedMonth('x',[["month",window([0,10])],["allTime",window([40,60])]],'now','r')).toThrow('disagree');
 const p=window([50,60]);p.accountValueHistory[1][1]='120';
 expect(()=>normalizedMonth('x',[["month",window([0,10])],["allTime",p]],'now','r')).toThrow('endpoints');
});
