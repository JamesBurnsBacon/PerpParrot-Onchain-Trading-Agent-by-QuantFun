"use client";
import { useEffect, useState, type CSSProperties } from "react";
import type { ChatResponse } from "../../lib/parrot";
import { diffWallets, updateWalletBoard, walletNickname, walletVibe, type WalletBoardState } from "../../lib/wallet-board";
import { WalletBird } from "./WalletBird";
import { Badge } from "./Badge";
import { CountUp } from "./StageBits";

// What kind of wallet is this, at a glance: how far it fell (red-yellow-green) and how much it made, as symbols and numbers only.
const pct = (v: number | null | undefined) => {
  if (v == null || !Number.isFinite(v)) return "—";
  const x = Math.abs(v * 100);
  return x >= 99_500 ? ">99k%" : x >= 1000 ? `${Math.round(x / 1000)}k%` : x >= 10 ? `${Math.round(x)}%` : `${x.toFixed(1)}%`;
};
function BirdStats({ evidence }: { evidence?: { maxDrawdown: number | null; periodReturn?: number | null } }) {
  const dd = evidence?.maxDrawdown, ret = evidence?.periodReturn;
  const ddLevel = dd == null ? "none" : dd < 0.05 ? "low" : dd < 0.12 ? "mid" : "high";
  const retLevel = ret == null ? "none" : ret >= 0 ? "up" : "down";
  return <span className="bird-stats" aria-label={`Max drawdown ${pct(dd)}, period return ${ret != null && ret < 0 ? "minus " : ""}${pct(ret)}`}>
    <b className="stat-dd" data-level={ddLevel} title="Biggest fall from a peak (smaller is steadier)"><i aria-hidden="true">▼</i>{pct(dd)}</b>
    <b className="stat-ret" data-level={retLevel} title="Return over the period measured"><i aria-hidden="true">{ret != null && ret < 0 ? "▼" : "▲"}</i>{ret != null && ret < 0 ? "−" : ""}{pct(ret)}</b>
  </span>;
}

export function StageFlock({ chat }: { chat: ChatResponse }) {
  const [state, setState] = useState<WalletBoardState>({ chat, before: [], ghosts: [], epoch: 1, labels: true });
  if (state.chat !== chat) setState(updateWalletBoard(state, chat, Date.now()));
  useEffect(() => {
    if (!state.ghosts.length) return;
    const timer = setTimeout(() => setState(s => ({ ...s, ghosts: s.ghosts.filter(g => g.expiresAt > Date.now()) })), Math.max(0, Math.min(...state.ghosts.map(g => g.expiresAt)) - Date.now()));
    return () => clearTimeout(timer);
  }, [state.ghosts]);
  const diff = diffWallets(state.before, chat.shortlist.addresses);
  // Every bird is on screen at once: the grid grows in rows (and the birds shrink) instead of paging.
  const count = chat.shortlist.addresses.length;
  const rows = count <= 6 ? 1 : count <= 12 ? 2 : count <= 18 ? 3 : 4;
  const cols = Math.max(1, Math.ceil(count / rows));
  return <section className="stage-flock" aria-label="The Flock">
    <header className="flock-heading"><h2>THE FLOCK<span className="flock-count"><CountUp value={chat.shortlist.addresses.length} /></span></h2>
      {chat.shortlist.dataSource === "sample" && <Badge kind="SAMPLE DATA" />}</header>
    <div className="flock-changes" role="status"><span>+{diff.added.length} in</span><span>−{diff.removed.length} out</span><span className="flock-legend" aria-hidden="true"><b className="stat-dd" data-level="high">▼</b> fall <b className="stat-ret" data-level="up">▲</b> gain</span></div>
    <div className="bird-wire" data-rows={rows} style={{ "--cols": cols, "--rows": rows } as CSSProperties}>
      {chat.shortlist.addresses.map(address => {
        const vibe = walletVibe(chat.evidence?.find(e => e.address === address));
        return <div key={address} className={`wire-bird ${diff.added.includes(address) ? "bird-joins" : ""}`} data-vibe={vibe}>
          <WalletBird vibe={vibe} /><b title={address}>{walletNickname(address)}</b>
          <BirdStats evidence={chat.evidence?.find(e => e.address === address)} />
        </div>;
      })}
    </div>
    <div className="bird-ghosts">{state.ghosts.slice(0, 4).map(g => <div key={g.address} className="bird-leaves" aria-label={`${walletNickname(g.address)} removed`}><WalletBird vibe={walletVibe(g.evidence?.find(e => e.address === g.address))} /></div>)}</div>
    {!chat.shortlist.addresses.length && <p role="status">No birds</p>}
  </section>;
}
