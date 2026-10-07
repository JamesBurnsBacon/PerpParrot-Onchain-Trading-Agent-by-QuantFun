"use client";
import { RELATIONS, type Decision } from "../../../shared/receipt";
import type { Verdict } from "../../lib/parrot-receipts";
function Bar({ name, value }: { name: string; value?: number }) {
  return <div className="receipt-bar"><span>{name}</span><strong>{value === undefined ? "—" : `${(value * 100).toFixed(1)}%`}</strong>
    <meter aria-label={name} min={0} max={1} value={value ?? 0} /></div>;
}
export function DecisionsLens({ verdict, live, cached, roundTrip }: { verdict?: Verdict; live?: Decision; cached: boolean; roundTrip?: number }) {
  return <aside className="decisions-lens" aria-label="Decisions Lens">
    <h2>Decisions Lens</h2><p className="receipt-api">OpenAI Decisions API · {live?.model ?? "gpt-6-luna"} · beta</p>
    <p>{cached ? "cached, no API call · hand-authored numbers" : live ? "API result · grounding against this receipt" : "Awaiting a call · no result yet"}</p>
    <Bar name="states_a_fact" value={live?.statesAFact} />
    <Bar name="supported_by_facts" value={verdict?.supported} />
    <h3>relation</h3>{RELATIONS.map(r => <Bar key={r} name={r} value={verdict?.relationProbabilities[r]} />)}
    <p>Round trip: {live ? `${roundTrip?.toFixed(0)} ms` : "—"} · Server: {live ? `${live.latencyMs} ms` : "—"}</p>
    <p>Input tokens: {live?.usage.inputTokens ?? "—"} · Estimated cost: {live ? `$${live.costUsd.toFixed(8)}` : "—"}</p>
    <details><summary>Show the call</summary>{live ? <>
      <p>POST https://api.openai.com/v1/decisions · JSON bodies only</p>
      <h3>Request</h3><pre>{JSON.stringify(live.request, null, 2)}</pre>
      <h3>Response</h3><pre>{JSON.stringify(live.response, null, 2)}</pre>
    </> : <p>{cached ? "Cached illustration: no request or response to show." : "Judge a sentence to see the exact request and response."}</p>}</details>
  </aside>;
}
