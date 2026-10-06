import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { shortenAddress, type ChatResponse } from "../../lib/parrot";
import { barScale, changeSummary, diffWallets, reelSchedule } from "../../lib/wallet-board";
import { Badge } from "./Badge";
import { useParrotEffects } from "./ParrotEffects";

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
  useEffect(() => {
    const nodes = [...(board.current?.querySelectorAll<HTMLElement>(".wallet-current [data-metric]") ?? [])];
    const start = performance.now(); let frame = 0;
    const update = (now: number) => {
      const progress = quiet ? 1 : Math.min(1, Math.max(0, (now - start - 500) / 600));
      board.current?.style.setProperty("--count", String(progress));
      nodes.forEach(node => { node.textContent = `${(Number(node.dataset.metric) * progress).toFixed(1)}%`; });
      if (progress < 1) frame = requestAnimationFrame(update);
    };
    update(start);
    return () => { cancelAnimationFrame(frame); nodes.forEach(node => { node.textContent = `${Number(node.dataset.metric).toFixed(1)}%`; }); };
  }, [chat, quiet]);
  const rows = [...chat.shortlist.addresses.map(address => ({ address, out: false, evidence: chat.evidence,
    reason: chat.changes?.added.find(e => e.address === address)?.reason })), ...state.ghosts.map(g => ({ ...g, out: true }))];
  return <section className={`wallet-board ${quiet ? "is-calm" : ""} ${celebration?.animated ? "has-fever" : ""}`} aria-label="Wallet board">
    <header className="wallet-board-heading"><h2>Wallet board</h2><Badge kind={chat.shortlist.dataSource === "sample" ? "SAMPLE DATA" : "LIVE"} /></header>
    <div key={state.epoch} className="wallet-change-chip">{summary.chip}</div>
    <p className="sr-only" aria-live="polite">{summary.announcement}</p>
    <div ref={board} className="wallet-grid">
      {rows.map((row, i) => {
        const e = row.evidence?.find(e => e.address === row.address);
        const added = !row.out && state.labels && diff.added.includes(row.address);
        const reason = row.reason ?? e?.tags.join(" · ");
        const lock = reels[i]?.at ?? 0;
        return <div key={row.address} data-id={row.address} className={`wallet-position ${row.out ? "wallet-ghost" : "wallet-current"}`}>
          <article className={`wallet-card ${added ? "is-added" : ""} ${row.out ? "is-out" : ""}`} style={{ "--stagger": `${Math.min(i * 22, 220)}ms`, "--lock": `${lock}ms` } as CSSProperties}>
            <button type="button" className="wallet-face" aria-label={`${shortenAddress(row.address)}, ${row.out ? "out" : added ? "added" : "selected"}${e ? `, Score rank ${e.rank}` : ""}`} aria-describedby={`wallet-reason-${row.address}`} onClick={event => event.currentTarget.focus()}>
              <span className="wallet-id">{shortenAddress(row.address)}</span><span className="wallet-rank">{e ? `#${e.rank}` : "—"}</span>
              {!row.out && !quiet && <span key={state.epoch} className="wallet-reel" aria-hidden="true"><span>{[...chat.shortlist.addresses.slice(Math.max(0, i - 2), i + 1), row.address].map((id, n) => <b key={n}>{shortenAddress(id)}</b>)}</span></span>}
              <span className="wallet-state">{row.out ? "out" : added ? "added" : "selected"}</span>
              <span className="wallet-metrics">{([['Drawdown', e?.maxDrawdown, 1], ['Volatility', e?.annualisedVol, 1.5]] as const).map(([label, value, cap]) => <span key={label} className="wallet-metric" aria-label={`${label}: ${value == null ? "unavailable" : `${(value * 100).toFixed(1)} percent`}`}>
                <span>{label} <b aria-hidden="true" data-metric={value == null ? undefined : value * 100}>{value == null ? "—" : `${(value * 100).toFixed(1)}%`}</b></span>
                <i aria-hidden="true"><i style={{ "--bar": `${barScale(value ?? null, cap)}%` } as CSSProperties} /></i>
              </span>)}</span>
              <span className="wallet-tags">{e?.tags.slice(0, 2).map(tag => <span key={tag}>{tag}</span>) ?? <span>Metrics unavailable</span>}</span>
            </button>
            <span id={`wallet-reason-${row.address}`} className="wallet-reason" role="tooltip">{reason || "Metrics unavailable"}</span>
          </article>
        </div>;
      })}
    </div>
    {!rows.length && <p>No wallets selected.</p>}
  </section>;
}
