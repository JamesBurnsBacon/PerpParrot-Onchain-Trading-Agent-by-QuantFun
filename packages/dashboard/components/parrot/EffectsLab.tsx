// Development-only effects overlay loaded by the Parrot page with fx=1.
// Use synthetic presets only; keep this module outside production bundles.
import { PARROT_PRESETS, type ParrotPreset } from "../../lib/parrot-presets";
import { labPresets } from "../../lib/parrot-lab-fixtures";
import type { EffectEvent } from "../../lib/wallet-board";
import { useParrotEffects } from "./ParrotEffects";
import { buildBacktest, buildRunStatus, buildWallet, type LiveCard } from "../../lib/parrot-reads";

// Clamp and solo building blocks are lab auditions, not product policy changes.
// It is rendered only when the page is opened with ?fx=1 outside production (see page.tsx).
const SOUNDS: { label: string; event: EffectEvent; count?: number; removed?: number; clamped?: boolean }[] = [
  { label: "Start whistle", event: "start" }, { label: "Bubble in", event: "in" }, { label: "Pop out", event: "out" },
  { label: "Strategy set: bubble + ticks + sprinkle (6)", event: "strategy", count: 6 },
  { label: "Strategy set (12 wallets, 4 out)", event: "strategy", count: 12, removed: 4 },
  { label: "Clamp nope", event: "clamp", clamped: true }, { label: "LOCKED IN: ta-da brass", event: "lock" },
];

// Synthetic inputs run through the real builders, so the lab shows exactly what the read tools would put on screen.
const DAY = 86_400_000, NOW = Date.now(), WALLET = `0x${"ab".repeat(20)}`;
const LAB_CARDS: { label: string; card: () => LiveCard }[] = [
  { label: "Run log card", card: () => buildRunStatus({ status: { dryRun: true, account: "0xlab", controls: { paused: false }, lastRunAt: NOW }, exposures: { runAt: NOW, exposures: [{ asset: "BTC", fraction: 0.31 }, { asset: "ETH", fraction: -0.12 }, { asset: "SOL", fraction: 0.08 }] },
      runs: [0, 1, 2, 3].map(i => ({ id: `r${i}`, runId: `mirror-${Math.floor((NOW - i * 600_000) / 1000)}`, kind: "mirror" as const, status: i === 2 ? "failed" as const : "executed" as const, dryRun: true, startedAt: NOW - i * 600_000, finishedAt: NOW - i * 600_000 + 4000, equityUsd: 470 + i,
        plan: { orders: Array.from({ length: 3 - (i % 3) }, () => ({ asset: "BTC", isBuy: true, notionalUsd: 12, targetUsd: 30, currentUsd: 18 })), skipped: [] }, evidence: { snapshotHash: `0x${(0xabcdef12 + i).toString(16)}${"0".repeat(56)}`, configurationHash: "0xcfg", exposures: [] } })) }).card },
  { label: "Wallet card", card: () => buildWallet({ ref: "1", shown: [WALLET], evidence: [{ address: WALLET, rank: 3, maxDrawdown: 0.041, realizedVol: 0.012, tags: ["low drawdown"], sharpe: 1.9 }],
      funnel: { generatedAt: NOW, steps: [], finalists: [{ address: WALLET, kind: "trader", score: 2.41, picked: true, rationale: "Steady edge with shallow drawdowns; positions copy cleanly at our size." }] }, pipeline: null }).card },
  { label: "Backtest card", card: () => buildBacktest({ generatedAt: NOW, window: "1 month", series: [
      { id: "agent", label: "Agent picks", points: Array.from({ length: 12 }, (_, i) => [NOW - (11 - i) * 2.5 * DAY, 1 + i * 0.012 + (i % 3) * 0.004] as [number, number]) },
      { id: "btc", label: "BTC", points: Array.from({ length: 12 }, (_, i) => [NOW - (11 - i) * 2.5 * DAY, 1 + i * 0.004 - (i % 4) * 0.003] as [number, number]) }] }).card },
  { label: "Unavailable card", card: () => buildRunStatus({ runs: null, status: null, exposures: null }).card },
];

export function EffectsLab({ onPreset, onLock, onReset, onCard }: { onPreset: (preset: ParrotPreset) => void; onLock: () => void; onReset: () => void; onCard?: (card: LiveCard | null) => void }) {
  const fx = useParrotEffects();
  const play = async (s: (typeof SOUNDS)[number]) => { await fx.sfx.unlock(); fx.sfx.play(s.event, s.count ?? 1, s.removed ?? 0, s.clamped ?? false); };
  const showBanner = async (kind: "strategy" | "clamp" | "lock") => { await fx.sfx.unlock(); fx.trigger(kind, 8, 3, kind === "clamp"); };
  return <aside className="fx-lab" aria-label="Effects lab (development only)">
    <strong>Effects lab <small>dev only</small></strong>
    <p>Big swaps (watch the flock, reels and banners; switch between them):</p>
    <div>{labPresets.map(preset => <button type="button" key={preset.id} onClick={() => { void fx.sfx.unlock(); onPreset(preset); }}>{preset.label}</button>)}</div>
    <p>Cached demo strategies:</p>
    <div>{PARROT_PRESETS.map(preset => <button type="button" key={preset.id} onClick={() => { void fx.sfx.unlock(); onPreset(preset); }}>{preset.label}</button>)}</div>
    <div><button type="button" onClick={onLock}>Lock request</button><button type="button" onClick={onReset}>Reset</button></div>
    {onCard && <><p>Read-tool cards (what the parrot puts on screen from the Dashboard):</p>
    <div>{LAB_CARDS.map(c => <button type="button" key={c.label} onClick={() => onCard(c.card())}>{c.label}</button>)}<button type="button" onClick={() => onCard(null)}>Clear card</button></div></>}
    <p>Banners only:</p>
    <div><button type="button" onClick={() => void showBanner("strategy")}>STRATEGY SET</button><button type="button" onClick={() => void showBanner("clamp")}>BOUNDED BY CODE</button><button type="button" onClick={() => void showBanner("lock")}>LOCKED IN</button></div>
    <p>Building blocks:</p>
    <div>{(["cracker", "cymbal", "applause"] as const).map(name => <button type="button" key={name} onClick={async () => { await fx.sfx.unlock(); fx.sfx.solo(name); }}>{name[0].toUpperCase() + name.slice(1)}</button>)}</div>
    <p>Sounds only:</p>
    <div>{SOUNDS.map(s => <button type="button" key={s.label} onClick={() => void play(s)}>{s.label}</button>)}</div>
    <p>Motion: <button type="button" onClick={fx.toggleCalm}>{fx.calm ? "Calm on (no motion)" : "Calm off (full motion)"}</button> Sound: <button type="button" onClick={fx.toggleSound}>{fx.sound ? "on" : "off"}</button></p>
  </aside>;
}
