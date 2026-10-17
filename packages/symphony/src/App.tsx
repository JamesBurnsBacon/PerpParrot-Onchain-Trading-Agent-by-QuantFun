import { SceneIdentityProvider } from "./art/SceneIdentity";
import "./styles.css";
import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Layers3,
  LoaderCircle,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Waves,
  X,
} from "lucide-react";
import { ConductorProvider } from "./art/ConductorProvider";
import { AmbientScore } from "./components/AmbientScore";
import { PortfolioScore } from "./components/PortfolioScore";
import { FeatherIdentity } from "./components/FeatherIdentity";
import { SignalCreature } from "./components/SignalCreature";
import { FlightStage } from "./components/FlightStage";
import "./components/parrotverse-system.css";
import { demoData, plan } from "./data";
import { composeSources } from "./data/composition";
import { useDashboard } from "./data/use-dashboard";
import type { DashboardSnapshot } from "./types";
type Tab = "sources" | "review" | "replay" | "evidence";
const tabs: { id: Tab; label: string }[] = [
  { id: "sources", label: "Sources" },
  { id: "review", label: "AI review" },
  { id: "replay", label: "Replay" },
  { id: "evidence", label: "Evidence" },
];
const money = (n: number) =>
  (n < 0 ? "−" : n > 0 ? "+" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 });
const direction = (n: number) => (n < 0 ? "short" : n > 0 ? "long" : "flat");
const signed = (n: number) =>
  (n < 0 ? "−" : "+") + Math.abs(n).toFixed(1) + "%";
