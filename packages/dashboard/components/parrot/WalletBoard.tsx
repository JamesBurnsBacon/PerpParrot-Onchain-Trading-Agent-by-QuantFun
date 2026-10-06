import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { shortenAddress, type ChatResponse } from "../../lib/parrot";
import { changeSummary, diffWallets, reelSchedule, walletLabel, walletNickname, walletVibe } from "../../lib/wallet-board";
import type { WalletEvidence } from "../../../shared/wallet-evidence";
import { Badge } from "./Badge";
import { useParrotEffects } from "./ParrotEffects";
import { WalletBird } from "./WalletBird";

export function WaitingFlock() {
  return <section className="wallet-board wallet-waiting" aria-label="The Flock">
    <header className="wallet-board-heading"><h2>The Flock</h2><Badge kind="SAMPLE DATA" /></header>
    <p className="wallet-empty" role="status">Waiting for birds...</p>
  </section>;
}

export function WalletTile({ address, evidence, reason, change, quiet = false, index = 0, lock = 0, epoch = 0 }: {
  address: string; evidence?: WalletEvidence; reason?: string; change?: "new" | "removed";
  quiet?: boolean; index?: number; lock?: number; epoch?: number;
}) {
  const vibe = walletVibe(evidence), nickname = walletNickname(address);
  const metric = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? "unavailable" : `${Number((value * 100).toFixed(2))}%`;
  return <details className={`wallet-card ${quiet ? "is-quiet" : ""} ${change === "new" ? "is-added" : change === "removed" ? "is-out" : ""}`}
    data-vibe={vibe} style={{ "--stagger": `${Math.min(index * 22, 220)}ms`, "--lock": `${lock}ms` } as CSSProperties}>
    <summary className="wallet-face" aria-label={walletLabel(nickname, vibe, change)}>
      <span className="wallet-portrait">
        <WalletBird vibe={vibe} />
        {change === "new" && !quiet && <span key={epoch} className="wallet-reel" aria-hidden="true"><span>
          {(["wild", "calm", "steady"] as const).map(mood => <WalletBird key={mood} vibe={mood} />)}
        </span></span>}
      </span>
      <span className="wallet-nickname">{nickname}</span>
      <span className="wallet-id">{shortenAddress(address)}</span>
      <span className="wallet-risk" aria-hidden="true"><i /><i /><i /><b /></span>
      {change && <span className={`wallet-sticker ${change === "removed" ? "is-bye" : ""}`} aria-hidden="true">{change === "new" ? "NEW!" : "Bye!"}</span>}
    </summary>
    <div className="wallet-details">
      {evidence ? <>
        <p>Score rank: {evidence.rank}</p>
        <p>Drawdown: {metric(evidence.maxDrawdown)}</p>
        <p>Volatility: {metric(evidence.annualisedVol)}</p>
        {evidence.tags.length > 0 && <p>{evidence.tags.join(" · ")}</p>}
      </> : <p>Metrics unavailable</p>}
      {reason && <p>{reason}</p>}
    </div>
  </details>;
}

type Ghost = { expiresAt: number; address: string; evidence: ChatResponse["evidence"]; reason?: string };
export function WalletBoard({ chat }: { chat: ChatResponse }) {
  const { quiet, celebration } = useParrotEffects();
  const [state, setState] = useState(() => ({ chat, before: [] as string[], ghosts: [] as Ghost[], epoch: 1, labels: true }));
  // Preserve card identity across strategy revisions; only removed identities become ghosts.
  if (state.chat !== chat) {
    const diff = diffWallets(state.chat.shortlist.addresses, chat.shortlist.addresses);
    setState({ chat, before: state.chat.shortlist.addresses, epoch: state.epoch + 1, labels: true,
      ghosts: [...state.ghosts.filter(g => !chat.shortlist.addresses.includes(g.address)), ...diff.removed.map(address => ({
        address, expiresAt: Date.now() + 2500, evidence: state.chat.evidence, reason: chat.changes?.removed.find(e => e.address === address)?.reason,
      }))].slice(-25) });
  }
  const board = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const diff = diffWallets(state.before, chat.shortlist.addresses);
  const summary = changeSummary(diff.added.length, diff.removed.length);
  const reels = reelSchedule(chat.shortlist.addresses.length, quiet);
  useEffect(() => {
    const timer = setTimeout(() => setState(s => ({ ...s, labels: false })), 2500);
    return () => clearTimeout(timer);
  }, [chat]);
  useEffect(() => {
    if (!state.ghosts.length) return;
    const delay = Math.max(0, Math.min(...state.ghosts.map(g => g.expiresAt)) - Date.now());
    const timer = setTimeout(() => setState(s => ({ ...s, ghosts: s.ghosts.filter(g => g.expiresAt > Date.now()) })), delay);
    return () => clearTimeout(timer);
  }, [state.ghosts]);
  useLayoutEffect(() => {
    const frames: number[] = [];
    const nodes = [...(board.current?.querySelectorAll<HTMLElement>(".wallet-position") ?? [])];
    const next = new Map<string, { x: number; y: number }>();
    for (const node of nodes) {
      // offset coordinates ignore transforms from an interrupted prior FLIP.
      const current = { x: node.offsetLeft, y: node.offsetTop }, previous = positions.current.get(node.dataset.id!);
      next.set(node.dataset.id!, current);
      if (previous && !quiet) {
        node.style.transition = "none"; node.style.transform = `translate(${previous.x - current.x}px, ${previous.y - current.y}px)`;
        void node.offsetWidth;
        frames.push(requestAnimationFrame(() => { node.style.transition = "transform 480ms cubic-bezier(.2,.85,.3,1)"; node.style.transform = ""; }));
      } else { node.style.transform = ""; node.style.transition = ""; }
    }
    positions.current = next;
    return () => { frames.forEach(cancelAnimationFrame); nodes.forEach(n => { n.style.transform = ""; n.style.transition = ""; }); };
  }, [chat, state.ghosts, quiet]);
  const rows = [...chat.shortlist.addresses.map(address => ({ address, out: false, evidence: chat.evidence,
    reason: chat.changes?.added.find(e => e.address === address)?.reason })), ...state.ghosts.map(g => ({ ...g, out: true }))];
  return <section className={`wallet-board ${quiet ? "is-calm" : ""} ${celebration?.animated ? "has-fever" : ""}`} aria-label="The Flock">
    <header className="wallet-board-heading"><h2>The Flock</h2><Badge kind={chat.shortlist.dataSource === "sample" ? "SAMPLE DATA" : "LIVE"} /></header>
    <div key={state.epoch} className="wallet-change-chip">{summary.chip}</div>
    <p className="sr-only" aria-live="polite">{summary.announcement}</p>
    <div ref={board} className="wallet-grid">
      {rows.map((row, i) => {
        const e = row.evidence?.find(e => e.address === row.address);
        const added = !row.out && state.labels && diff.added.includes(row.address);
        const lock = reels[i]?.at ?? 0;
        return <div key={row.address} data-id={row.address} className={`wallet-position ${row.out ? "wallet-ghost" : "wallet-current"}`}>
          <WalletTile address={row.address} evidence={e} reason={row.reason} change={row.out ? "removed" : added ? "new" : undefined}
            quiet={quiet} index={i} lock={lock} epoch={state.epoch} />
        </div>;
      })}
    </div>
    {!rows.length && <p className="wallet-empty" role="status">Waiting for birds...</p>}
  </section>;
}
