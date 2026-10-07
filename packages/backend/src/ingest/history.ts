import { parsePortfolio, validateSeries } from "../score";
import type { WindowHistory } from "../score";

export type HistoryRow = { address: string; tsMs: number; accountValue: number; pnlAllTime: number; fetchedAt: string; runId: string };
const close = (a: number, b: number) => Math.abs(a - b) <= 0.01 + 1e-9 * Math.abs(b);

// Validate shared points before translating month PnL to the allTime baseline (Score SPEC Snapshots).
export function normalizedMonth(address: string, raw: unknown, fetchedAt: string, runId: string): HistoryRow[] {
  const {month,allTime} = parsePortfolio(raw);
  if (!validateSeries(month) || !validateSeries(allTime)) throw new Error("Invalid scoring windows");
  const m = month.pnlHistory.at(-1)!; const a = allTime.pnlHistory.at(-1)!;
  if (m[0] !== a[0] || !close(month.accountValueHistory.at(-1)![1],allTime.accountValueHistory.at(-1)![1])) throw new Error("Window endpoints disagree");
  const offset = a[1]-m[1];
  const all = new Map(allTime.pnlHistory.map(([ts,pnl],i)=>[ts,{pnl,equity:allTime.accountValueHistory[i][1]}]));
  return month.pnlHistory.map(([ts,pnl],i)=> {
    const equity = month.accountValueHistory[i][1]; const baselinePnl = pnl+offset;
    const other=all.get(ts);
    if (!Number.isFinite(equity) || !Number.isFinite(baselinePnl) || (other && (!close(equity,other.equity) || !close(baselinePnl,other.pnl)))) throw new Error("Overlapping windows disagree");
    return {address:address.toLowerCase(),tsMs:ts,accountValue:equity,pnlAllTime:baselinePnl,fetchedAt,runId};
  });
}

export function mergeHistory(rows: HistoryRow[]) {
  const byKey = new Map<string,HistoryRow>();
  const mismatches: {address:string;tsMs:number;olderRun:string;newerRun:string}[] = [];
  for (const row of [...rows].sort((a,b)=>Date.parse(a.fetchedAt)-Date.parse(b.fetchedAt)||a.runId.localeCompare(b.runId))) {
    const key=`${row.address.toLowerCase()}:${row.tsMs}`;
    const old=byKey.get(key);
    if (old && (!close(old.accountValue,row.accountValue)||!close(old.pnlAllTime,row.pnlAllTime))) mismatches.push({address:row.address,tsMs:row.tsMs,olderRun:old.runId,newerRun:row.runId});
    byKey.set(key,{...row,address:row.address.toLowerCase()});
  }
  return {rows:[...byKey.values()].sort((a,b)=>a.address.localeCompare(b.address)||a.tsMs-b.tsMs),mismatches};
}

// Only older points feed Score.history; current month remains authoritative.
export function historyBefore(rows: HistoryRow[], address: string, monthStart: number): WindowHistory | null {
  const points=mergeHistory(rows.filter(r=>r.address.toLowerCase()===address.toLowerCase()&&r.tsMs<monthStart)).rows;
  return points.length<2 ? null : {accountValueHistory:points.map(r=>[r.tsMs,r.accountValue]),pnlHistory:points.map(r=>[r.tsMs,r.pnlAllTime])};
}
