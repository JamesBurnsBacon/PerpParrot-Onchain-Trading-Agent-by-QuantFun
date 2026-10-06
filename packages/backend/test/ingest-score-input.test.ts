import { expect, test } from "bun:test";
import { orderEvidence, toScoreInput } from "../src/ingest/score-input";
import type { Candidate, CollectionRecord } from "../src/ingest/types";
const address = "0x0000000000000000000000000000000000000001";
test("counts distinct filled orders, rejects future/zero/invalid fills, and preserves unknown under 10", () => {
  const fills = Array.from({length:10}, (_,oid) => ({coin:"BTC",oid,time:1000,sz:"1"}));
  expect(orderEvidence([...fills,...fills],2000)).toEqual({observed:10,tradeCount:10});
  expect(orderEvidence(fills.slice(0,9),2000)).toEqual({observed:9,tradeCount:null});
  expect(orderEvidence([{coin:"BTC",oid:1,time:3000,sz:"1"},{coin:"BTC",oid:2,time:1000,sz:"0"}],2000).observed).toBe(0);
  expect(orderEvidence(null,2000)).toEqual({observed:null,tradeCount:null});
});
test("adapter maps candidate funding separately from portfolio returns and preserves unknown ERC closure", () => {
  const c: Candidate = {address,accountValueOrTvlUsd:"99999",valueSource:"leaderboard-account-value",sources:["leaderboard"],name:null,knownHypercoreVault:false,leaderAddress:null};
  const record: CollectionRecord = {address,classification:{kind:"erc4626-vault",evidence:"erc4626-probes"},classificationError:null,portfolio:null,portfolioError:null};
  const raw = ["month","allTime"].map(k=>[k,{accountValueHistory:[[1000,"10000"],[2000,"12000"]],pnlHistory:[[1000,"0"],[2000,"2000"]]}]);
  const input=toScoreInput(c,record,raw)!;
  expect(input.accountValue).toBe(99999);expect(input.month!.accountValueHistory.at(-1)![1]).toBe(12000);
  expect(input.closed).toBeNull();expect(input.history).toBeNull();expect(input.tradeCount).toBeNull();
  expect(toScoreInput(c,{...record,classification:null},raw)).toBeNull();
  expect(()=>toScoreInput(c,{...record,address:"0x0000000000000000000000000000000000000002"},raw)).toThrow("address mismatch");
});

test("partial executions do not inflate minTrades; order identity includes the coin", () => {
  const partials = Array.from({ length: 20 }, (_, i) => ({ coin: "BTC", oid: 1, time: 1000 + i, sz: "0.1" }));
  expect(orderEvidence(partials, 2000)).toEqual({ observed: 1, tradeCount: null });
  expect(orderEvidence([...partials, { coin: "ETH", oid: 1, time: 1000, sz: "1" }], 2000))
    .toEqual({ observed: 2, tradeCount: null });
});
