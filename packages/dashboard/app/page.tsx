"use client";
import { useEffect, useState } from "react";
import { ExposureBars, Funnel, Panel, PaperTable, RunStrip, StatTile, TargetsVsHeld, Waiting } from "../components/Charts";
import { Finalists } from "../components/Finalists";
import { LineChart } from "../components/LineChart";
import { Pipeline } from "../components/Pipeline";
import { Roster } from "../components/Roster";
import { RunLog } from "../components/RunLog";
import { performanceSeries, pct, runTime, stamp, time, useDashboard, usd, type Series } from "../lib/data";

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  // ?theme=light|dark pins a mode (demo recordings, screenshots).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("theme");
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  // Resolved after mount so server and client render the same first frame.
  const [systemDark, setSystemDark] = useState(false);
  useEffect(() => {
    setSystemDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);
  const dark = theme ? theme === "dark" : systemDark;
  return (
    <button className="rounded-md px-2 py-1 text-xs" style={{ border: "1px solid var(--ring)", color: "var(--ink-2)" }} onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? "Light" : "Dark"}
    </button>
  );
}

function Pill({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs" style={{ border: "1px solid var(--ring)", color: "var(--ink-2)" }}>
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

// First word of a label, or the whole label when another series shares that first word.
const shortLabel = (label: string, all: string[]) => {
  const first = (l: string) => l.split(" ")[0];
  return all.filter((l) => first(l) === first(label)).length > 1 ? label : first(label);
};

const lastReturn = (series: Series[], id: string) => series.find((s) => s.id === id)?.points.at(-1)?.[1];

export default function Page() {
  const data = useDashboard();
  const series = performanceSeries(data?.paper ?? null, data?.equity ?? null);
  const lastRun = data?.runs?.filter((r) => r.kind === "mirror").sort((a, b) => b.startedAt - a.startedAt)[0];
  const finalists = data?.funnel?.finalists ?? [];
  // The newest executed run with a plan: targets vs held.
  const lastPlanned = data?.recent?.find((r) => r.kind === "mirror" && r.status === "executed" && r.plan);
  const live = lastReturn(series, "live");
  const paper470 = lastReturn(series, "aggressive-470");
  const twin = lastReturn(series, "aggressive-10k");
  const btc = lastReturn(series, "btc-hold");
  const book470 = data?.paper?.books.find((b) => b.id === "aggressive-470");
  const book10k = data?.paper?.books.find((b) => b.id === "aggressive-10k");
  const executed = data?.equity?.runs ?? 0;
  const tone = (v?: number) => (v === undefined || Math.abs(v) < 0.005 ? undefined : v > 0 ? "up" : "down");

  return (
    <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-xl font-semibold">PerpParrot 🦜</h1>
        {data?.status ? (
          <>
            <Pill color={data.status.dryRun ? "var(--warning)" : "var(--good)"}>{data.status.dryRun ? "Dry run" : "Live"}</Pill>
            <Pill color={data.status.controls.paused ? "var(--critical)" : "var(--good)"}>{data.status.controls.paused ? "Paused" : "Copying"}</Pill>
          </>
        ) : (
          <Pill color="var(--muted)">Executor offline</Pill>
        )}
        {lastRun && <Pill color="var(--series-1)">Last run {time(runTime(lastRun))}</Pill>}
        <ThemeToggle />
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Live account" value={live === undefined ? "—" : pct(live)} tone={tone(live)} note={executed ? `${executed} run${executed === 1 ? "" : "s"} executed${live === undefined ? " · no live trades yet" : ""}` : undefined} />
        <StatTile label="Paper · $470" value={paper470 === undefined ? "—" : pct(paper470)} tone={tone(paper470)} note={book470 ? `${book470.openPositions} positions · ${usd(book470.equityUsd)}` : undefined} />
        <StatTile label="Paper · $10k twin" value={twin === undefined ? "—" : pct(twin)} tone={tone(twin)} note={book10k ? `${book10k.openPositions} positions · ${usd(book10k.equityUsd)}` : undefined} />
        <StatTile label="BTC buy & hold" value={btc === undefined ? "—" : pct(btc)} tone={tone(btc)} note="benchmark" />
      </div>

      <div className="mb-4">
        <Panel title="Performance since start" meta={data?.paper?.lastRunAt ? `updated ${time(data.paper.lastRunAt * 1000)}` : undefined}>
          {series.length ? (
            <LineChart series={series} format={(v) => pct(v)} xFormat={stamp(series)} height={320} />
          ) : (
            <Waiting what="No runs yet" source="Curves start with the first mirror run" />
          )}
          {data?.paper?.books.length ? (
            <div className="mt-4">
              <PaperTable books={data.paper.books} series={series} />
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        {lastPlanned ? (
          <Panel title="Targets vs held" meta={`run ${time(runTime(lastPlanned))}${lastPlanned.dryRun ? " · dry run" : ""}`}>
            <TargetsVsHeld run={lastPlanned} />
          </Panel>
        ) : (
          <Panel title="Target exposures" meta={data?.exposures ? `run ${time(data.exposures.runAt * 1000)}` : undefined}>
            {data?.exposures?.exposures.length ? <ExposureBars exposures={data.exposures.exposures} /> : <Waiting what="No exposures yet" source="Computed from the latest run's snapshot" />}
          </Panel>
        )}
        <Panel title="Heartbeat" meta="one cell per 10-min run">
          {data?.runs?.length ? <RunStrip runs={data.runs} /> : <Waiting what="No runs yet" source="executor /runs" />}
        </Panel>
      </div>

      <div className="mb-4">
        <Panel title="Selection pipeline" meta="scan 12 h → refresh 5 min → qualify ~250 → pick 25 every 10 min → AI review → bench → roster">
          {data?.pipeline ? <Pipeline view={data.pipeline} /> : <Waiting what="Pipeline not running yet" source="backend /pipeline" />}
        </Panel>
      </div>

      <div className="mb-4">
        <Panel title="Roster" meta="per-wallet seats · tenure 12–72 h · exits free a seat · only a 50% trading loss removes">
          {data?.pipeline?.roster ? <Roster roster={data.pipeline.roster} /> : <Waiting what="Roster not running yet" source="backend /pipeline · roster" />}
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Backtest vs BTC" meta={data?.backtest ? data.backtest.window : "out of sample"}>
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
        <Panel title="Selection funnel" meta={data?.funnel?.steps.length ? `${data.funnel.steps[0].count.toLocaleString()} addresses → frozen set` : undefined}>
          {data?.funnel?.steps.length ? <Funnel steps={data.funnel.steps} /> : <Waiting what="Funnel not published yet" source="dashboard_artifacts · funnel" />}
        </Panel>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Panel title="Finalists" meta={finalists.length ? `${finalists.filter((f) => f.picked).length} of ${finalists.length} picked` : undefined}>
          {finalists.length ? <Finalists finalists={finalists} /> : <Waiting what="Finalists not published yet" source="dashboard_artifacts · funnel.finalists" />}
        </Panel>
        <Panel title="Run log" meta="what each run traded toward">
          {data?.recent?.some((r) => r.kind === "mirror") ? <RunLog runs={data.recent} /> : <Waiting what="No runs yet" source="executor /runs" />}
        </Panel>
      </div>
    </main>
  );
}
