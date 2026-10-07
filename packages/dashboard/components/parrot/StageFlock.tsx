"use client";
import { useEffect, useState } from "react";
import type { ChatResponse } from "../../lib/parrot";
import { diffWallets, updateWalletBoard, walletNickname, walletVibe, type WalletBoardState } from "../../lib/wallet-board";
import { WalletBird } from "./WalletBird";
import { Badge } from "./Badge";
import { CountUp, Pager } from "./StageBits";

export function StageFlock({ chat }: { chat: ChatResponse }) {
  const [state, setState] = useState<WalletBoardState>({ chat, before: [], ghosts: [], epoch: 1, labels: true });
  const [page, setPage] = useState(0);
  if (state.chat !== chat) { setState(updateWalletBoard(state, chat, Date.now())); setPage(0); }
  useEffect(() => {
    if (!state.ghosts.length) return;
    const timer = setTimeout(() => setState(s => ({ ...s, ghosts: s.ghosts.filter(g => g.expiresAt > Date.now()) })), Math.max(0, Math.min(...state.ghosts.map(g => g.expiresAt)) - Date.now()));
    return () => clearTimeout(timer);
  }, [state.ghosts]);
  const diff = diffWallets(state.before, chat.shortlist.addresses);
  const pages = Math.max(1, Math.ceil(chat.shortlist.addresses.length / 4));
  const current = Math.min(page, pages - 1);
  return <section className="stage-flock" aria-label="The Flock">
    <header className="flock-heading"><h2>THE FLOCK<span className="flock-count"><CountUp value={chat.shortlist.addresses.length} /></span></h2>
      {chat.shortlist.dataSource === "sample" && <Badge kind="SAMPLE DATA" />}</header>
    <div className="flock-changes" role="status"><span>+{diff.added.length} in</span><span>−{diff.removed.length} out</span></div>
    <div className="bird-wire">
      {chat.shortlist.addresses.slice(current * 4, current * 4 + 4).map(address => {
        const vibe = walletVibe(chat.evidence?.find(e => e.address === address));
        return <div key={address} className={`wire-bird ${diff.added.includes(address) ? "bird-joins" : ""}`} data-vibe={vibe}>
          <WalletBird vibe={vibe} /><b title={address}>{walletNickname(address)}</b>
          <span className="bird-meter" role="img" aria-label={`Mood and risk: ${vibe}`}><i /><i /><i /></span>
        </div>;
      })}
      {state.ghosts.slice(0, 4).map(g => <div key={g.address} className="bird-leaves" aria-label={`${walletNickname(g.address)} removed`}><WalletBird vibe={walletVibe(g.evidence?.find(e => e.address === g.address))} /></div>)}
    </div>
    {!chat.shortlist.addresses.length && <p role="status">No birds</p>}
    <Pager page={current} count={pages} onPage={setPage} label="birds" />
  </section>;
}