const reviewCopy = {
  Role: [
    "Compose conviction, preserve accountability.",
    "Three sources contribute to BTC. ETH is composed from two long contributions and one offsetting short.",
    "Source weight is an allocation rule; a market target is signed equity exposure.",
  ],
  Risk: [
    "Evaluate the portfolio after netting.",
    "Illustrative source gross is 59%. Netted portfolio gross is 47%, below the configured 100% demo cap.",
    "Fees, liquidity, funding, concentration and source exits require real historical validation.",
  ],
  "Red-Team": [
    "Challenge the assumption before the target.",
    "What happens when one source becomes flat? Preserve other frozen contributions and reconcile the changed target.",
    "A preview is not an order. A planned delta is not a fill. Actual positions and market prices remain required.",
  ],
} as const;
function Brand() {
  return (
    <a className="brand" href="#top" aria-label="PerpParrot home">
      <svg width="26" height="30" viewBox="0 0 26 30" aria-hidden="true">
        <path
          d="M4 28L8 15C2 7 7 0 15 2C23 2 27 8 22 14L15 15L10 24Z"
          fill="#ffd52a"
        />
        <path d="M20 6L26 9L21 15L20 11Z" fill="#f58324" />
        <circle cx="17" cy="6" r="1.7" fill="#0b1218" />
      </svg>
      <span>
        PerpParrot<span className="brand-dot">.</span>
      </span>
    </a>
  );
}
function Curve({ days }: { days: number }) {
  const end = { 30: 8.4, 90: 17.2, 180: 24.6 }[days] ?? 8.4;
  let path = "";
  for (let i = 0; i <= 100; i++) {
    const t = i / 100,
      y =
        190 -
        t * (110 + days * 0.13) +
        Math.sin(t * (24 + days * 0.13)) * 12 +
        Math.sin(t * 73) * 5;
    path += (i ? "L" : "M") + t * 1000 + " " + y + " ";
  }
  return (
    <>
      <div className="replay-return">
        +{end}% <span>synthetic period return</span>
      </div>
      <svg
        className="equity-chart"
        viewBox="0 0 1000 240"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Synthetic ${days} day equity curve, modeled return ${end} percent`}
      >
        <defs>
          <linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#80e6ce" stopOpacity=".25" />
            <stop offset="1" stopColor="#80e6ce" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d="M0 50H1000M0 120H1000M0 190H1000" stroke="#293941" />
        <path d={path + "L1000 240L0 240Z"} fill="url(#chartFill)" />
        <path d={path} fill="none" stroke="#80e6ce" strokeWidth="2" />
      </svg>
      <div className="chart-labels">
        <span>Day 1 / $10,000 USD</span>
        <span>
          Day {days} / ${(10000 * (1 + end / 100)).toLocaleString("en-US")}
        </span>
      </div>
    </>
  );
}
export default function App() {
  const reduced = useReducedMotion(),
    [tab, setTab] = useState<Tab>(() => {
      const value = new URLSearchParams(location.search).get("tab");
      return tabs.some((t) => t.id === value) ? (value as Tab) : "sources";
    }),
    [search, setSearch] = useState(
      () => new URLSearchParams(location.search).get("q") ?? "",
    ),
    [risk, setRisk] = useState(
      () => new URLSearchParams(location.search).get("risk") ?? "all",
    ),
    [selected, setSelected] = useState("atlas"),
    [context, setContext] = useState<keyof typeof reviewCopy>("Role"),
    [period, setPeriod] = useState(30),
    [open, setOpen] = useState(false),
    [connectionOpen, setConnectionOpen] = useState(false),
    [backend, setBackend] = useState(""),
    [executor, setExecutor] = useState(""),
    [config, setConfig] = useState<{
      mode: "demo" | "live";
      backendUrl?: string;
      executorUrl?: string;
    }>({ mode: "demo" }),
    [motionPaused, setMotionPaused] = useState(false),
    [capital, setCapital] = useState(10000),
    [enabled, setEnabled] = useState(() => demoData.sources.map((s) => s.id)),
    [commandOpen, setCommandOpen] = useState(false),
    [commandSearch, setCommandSearch] = useState(""),
    [jsonOpen, setJsonOpen] = useState(false);
  const dashboard = useDashboard(config),
    snapshot: DashboardSnapshot =
      dashboard.data ??
      (config.mode === "demo"
        ? demoData
        : { mode: "live", loadedAt: "", sources: [], evidence: {} }),
    loading = dashboard.isFetching,
    loadError = dashboard.error instanceof Error ? dashboard.error.message : "";
  const opener = useRef<HTMLElement | null>(null),
    commandOpener = useRef<HTMLElement | null>(null),
    commandDestination = useRef<Tab | null>(null);
  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set("tab", tab);
    if (search) url.searchParams.set("q", search);
    else url.searchParams.delete("q");
    if (risk !== "all") url.searchParams.set("risk", risk);
    else url.searchParams.delete("risk");
    history.replaceState({}, "", url);
  }, [tab, search, risk]);

  const src = snapshot.sources,
    filtered = src.filter(
      (s) =>
        (s.name + " " + s.market)
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (risk === "all" || s.risk === risk),
    );
  const chosen =
    filtered.find((source) => source.id === selected) ?? filtered[0];
  const validCapital =
      Number.isFinite(capital) && capital >= 100 && capital <= 100000000,
    capitalBasis = validCapital ? capital : 10000;
  const composed = composeSources(
      src,
      src.filter((s) => !enabled.includes(s.id)).map((s) => s.id),
      capitalBasis,
    ),
    active = composed.activeSources,
    activeWeight = composed.activeWeight;
  const demo = snapshot.mode === "demo",
    btc = demo ? composed.netBTC : 0,
    eth = demo ? composed.netETH : 0,
    sourceGross = demo ? composed.sourceGross : 0,
    portfolioGross = demo ? composed.portfolioGross : 0;
  const previewPlan = {
    ...plan,
    allocationUsd: capitalBasis,
    modelEquityUsd: capitalBasis,
    sourceGrossPct: sourceGross,
    portfolioGrossPct: portfolioGross,
    enabledSourceIds: enabled,
    activeSourceWeightPct: activeWeight,
    weightsRenormalized: false,
    sources: plan.sources.filter((s) => enabled.includes(s.id)),
    orders: composed.orders,
    dispatched: false,
    fills: [],
  };
  const openPlan = () => {
    opener.current = document.activeElement as HTMLElement;
    setOpen(true);
  };
  function connect(mode: "demo" | "live") {
    if (
      mode === config.mode &&
      backend === config.backendUrl &&
      executor === config.executorUrl
    ) {
      void dashboard.refetch();
    } else setConfig({ mode, backendUrl: backend, executorUrl: executor });
  }
  const openCommand = () => {
    commandOpener.current = document.activeElement as HTMLElement;
    commandDestination.current = null;
    setCommandSearch("");
    setCommandOpen(true);
  };
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        commandOpener.current = document.activeElement as HTMLElement;
        commandDestination.current = null;
        setCommandSearch("");
        setCommandOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const jump = (destination: Tab) => {
    commandDestination.current = destination;
    setTab(destination);
    setCommandOpen(false);
    document.getElementById("workspace")?.scrollIntoView({
      behavior: reduced || motionPaused ? "instant" : "smooth",
    });
  };
  const selectSource = (id: string) => {
    setSelected(id);
    if (matchMedia("(max-width: 700px)").matches)
      setTimeout(
        () =>
          document.querySelector(".source-inspector")?.scrollIntoView({
            behavior: reduced || motionPaused ? "instant" : "smooth",
            block: "start",
          }),
        0,
      );
  };
  const commandItems = tabs.filter((t) =>
    t.label.toLowerCase().includes(commandSearch.toLowerCase()),
  );
  const review = reviewCopy[context];
  return (
    <MotionConfig reducedMotion="user">
      <ConductorProvider paused={motionPaused}>
        <SceneIdentityProvider
          sources={demo ? src : demoData.sources}
          selectedId={chosen?.id ?? selected}
          activeIds={demo ? enabled : []}
          demo={demo}
          paused={motionPaused}
          setPaused={setMotionPaused}
        >
          <div
            id="top"
            className={"app-shell" + (motionPaused ? " motion-paused" : "")}
          >
            <AmbientScore />
            <a className="skip-link" href="#workspace">
              Skip to workspace
            </a>
            <header className="site-header">
              <Brand />
              <nav aria-label="Main navigation">
                <a href="#workspace" onClick={() => setTab("sources")}>
                  Workspace
                </a>
                <a href="#workspace" onClick={() => setTab("review")}>
                  Intelligence
                </a>
                <a href="#workspace" onClick={() => setTab("evidence")}>
                  Evidence <ArrowUpRight size={12} />
                </a>
              </nav>
              <button
                className="command-trigger"
                aria-label="Open command palette, Command or Control K"
                onClick={openCommand}
              >
                <Search size={14} />
                <span>Jump to</span>
                <kbd>⌘ K</kbd>
              </button>
              <button
                className="demo-badge"
                onClick={() => setConnectionOpen(true)}
              >
                <CircleDot size={12} />
                {demo ? "Demo environment" : "Live endpoint review"}
                <ChevronRight size={12} />
              </button>
            </header>
            <main>
              <FlightStage
                onPlan={() => {
                  if (demo) openPlan();
                  else {
                    setTab("evidence");
                    document.getElementById("workspace")?.scrollIntoView({
                      behavior: reduced ? "instant" : "smooth",
                    });
                  }
                }}
                onMotionState={setMotionPaused}
              />
              <SignalCreature paused={motionPaused} />
              <PortfolioScore
                sources={demo ? src : demoData.sources}
                activeIds={
                  demo ? enabled : demoData.sources.map((source) => source.id)
                }
                selectedId={chosen?.id ?? selected}
                onSelect={(id) => {
                  setSearch("");
                  setRisk("all");
                  selectSource(id);
                  setTab("sources");
                }}
                onToggle={(id) => {
                  if (demo)
                    setEnabled((ids) =>
                      ids.includes(id)
                        ? ids.filter((value) => value !== id)
                        : [...ids, id],
                    );
                }}
                paused={motionPaused || !!reduced}
                onRehearse={(ids) => {
                  if (demo) setEnabled(ids);
                }}
                readOnly={!demo}
              />
              <section id="workspace" className="workspace">
                <aside className="strategy-rail">
                  <div className="rail-icon">
                    <Layers3 size={21} />
                  </div>
                  <span>
                    FORMATION
                    <br />
                    047
                  </span>
                  <div className="rail-line" />
                  <div className="rail-bottom">
                    REVIEW
                    <br />
                    BEFORE
                    <br />
                    EXECUTION
                  </div>
                </aside>
                <div className="workspace-content">
                  <div className="workspace-heading">
                    <div>
                      <span className="overline">
                        THE COMPOSITION WORKSPACE
                      </span>
                      <h2>
                        Your flock.
                        <br />
                        <span>Your flight plan.</span>
                      </h2>
                    </div>
                    <div className="workspace-meta">
                      <span className="tiny">
                        {demo ? "SYNTHETIC DATA" : "READ-ONLY ENDPOINT DATA"}
                      </span>
                      <p>
                        {demo
                          ? validCapital
                            ? "Model equity / $" +
                              capital.toLocaleString() +
                              " USD"
                            : "Enter valid model equity"
                          : "No funded action enabled"}
                      </p>
                      <button onClick={() => setConnectionOpen(true)}>
                        <SlidersHorizontal size={13} /> Environment
                      </button>
                    </div>
                  </div>
                  <div className="metric-strip">
                    <div>
                      <span>NET BTC TARGET</span>
                      <strong>
                        {demo && validCapital ? signed(btc) : "—"}
                        <small>
                          {demo && validCapital
                            ? money((btc * capitalBasis) / 100) +
                              " modeled " +
                              direction(btc)
                            : "Not available"}
                        </small>
                      </strong>
                    </div>
                    <div>
                      <span>NET ETH TARGET</span>
                      <strong>
                        {demo && validCapital ? signed(eth) : "—"}
                        <small>
                          {demo && validCapital
                            ? money((eth * capitalBasis) / 100) +
                              " modeled " +
                              direction(eth)
                            : "Not available"}
                        </small>
                      </strong>
                    </div>
                    <div>
                      <span>PORTFOLIO GROSS</span>
                      <strong className="white">
                        {demo ? portfolioGross.toFixed(0) + "%" : "—"}
                        <small>
                          {demo
                            ? sourceGross + "% source gross before netting"
                            : "Requires verified positions"}
                        </small>
                      </strong>
                    </div>
                    <div>
                      <span>SOURCE BASKET</span>
                      <strong className="white">
                        {demo ? active.length : src.length}
                        <small>
                          {demo
                            ? activeWeight +
                              "% active weight / no renormalization"
                            : "Only schema-valid sources"}
                        </small>
                      </strong>
                    </div>
                  </div>
                  <div className="workspace-nav">
                    <div
                      className="workspace-tabs"
                      role="tablist"
                      aria-label="Workspace views"
                    >
                      {tabs.map((t, i) => (
                        <button
                          key={t.id}
                          id={"tab-" + t.id}
                          role="tab"
                          aria-selected={tab === t.id}
                          aria-controls={"panel-" + t.id}
                          tabIndex={tab === t.id ? 0 : -1}
                          onClick={() => setTab(t.id)}
                          onKeyDown={(e) => {
                            let next: number | undefined;
                            if (e.key === "ArrowRight")
                              next = (i + 1) % tabs.length;
                            if (e.key === "ArrowLeft")
                              next = (i + tabs.length - 1) % tabs.length;
                            if (e.key === "Home") next = 0;
                            if (e.key === "End") next = tabs.length - 1;
                            if (next !== undefined) {
                              e.preventDefault();
                              setTab(tabs[next].id);
                              document
                                .getElementById("tab-" + tabs[next].id)
                                ?.focus();
                            }
                          }}
                        >
                          {t.label}
                          {tab === t.id && <span className="tab-dot" />}
                        </button>
                      ))}
                    </div>
                    <span className="readonly">
                      <ShieldCheck size={12} /> Read only
                    </span>
                  </div>
                  {loading && (
                    <div className="loading-state" role="status">
                      <LoaderCircle size={20} className="spin" /> Fetching
                      endpoint evidence…
                    </div>
                  )}
                  {loadError && (
                    <div className="notice error" role="alert">
                      <CircleAlert size={16} />
                      {loadError}
                      <button onClick={() => connect(snapshot.mode)}>
                        Retry
                      </button>
                    </div>
                  )}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                      key={tab}
                      id={"panel-" + tab}
                      role="tabpanel"
                      aria-labelledby={"tab-" + tab}
                      initial={reduced || motionPaused ? false : { opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: motionPaused ? 0 : 0.16 }}
                    >
                      {tab === "sources" && (
                        <div className="source-workspace">
                          <section className="source-ledger">
                            <div className="panel-heading">
                              <div>
                                <h3>Source radar</h3>
                                <p>
                                  {demo
                                    ? "30-day synthetic metrics. Weights differ from exposure."
                                    : "Endpoint evidence must supply source metrics to populate this table."}
                                </p>
                              </div>
                              <span className="tiny">
                                {demo ? "SYNTHETIC" : "NO FIXTURE FALLBACK"}
                              </span>
                            </div>
                            <div className="source-toolbar">
                              <label className="search-input">
                                <Search size={15} />
                                <input
                                  value={search}
                                  onChange={(e) => setSearch(e.target.value)}
                                  aria-label="Search sources"
                                  placeholder="Find a source or market…"
                                />
                              </label>
                              <select
                                value={risk}
                                onChange={(e) => setRisk(e.target.value)}
                                aria-label="Source risk filter"
                              >
                                <option value="all">All risk levels</option>
                                <option>Low</option>
                                <option>Medium</option>
                                <option>High</option>
                              </select>
                              <span
                                className="results-count"
                                aria-live="polite"
                              >
                                {filtered.length} results
                              </span>
                            </div>
                            <p className="table-scroll-hint">
                              Scroll the ledger sideways to see every metric ↔
                            </p>
                            <div
                              className="table-scroll"
                              tabIndex={0}
                              role="region"
                              aria-label="Synthetic source metrics; scroll horizontally if needed"
                            >
                              <table>
                                <thead>
                                  <tr>
                                    <th>Source / market</th>
                                    <th>30d return</th>
                                    <th>Drawdown</th>
                                    <th>Weight</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {filtered.map((s, i) => (
                                    <tr
                                      key={s.id}
                                      className={
                                        chosen?.id === s.id ? "selected" : ""
                                      }
                                    >
                                      <td>
                                        <button
                                          className="source-select"
                                          aria-pressed={chosen?.id === s.id}
                                          onClick={() => selectSource(s.id)}
                                        >
                                          <span
                                            className={
                                              "source-avatar avatar-" + i
                                            }
                                          >
                                            <FeatherIdentity
                                              id={s.id}
                                              index={src.findIndex(
                                                (source) => source.id === s.id,
                                              )}
                                            />
                                          </span>
                                          <span>
                                            <strong>{s.name}</strong>
                                            <small>
                                              {s.market} / {s.risk} risk
                                              {demo && !enabled.includes(s.id)
                                                ? " / Excluded"
                                                : ""}
                                            </small>
                                          </span>
                                          {chosen?.id === s.id && (
                                            <ChevronRight
                                              size={15}
                                              className="source-chevron"
                                            />
                                          )}
                                        </button>
                                      </td>
                                      <td className="mint">
                                        +{s.return30d.toFixed(1)}%
                                      </td>
                                      <td>{s.drawdown.toFixed(1)}%</td>
                                      <td>{s.weight}%</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                            {!filtered.length && (
                              <div className="empty-state">
                                <Search size={22} />
                                <h4>
                                  {demo
                                    ? "No matching sources"
                                    : "No compatible source metrics"}
                                </h4>
                                <p>
                                  {demo
                                    ? "Clear your search or try another risk level."
                                    : "Live responses are preserved in Evidence. Synthetic sources are never substituted."}
                                </p>
                                <button
                                  className="button outline"
                                  onClick={() => {
                                    if (demo) {
                                      setSearch("");
                                      setRisk("all");
                                    } else setTab("evidence");
                                  }}
                                >
                                  {demo
                                    ? "Reset filters"
                                    : "Inspect endpoint evidence"}
                                  <ArrowRight size={14} />
                                </button>
                              </div>
                            )}
                            <div className="ledger-footer">
                              <span>
                                <span className="status-dot" />{" "}
                                {demo
                                  ? "Frozen synthetic source snapshot"
                                  : "Read-only endpoint snapshot"}
                              </span>
                              <span>
                                Select a source <ArrowUpRight size={12} />
                              </span>
                            </div>
                          </section>
                          <aside className="source-inspector">
                            {chosen ? (
                              <>
                                <div className="inspector-overline">
                                  <span>SELECTED SOURCE</span>
                                  <span className="risk-tag">
                                    {chosen.risk} risk
                                  </span>
                                </div>
                                <div className="inspector-title">
                                  <h3>{chosen.name}</h3>
                                  <div className="source-monogram">
                                    <FeatherIdentity
                                      id={chosen.id}
                                      index={src.findIndex(
                                        (source) => source.id === chosen.id,
                                      )}
                                    />
                                  </div>
                                </div>
                                <p className="inspector-description">
                                  {chosen.description}
                                </p>
                                {demo && (
                                  <label className="include-source">
                                    <span>
                                      Include in preview
                                      <small>
                                        Frozen contribution / preview only
                                      </small>
                                    </span>
                                    <input
                                      type="checkbox"
                                      checked={enabled.includes(chosen.id)}
                                      onChange={(e) =>
                                        setEnabled((ids) =>
                                          e.target.checked
                                            ? [...ids, chosen.id]
                                            : ids.filter(
                                                (id) => id !== chosen.id,
                                              ),
                                        )
                                      }
                                    />
                                  </label>
                                )}
                                <div className="weight-display">
                                  <span>Basket weight</span>
                                  <strong>
                                    {chosen.weight}
                                    <small>%</small>
                                  </strong>
                                </div>
                                <div className="allocation-track">
                                  <motion.div
                                    animate={{ width: chosen.weight + "%" }}
                                    transition={{
                                      duration:
                                        reduced || motionPaused ? 0 : 0.4,
                                    }}
                                  />
                                </div>
                                <div className="contribution-heading">
                                  Frozen contribution / equity exposure
                                </div>
                                <div className="contribution-row">
                                  <span>
                                    <span className="coin btc">₿</span> Bitcoin{" "}
                                    <small>BTC</small>
                                  </span>
                                  <strong
                                    className={
                                      chosen.btc < 0 ? "coral" : "mint"
                                    }
                                  >
                                    {signed(chosen.btc)}
                                  </strong>
                                </div>
                                <div className="contribution-row">
                                  <span>
                                    <span className="coin eth">◆</span> Ethereum{" "}
                                    <small>ETH</small>
                                  </span>
                                  <strong
                                    className={
                                      chosen.eth < 0 ? "coral" : "mint"
                                    }
                                  >
                                    {signed(chosen.eth)}
                                  </strong>
                                </div>
                                <div className="inspector-note">
                                  <ShieldCheck size={15} />
                                  <span>
                                    A source’s weight and contribution describe
                                    different quantities.
                                  </span>
                                </div>
                                <button
                                  className="button yellow"
                                  disabled={!demo}
                                  onClick={openPlan}
                                >
                                  Inspect combined target{" "}
                                  <ArrowUpRight size={16} />
                                </button>
                              </>
                            ) : (
                              <div className="inspector-empty">
                                <Layers3 size={28} />
                                <h3>
                                  {demo
                                    ? "Choose a source."
                                    : "Evidence comes first."}
                                </h3>
                                <p>
                                  {demo
                                    ? "Clear your filters or choose a source to inspect its contribution."
                                    : "Review endpoint responses before interpreting a position."}
                                </p>
                              </div>
                            )}
                          </aside>
                        </div>
                      )}
                      {tab === "review" && !demo && (
                        <div className="empty-state">
                          <ShieldCheck size={24} />
                          <h4>No verified AI review loaded.</h4>
                          <p>
                            Demo reviews are authored examples. Inspect live
                            endpoint evidence for actual service responses.
                          </p>
                          <button
                            className="button outline"
                            onClick={() => setTab("evidence")}
                          >
                            Inspect endpoint evidence
                          </button>
                        </div>
                      )}
                      {tab === "review" && demo && (
                        <section className="review-panel">
                          <div className="panel-heading">
                            <div>
                              <h3>
                                Three lenses.
                                <br />
                                <em>One accountable decision.</em>
                              </h3>
                              <p>
                                Authored illustrative reviews, not actual model
                                responses.
                              </p>
                            </div>
                            <Sparkles size={25} />
                          </div>
                          <div
                            className="review-controls"
                            role="group"
                            aria-label="Review context"
                          >
                            {(
                              Object.keys(
                                reviewCopy,
                              ) as (keyof typeof reviewCopy)[]
                            ).map((c) => (
                              <button
                                key={c}
                                aria-pressed={context === c}
                                onClick={() => setContext(c)}
                              >
                                {c}
                              </button>
                            ))}
                          </div>
                          <div className="review-body">
                            <span className="overline">
                              {context} / DEMONSTRATION CONTEXT
                            </span>
                            <h4>{review[0]}</h4>
                            <p>
                              {context === "Risk"
                                ? `Current preview source gross is ${sourceGross}%. Netted portfolio gross is ${portfolioGross}%, below the configured 100% demo cap.`
                                : context === "Role"
                                  ? `${active.filter((s) => s.btc !== 0).length} active sources contribute to BTC; ${active.filter((s) => s.eth > 0).length} long and ${active.filter((s) => s.eth < 0).length} short sources contribute to ETH.`
                                  : review[1]}
                            </p>
                            <p>{review[2]}</p>
                          </div>
                          <div className="notice">
                            <CircleAlert size={15} /> These reviews demonstrate
                            specialist contexts. They do not establish
                            independent provider consensus.
                          </div>
                        </section>
                      )}
                      {tab === "replay" && !demo && (
                        <div className="empty-state">
                          <Waves size={24} />
                          <h4>No verified replay dataset loaded.</h4>
                          <p>
                            Live mode does not substitute the synthetic
                            demonstration curve.
                          </p>
                          <button
                            className="button outline"
                            onClick={() => setTab("evidence")}
                          >
                            Inspect endpoint evidence
                          </button>
                        </div>
                      )}
                      {tab === "replay" && demo && (
                        <section className="replay-panel">
                          <div className="panel-heading">
                            <div>
                              <h3>Replay the formation.</h3>
                              <p>
                                Synthetic baseline / USD / no market dataset.
                                Independent of source preview exclusions.
                              </p>
                            </div>
                            <div
                              className="period-controls"
                              role="group"
                              aria-label="Chart period"
                            >
                              {[30, 90, 180].map((n) => (
                                <button
                                  key={n}
                                  aria-pressed={period === n}
                                  onClick={() => setPeriod(n)}
                                >
                                  {n}D
                                </button>
                              ))}
                            </div>
                          </div>
                          <Curve days={period} />
                          <div className="replay-next">
                            <Waves size={23} />
                            <div>
                              <strong>
                                Next: validate against the real market.
                              </strong>
                              <p>
                                Replay historical positions with fees, slippage,
                                funding and source exits. No backtest has been
                                performed.
                              </p>
                            </div>
                            <span className="tiny">PROPOSED VALIDATION</span>
                          </div>
                        </section>
                      )}
                      {tab === "evidence" && (
                        <section className="evidence-panel">
                          <div className="panel-heading">
                            <div>
                              <h3>Evidence before execution.</h3>
                              <p>
                                {demo
                                  ? "Synthetic preview fixture PP-047. No funded dispatch or deployment verified."
                                  : "Actual read-only endpoint responses. Availability does not verify execution."}
                              </p>
                            </div>
                            <button
                              className="icon-button"
                              aria-label="Refresh evidence"
                              disabled={loading}
                              onClick={() => connect(snapshot.mode)}
                            >
                              <RefreshCw size={17} />
                            </button>
                          </div>
                          {demo ? (
                            <>
                              <div className="evidence-row">
                                <span>Mode / provenance</span>
                                <strong>
                                  Synthetic demo / authored fixture
                                </strong>
                              </div>
                              <div className="evidence-row">
                                <span>Signed market target</span>
                                <strong className="mint">
                                  BTC {signed(btc)} / ETH {signed(eth)}
                                </strong>
                              </div>
                              <div className="evidence-row">
                                <span>Portfolio gross cap</span>
                                <strong>
                                  {portfolioGross}% ≤ 100% modeled cap
                                </strong>
                              </div>
                              <div className="evidence-row">
                                <span>Dispatch / fills</span>
                                <strong className="orange">
                                  Not dispatched / 0 fills
                                </strong>
                              </div>
                              <div className="evidence-row">
                                <span>Next required evidence</span>
                                <strong>
                                  Historical replay and dry-run reconciliation
                                </strong>
                              </div>
                              <button
                                className="button yellow"
                                onClick={openPlan}
                              >
                                Inspect preview plan <ArrowUpRight size={15} />
                              </button>
                            </>
                          ) : (
                            <>
                              <div className="notice">
                                <ShieldCheck size={15} /> Endpoint availability
                                is transport evidence. Paper returns are
                                modeled; records marked executed in dry-run mode
                                do not establish funded fills. Inspect each
                                response’s status and mode.
                              </div>
                              <div className="endpoint-grid">
                                {Object.entries(snapshot.evidence).map(
                                  ([name, result]) => (
                                    <details key={name} className="endpoint">
                                      <summary>
                                        <span>{name}</span>
                                        <span
                                          className={
                                            result.status === "available"
                                              ? "mint"
                                              : "coral"
                                          }
                                        >
                                          {result.status === "available" ? (
                                            <Check size={13} />
                                          ) : (
                                            <CircleAlert size={13} />
                                          )}{" "}
                                          {result.status}
                                        </span>
                                      </summary>
                                      {result.status === "available" ? (
                                        <pre>
                                          {JSON.stringify(result.data, null, 2)}
                                        </pre>
                                      ) : (
                                        <p>
                                          {result.error}
                                          <br />
                                          Check service URL and CORS access,
                                          then retry.
                                        </p>
                                      )}
                                    </details>
                                  ),
                                )}
                              </div>
                              <div className="endpoint-actions">
                                <button
                                  className="button outline"
                                  onClick={() => setConnectionOpen(true)}
                                >
                                  Configure endpoints
                                </button>
                                <button
                                  className="button outline"
                                  disabled={loading}
                                  onClick={() => dashboard.refetch()}
                                >
                                  Retry evidence <RefreshCw size={13} />
                                </button>
                              </div>
                              {!Object.keys(snapshot.evidence).length &&
                                !loading && (
                                  <div className="empty-state">
                                    <CircleAlert size={24} />
                                    <h4>No endpoint evidence loaded.</h4>
                                    <p>
                                      Configure your service URLs and retry.
                                    </p>
                                    <button
                                      className="button outline"
                                      onClick={() => setConnectionOpen(true)}
                                    >
                                      Configure endpoints
                                    </button>
                                  </div>
                                )}
                            </>
                          )}
                        </section>
                      )}
                    </motion.div>
                  </AnimatePresence>
                  <div className="workspace-bottom">
                    <ShieldCheck size={13} />
                    <span>
                      {demo
                        ? "All portfolio values are illustrative. Planned targets are not orders or fills."
                        : "Live mode reads endpoint evidence only. No trading actions are available."}
                    </span>
                    <time
                      className="snapshot-time"
                      dateTime={snapshot.loadedAt}
                    >
                      {snapshot.loadedAt
                        ? (demo ? "Fixture timestamp " : "Fetched ") +
                          new Date(snapshot.loadedAt).toLocaleString("en-SG", {
                            timeZone: "Asia/Singapore",
                            hour12: false,
                          }) +
                          " SGT"
                        : "Not fetched"}
                    </time>
                  </div>
                </div>
              </section>
              <section className="closing">
                <div>
                  <span className="overline">THE DECISION STAYS WITH YOU</span>
                  <h2>
                    Instinct,
                    <br />
                    <em>with a flight plan.</em>
                  </h2>
                </div>
                <a href="#workspace" className="closing-link">
                  Compose your formation <ArrowUpRight size={36} />
                </a>
              </section>
            </main>
            <footer className="site-footer">
              <Brand />
              <span>Original generative identity / Design study 047</span>
              <span>Read-only prototype · No wallet connection</span>
            </footer>
          </div>
          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content
                className="plan-dialog"
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  opener.current?.focus();
                }}
              >
                <div className="dialog-heading">
                  <div>
                    <span className="overline">PP-047 / SYNTHETIC PREVIEW</span>
                    <Dialog.Title>Inspect the plan.</Dialog.Title>
                  </div>
                  <Dialog.Close
                    className="icon-button"
                    aria-label="Close preview plan"
                  >
                    <X size={20} />
                  </Dialog.Close>
                </div>
                <Dialog.Description className="dialog-description">
                  A composed target for review. Nothing is sent to an exchange.
                </Dialog.Description>
                <div className="notice">
                  <ShieldCheck size={15} /> Planned targets only. No orders,
                  fills or funded dispatch.
                </div>
                <label className="capital-control">
                  Model equity / USD
                  <input
                    type="number"
                    min="100"
                    max="100000000"
                    step="100"
                    value={capital}
                    aria-describedby="capital-help"
                    onChange={(e) => setCapital(Number(e.target.value))}
                  />
                </label>
                <p className="tiny" id="capital-help">
                  Illustrative sizing only. No prices or actual account
                  positions.
                </p>
                {(!Number.isFinite(capital) ||
                  capital < 100 ||
                  capital > 100000000) && (
                  <p className="capital-validation" role="status">
                    Enter model equity between $100 and $100,000,000 to inspect
                    the preview.
                  </p>
                )}
                {validCapital && (
                  <>
                    <div className="plan-target">
                      <span>BTC / MODELED {direction(btc).toUpperCase()}</span>
                      <strong>
                        {validCapital ? money((capitalBasis * btc) / 100) : "—"}
                        <small>{signed(btc)} of model equity</small>
                      </strong>
                    </div>
                    <div className="plan-target">
                      <span>ETH / MODELED {direction(eth).toUpperCase()}</span>
                      <strong>
                        {validCapital ? money((capitalBasis * eth) / 100) : "—"}
                        <small>{signed(eth)} of model equity</small>
                      </strong>
                    </div>
                    <div className="plan-cap">
                      <span>Source gross (pre-net)</span>
                      <strong>{sourceGross}%</strong>
                    </div>
                    <div className="plan-cap">
                      <span>Netted portfolio gross / cap</span>
                      <strong>{portfolioGross}% / 100%</strong>
                    </div>
                    <p className="tiny plan-explanation">
                      Delta orders require actual positions and market prices.
                      Source gross sums absolute source contributions; portfolio
                      gross sums absolute net market targets.
                    </p>
                    <details
                      className="plan-json"
                      open={jsonOpen}
                      onToggle={(e) => setJsonOpen(e.currentTarget.open)}
                    >
                      <summary>Inspect synthetic fixture JSON</summary>
                      {validCapital ? (
                        <pre>{JSON.stringify(previewPlan, null, 2)}</pre>
                      ) : (
                        <p role="status">
                          Enter valid model equity to inspect the preview.
                        </p>
                      )}
                    </details>
                  </>
                )}
                <button
                  className="button yellow"
                  disabled={
                    !Number.isFinite(capital) ||
                    capital < 100 ||
                    capital > 100000000
                  }
                  onClick={() => setJsonOpen(true)}
                >
                  Inspect synthetic JSON <ChevronRight size={16} />
                </button>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Dialog.Root open={connectionOpen} onOpenChange={setConnectionOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="connection-dialog">
                <div className="dialog-heading">
                  <Dialog.Title>Choose the evidence.</Dialog.Title>
                  <Dialog.Close
                    className="icon-button"
                    aria-label="Close environment settings"
                  >
                    <X size={20} />
                  </Dialog.Close>
                </div>
                <Dialog.Description>
                  Demo fixtures and live endpoint evidence remain separate. This
                  application cannot place trades.
                </Dialog.Description>
                <div className="connection-demo">
                  <span>
                    <CircleDot size={16} /> Synthetic demo
                  </span>
                  <button
                    className="button outline"
                    onClick={() => {
                      connect("demo");
                      setConnectionOpen(false);
                    }}
                  >
                    Use demo
                  </button>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    setConnectionOpen(false);
                    setTab("evidence");
                    connect("live");
                  }}
                >
                  <label>
                    Backend service URL
                    <input
                      type="url"
                      name="backend-url"
                      autoComplete="url"
                      required
                      value={backend}
                      onChange={(e) => setBackend(e.target.value)}
                      placeholder="https://your-backend.example"
                    />
                  </label>
                  <label>
                    Executor service URL
                    <input
                      type="url"
                      name="executor-url"
                      autoComplete="url"
                      value={executor}
                      onChange={(e) => setExecutor(e.target.value)}
                      placeholder="https://your-executor.example"
                    />
                  </label>
                  <p className="tiny">
                    Read-only requests. Blank executor uses current-origin
                    /api/executor. Failed responses never receive synthetic
                    fallback data.
                  </p>
                  <button className="button yellow" type="submit">
                    Read endpoint evidence <ArrowRight size={15} />
                  </button>
                </form>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
          <Dialog.Root open={commandOpen} onOpenChange={setCommandOpen}>
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content
                className="command-dialog"
                onCloseAutoFocus={(e) => {
                  e.preventDefault();
                  if (commandDestination.current)
                    document
                      .getElementById("tab-" + commandDestination.current)
                      ?.focus();
                  else commandOpener.current?.focus();
                }}
              >
                <Dialog.Title className="sr-only">
                  Jump to a workspace view
                </Dialog.Title>
                <Dialog.Description className="sr-only">
                  Find a view, inspect a plan or search synthetic sources.
                </Dialog.Description>
                <div className="command-search">
                  <Search size={20} />
                  <input
                    autoFocus
                    aria-label="Search commands or source names"
                    placeholder="Where shall we go?"
                    value={commandSearch}
                    onChange={(e) => setCommandSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && commandItems.length)
                        jump(commandItems[0].id);
                      else if (e.key === "Enter" && demo && commandSearch) {
                        setSearch(commandSearch);
                        jump("sources");
                      }
                    }}
                  />
                  <Dialog.Close
                    className="icon-button"
                    aria-label="Close command palette"
                  >
                    <X size={17} />
                  </Dialog.Close>
                </div>
                <div className="command-results">
                  {commandItems.map((t) => (
                    <button key={t.id} onClick={() => jump(t.id)}>
                      <span>{t.label}</span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                  {demo && (
                    <button
                      onClick={() => {
                        setCommandOpen(false);
                        setTimeout(() => {
                          opener.current = commandOpener.current;
                          setOpen(true);
                        }, 0);
                      }}
                    >
                      <span>Inspect synthetic plan</span>
                      <ShieldCheck size={16} />
                    </button>
                  )}
                  {demo && commandSearch && (
                    <button
                      onClick={() => {
                        setSearch(commandSearch);
                        jump("sources");
                      }}
                    >
                      <span>Search sources for “{commandSearch}”</span>
                      <Search size={16} />
                    </button>
                  )}
                </div>
                <div className="command-foot">
                  <span>Tab to navigate · Enter to open</span>
                  <span>Esc to close</span>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </SceneIdentityProvider>
      </ConductorProvider>
    </MotionConfig>
  );
}
