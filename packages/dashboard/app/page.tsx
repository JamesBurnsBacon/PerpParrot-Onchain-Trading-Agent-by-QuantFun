"use client";
import { useRef } from "react";
import "./lp.css";
import { ExposureBars, Panel, PaperTable, RunStrip, StatTile, TargetsVsHeld, Waiting } from "../components/Charts";
import { LineChart } from "../components/LineChart";
import { DashHeader } from "../components/lp/DashHeader";
import { Hero } from "../components/lp/Hero";
import { Parrot, ParrotSymbols } from "../components/lp/ParrotSymbols";
import { ScrollBuddy } from "../components/lp/ScrollBuddy";
import { useDashMotion } from "../components/lp/useDashMotion";
import { Pipeline } from "../components/Pipeline";
import { Roster } from "../components/Roster";
import { RunLog } from "../components/RunLog";
import { BUCKETS, liveIsReal, performanceSeries, pct, runTime, stamp, time, useDashboard, usd, type Series } from "../lib/data";

const lastReturn = (series: Series[], id: string) => series.find((s) => s.id === id)?.points.at(-1)?.[1];

export default function Page() {
  const data = useDashboard();
  const dash = useRef<HTMLDivElement>(null);
  useDashMotion(dash, data !== null);
  const series = performanceSeries(data?.paper ?? null, data?.equity ?? null, data?.status ?? null);
  // The newest executed run with a plan: targets vs held.
  const lastPlanned = data?.recent?.find((r) => r.kind === "mirror" && r.status === "executed" && r.plan);
  const btc = lastReturn(series, "btc");
  const live = liveIsReal(data?.status ?? null, data?.equity ?? null);
  const executed = data?.equity?.runs ?? 0;
  const bookNote = (id: string) => {
    const b = data?.paper?.books.find((x) => x.id === id);
    return b ? `${b.openPositions} positions · ${usd(b.equityUsd)}` : undefined;
  };
  const tone = (v?: number) => (v === undefined || Math.abs(v) < 0.005 ? undefined : v > 0 ? "up" : "down");
  const count = (v?: number) => (v === undefined ? undefined : { value: v, format: (n: number) => pct(n) });
  // Normal operation shows no status; only an abnormal executor state is surfaced in the header.
  const alert = data === null ? undefined : !data.status ? "Executor offline" : data.status.controls.paused ? "Paused" : undefined;
  // Where a bucket's numbers come from: the live account, the Aggressive paper model, or the modeled twins.
  const origin = (id: string) => (id === "aggressive" ? (live ? "" : "paper · ") : "modeled · ");

  return (
    <div className="lp">
      <ParrotSymbols />
      <ScrollBuddy />
      <Hero />
      <div className="lp-dash-wrap" ref={dash}>
        <DashHeader alert={alert} />
        <main id="live" className="lp-dash">
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {BUCKETS.map((k) => {
              const v = lastReturn(series, k.id);
              const booked = bookNote(k.book);
              const note = k.id === "aggressive" && live ? `${executed} run${executed === 1 ? "" : "s"} executed` : booked && `${origin(k.id)}${booked}`;
              return <StatTile key={k.id} label={k.label} color={k.color} value={v === undefined ? "—" : pct(v)} count={count(v)} tone={tone(v)} note={note} />;
            })}
            <StatTile label="BTC" color="var(--muted)" reference value={btc === undefined ? "—" : pct(btc)} count={count(btc)} tone={tone(btc)} note="benchmark" />
          </div>

          <div className="mb-4">
            <Panel id="perf" tone={2} peek="right" title="Portfolio Performance" meta={data?.paper?.lastRunAt ? time(data.paper.lastRunAt * 1000) : undefined}>
              {series.length ? (
                <LineChart series={series} format={(v) => pct(v)} xFormat={stamp(series)} height={320} />
              ) : (
                <Waiting what="No runs yet" source="Curves start with the first mirror run" />
              )}
              {series.some((s) => s.bookId) && data?.paper ? (
                <div className="mt-4">
                  <PaperTable books={data.paper.books} series={series} />
                </div>
              ) : null}
            </Panel>
          </div>

          <div className="mb-4">
            {lastPlanned ? (
              <Panel tone={1} title="Targets vs held" meta={time(runTime(lastPlanned))}>
                <TargetsVsHeld run={lastPlanned} />
              </Panel>
            ) : (
              <Panel tone={1} title="Target exposures" meta={data?.exposures ? time(data.exposures.runAt * 1000) : undefined}>
                {data?.exposures?.exposures.length ? <ExposureBars exposures={data.exposures.exposures} /> : <Waiting what="No exposures yet" source="Computed from the latest run's snapshot" />}
              </Panel>
            )}
          </div>

          <div className="mb-4">
            <Panel id="pipeline" tone={4} title="Selection pipeline">
              {data?.pipeline ? <Pipeline view={data.pipeline} /> : <Waiting what="Pipeline not running yet" source="backend /pipeline" />}
            </Panel>
          </div>

          <div className="mb-4">
            <Panel id="roster" tone={5} peek="left" title="Roster">
              {data?.pipeline?.roster ? <Roster roster={data.pipeline.roster} /> : <Waiting what="Roster not running yet" source="backend /pipeline · roster" />}
            </Panel>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Panel tone={3} title="Heartbeat" meta="10 min">
              {data?.runs?.length ? <RunStrip runs={data.runs} /> : <Waiting what="No runs yet" source="executor /runs" />}
            </Panel>
            <Panel tone={2} title="Run log">
              {data?.recent?.some((r) => r.kind === "mirror") ? <RunLog runs={data.recent} /> : <Waiting what="No runs yet" source="executor /runs" />}
            </Panel>
          </div>
        </main>
        <footer className="lp-foot">
          {data?.status?.dryRun ? "Dry run · " : ""}Perpetuals carry liquidation risk · Not investment advice
          <div className="lp-foot-brand">
            <Parrot />
            <b>PerpParrot</b>
          </div>
        </footer>
      </div>
    </div>
  );
}
