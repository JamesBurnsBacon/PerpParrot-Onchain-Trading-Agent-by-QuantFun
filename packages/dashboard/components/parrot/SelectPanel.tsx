import { useEffect, useState } from "react";
import { Panel, StatTile } from "../Charts";
import { clampBanner, intentChips, type ChatResponse } from "../../lib/parrot";
import { WalletBoard } from "./WalletBoard";

export function SelectPanel({ chat, onVerify }: { chat: ChatResponse; demo: boolean; onVerify: () => void }) {
  const banner = clampBanner(chat.policy.clamps);
  const [flash, setFlash] = useState({ chat, chips: intentChips(chat.intent), banner: !!banner });
  if (flash.chat !== chat) setFlash({ chat, chips: intentChips(chat.intent).filter(chip => !intentChips(flash.chat.intent).includes(chip)),
    banner: banner !== clampBanner(flash.chat.policy.clamps) });
  useEffect(() => {
    const timer = setTimeout(() => setFlash(s => ({ ...s, chips: [], banner: false })), 1000);
    return () => clearTimeout(timer);
  }, [chat]);
  return (
    <div className="space-y-4">
      <WalletBoard chat={chat} />
      <Panel title="Your intent, bounded by code" meta={<span className="parrot-eyebrow">01 / SELECT</span>}>
        <div className="flex flex-wrap gap-2">{intentChips(chat.intent).map(chip => <span className={`parrot-chip ${flash.chips.includes(chip) ? "parrot-policy-flash" : ""}`} key={chip}>{chip}</span>)}</div>
        {banner && <div key={banner} className={`parrot-clamp mt-4 ${flash.banner ? "parrot-policy-flash" : ""}`} role="status"><span className="parrot-eyebrow">THE POLICY HAS THE FINAL SAY</span><p className="mt-2 text-lg font-extrabold">{banner}</p></div>}
        <details className="parrot-details mt-4"><summary>Policy details</summary>
        {chat.policy.changes.length > 0 && <ul className="mt-4 space-y-2 text-sm" aria-label="Policy changes">{chat.policy.changes.map((change, i) => <li key={i} className="break-words"><strong>{change.field}</strong>: {change.from} → {change.to}</li>)}</ul>}
        {chat.policy.notes.length > 0 && <ul className="mt-3 list-inside list-disc space-y-1 text-sm" style={{ color: "var(--ink-2)" }}>{chat.policy.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
        <details className="parrot-details mt-3"><summary>Show what the model returned</summary><pre>{JSON.stringify(chat.intent, null, 2)}</pre></details>
        </details>
      </Panel>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Shortlisted sources" value={String(chat.shortlist.addresses.length)} note="Selected by code" />
        <StatTile label="Effective source limit" value={String(chat.policy.effectiveMaxSources)} note="After policy checks" />
      </div>
      <button className="parrot-button parrot-button--primary w-full" onClick={onVerify}>Inspect the evidence <span aria-hidden="true">→</span></button>
    </div>
  );
}
