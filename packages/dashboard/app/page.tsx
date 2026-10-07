"use client";
import { useRef } from "react";
import "./lp.css";
import { ExposureBars, Funnel, Panel, PaperTable, RunStrip, StatTile, TargetsVsHeld, Waiting } from "../components/Charts";
import { Finalists } from "../components/Finalists";
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

// First word of a label, or the whole label when another series shares that first word.
const shortLabel = (label: string, all: string[]) => {
  const first = (l: string) => l.split(" ")[0];
  return all.filter((l) => first(l) === first(label)).length > 1 ? label : first(label);
};

const lastReturn = (series: Series[], id: string) => series.find((s) => s.id === id)?.points.at(-1)?.[1];

export default function Page() {
  const data = useDashboard();
  const dash = useRef<HTMLDivElement>(null);
  useDashMotion(dash, data !== null);
  const series = performanceSeries(data?.paper ?? null, data?.equity ?? null, data?.status ?? null);
  const finalists = data?.funnel?.finalists ?? [];
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

  return (
    <div className="lp">
      <ParrotSymbols />
      <ScrollBuddy />
      <Hero />
      <div className="lp-dash-wrap" ref={dash}>
        <DashHeader />
        <main id="live" className="lp-dash">
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
            {BUCKETS.map((k) => {
              const v = lastReturn(series, k.id);
              const note = k.id === "aggressive" && live ? `${executed} run${executed === 1 ? "" : "s"} executed` : bookNote(k.book);
              return <StatTile key={k.id} label={k.label} color={k.color} value={v === undefined ? "—" : pct(v)} count={count(v)} tone={tone(v)} note={note} />;
            })}
            <StatTile label="BTC" color="var(--muted)" reference value={btc === undefined ? "—" : pct(btc)} count={count(btc)} tone={tone(btc)} note="benchmark" />
          </div>

          <div className="mb-4">
            <Panel id="perf" tone={2} peek="right" title="Performance since start" meta={data?.paper?.lastRunAt ? time(data.paper.lastRunAt * 1000) : undefined}>
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

          <div className="mb-4 grid gap-4 md:grid-cols-2">
            {lastPlanned ? (
              <Panel tone={1} title="Targets vs held" meta={time(runTime(lastPlanned))}>
                <TargetsVsHeld run={lastPlanned} />
              </Panel>
            ) : (
              <Panel tone={1} title="Target exposures" meta={data?.exposures ? time(data.exposures.runAt * 1000) : undefined}>
                {data?.exposures?.exposures.length ? <ExposureBars exposures={data.exposures.exposures} /> : <Waiting what="No exposures yet" source="Computed from the latest run's snapshot" />}
              </Panel>
            )}
            <Panel tone={3} title="Heartbeat" meta="10 min">
              {data?.runs?.length ? <RunStrip runs={data.runs} /> : <Waiting what="No runs yet" source="executor /runs" />}
            </Panel>
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
            <Panel tone={3} title="Backtest vs BTC" meta={data?.backtest ? data.backtest.window : undefined}>
              {data?.backtest?.series.length ? (
                <LineChart
                  series={data.backtest.series.map((s, i) => ({
                    id: s.id,
                    label: s.label,
                    short: shortLabel(s.label, data.backtest!.series.map((x) => x.label)),
                    color: s.id === "btc" ? "var(--muted)" : `var(--series-${(i % 4) + 1})`,
                    reference: s.id === "btc",
                    points: s.points.map(([t, v]) => [t, (v - 1) * 100] as [number, number]),
                  }))}
                  format={(v) => pct(v, 1)}
                  xFormat={(t) => new Date(t).toLocaleDateString([], { month: "short", day: "numeric" })}
                  height={240}
                />
              ) : (
                <Waiting what="Backtest not published yet" source="dashboard_artifacts · backtest" />
              )}
            </Panel>
            <Panel tone={2} title="Selection funnel">
              {data?.funnel?.steps.length ? <Funnel steps={data.funnel.steps} /> : <Waiting what="Funnel not published yet" source="dashboard_artifacts · funnel" />}
            </Panel>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <Panel tone={1} title="Finalists" meta={finalists.length ? `${finalists.filter((f) => f.picked).length} / ${finalists.length}` : undefined}>
              {finalists.length ? <Finalists finalists={finalists} /> : <Waiting what="Finalists not published yet" source="dashboard_artifacts · funnel.finalists" />}
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
