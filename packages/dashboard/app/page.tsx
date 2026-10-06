"use client";
import { useEffect, useState } from "react";
import { ExposureBars, Funnel, Panel, RunStrip, StatTile, Waiting } from "../components/Charts";
import { LineChart } from "../components/LineChart";
import { performanceSeries, pct, time, useDashboard, usd, type Series } from "../lib/data";

function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
  }, [theme]);
  const dark = theme ? theme === "dark" : typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
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

const lastReturn = (series: Series[], id: string) => series.find((s) => s.id === id)?.points.at(-1)?.[1];

export default function Page() {
  const data = useDashboard();
  const series = performanceSeries(data?.paper ?? null, data?.runs ?? null);
  const lastRun = data?.runs?.filter((r) => r.kind === "report").sort((a, b) => b.startedAt - a.startedAt)[0];
  const live = lastReturn(series, "live");
  const paper470 = lastReturn(series, "aggressive-470");
  const twin = lastReturn(series, "aggressive-10k");
  const btc = lastReturn(series, "btc-hold");
  const book470 = data?.paper?.books.find((b) => b.id === "aggressive-470");
  const book10k = data?.paper?.books.find((b) => b.id === "aggressive-10k");
  const tone = (v?: number) => (v === undefined ? undefined : v >= 0 ? "up" : "down");

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
        {lastRun && <Pill color="var(--series-1)">Last CRE run {time(lastRun.startedAt)}</Pill>}
        <ThemeToggle />
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Live account" value={live === undefined ? "—" : pct(live)} delta={data?.runs?.length ? `${data.runs.filter((r) => r.status === "executed").length} CRE runs` : undefined} tone={tone(live)} />
        <StatTile label="Paper · $470" value={paper470 === undefined ? "—" : pct(paper470)} delta={book470 ? `${book470.openPositions} positions · ${usd(book470.equityUsd)}` : undefined} tone={tone(paper470)} />
        <StatTile label="Paper · $10k twin" value={twin === undefined ? "—" : pct(twin)} delta={book10k ? `${book10k.openPositions} positions · ${usd(book10k.equityUsd)}` : undefined} tone={tone(twin)} />
        <StatTile label="BTC buy & hold" value={btc === undefined ? "—" : pct(btc)} delta="benchmark" />
      </div>

      <div className="mb-4">
        <Panel title="Performance since start" meta={data?.paper?.lastRunAt ? `updated ${time(data.paper.lastRunAt * 1000)}` : undefined}>
          {series.length ? (
            <LineChart series={series} format={(v) => pct(v)} xFormat={time} height={320} />
          ) : (
            <Waiting what="No runs yet" source="Curves start with the first mirror run" />
          )}
        </Panel>
      </div>

      <div className="mb-4 grid gap-4 md:grid-cols-2">
        <Panel title="What we hold now" meta={data?.exposures ? `run ${time(data.exposures.runAt * 1000)}` : undefined}>
          {data?.exposures?.exposures.length ? <ExposureBars exposures={data.exposures.exposures} /> : <Waiting what="No exposures yet" source="From the latest DON-agreed snapshot" />}
        </Panel>
        <Panel title="CRE heartbeat" meta="one cell per 10-min run">
          {data?.runs?.length ? <RunStrip runs={data.runs} /> : <Waiting what="No CRE runs yet" source="executor /runs" />}
        </Panel>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Backtest vs BTC" meta={data?.backtest ? data.backtest.window : "out of sample"}>
          {data?.backtest?.series.length ? (
            <LineChart
              series={data.backtest.series.map((s, i) => ({
                id: s.id,
                label: s.label,
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
        <Panel title="From 47k addresses to the frozen set">
          {data?.funnel?.steps.length ? <Funnel steps={data.funnel.steps} /> : <Waiting what="Funnel not published yet" source="dashboard_artifacts · funnel" />}
        </Panel>
      </div>
    </main>
  );
}
