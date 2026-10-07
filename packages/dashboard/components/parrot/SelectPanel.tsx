import { useEffect, useState } from "react";
import { Panel, StatTile } from "../Charts";
import { intentChips, type ChatResponse } from "../../lib/parrot";
import { WalletBoard } from "./WalletBoard";

export function SelectPanel({ chat, onVerify }: { chat: ChatResponse; demo: boolean; onVerify: () => void }) {
  const [flash, setFlash] = useState({ chat, chips: intentChips(chat.intent) });
  if (flash.chat !== chat) setFlash({ chat, chips: intentChips(chat.intent).filter(chip => !intentChips(flash.chat.intent).includes(chip)) });
  useEffect(() => {
    const timer = setTimeout(() => setFlash(s => ({ ...s, chips: [] })), 1000);
    return () => clearTimeout(timer);
  }, [chat]);
  return (
    <div className="space-y-4">
      <WalletBoard chat={chat} />
      <Panel title="Your wallet preferences" meta={<span className="parrot-eyebrow">01 / SELECT</span>}>
        <div className="flex flex-wrap gap-2">{intentChips(chat.intent).map(chip => <span className={`parrot-chip ${flash.chips.includes(chip) ? "parrot-policy-flash" : ""}`} key={chip}>{chip}</span>)}</div>
        <p className="mt-3 text-sm">Simulation preview. An operator must review and freeze.</p>
        <details className="parrot-details mt-3"><summary>Show what the model returned</summary><pre>{JSON.stringify(chat.intent, null, 2)}</pre></details>
      </Panel>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Shortlisted sources" value={String(chat.shortlist.addresses.length)} note="Selected by code" />
        <StatTile label="Source limit" value={String(chat.policy.maxSources)} note="Your chosen maximum" />
      </div>
      <button className="parrot-button parrot-button--primary w-full" onClick={onVerify}>Inspect the evidence <span aria-hidden="true">→</span></button>
    </div>
  );
}
