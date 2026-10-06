import { useState } from "react";
import { Panel, StatTile } from "../Charts";
import { clampBanner, intentChips, shortenAddress, type ChatResponse } from "../../lib/parrot";
import { Badge } from "./Badge";

export function SelectPanel({ chat, demo, onVerify }: { chat: ChatResponse; demo: boolean; onVerify: () => void }) {
  const [copyStatus, setCopyStatus] = useState("");
  const banner = clampBanner(chat.policy.clamps);
  async function copy(address: string) {
    try { await navigator.clipboard.writeText(address); setCopyStatus(`Copied ${shortenAddress(address)}`); }
    catch { setCopyStatus("Copy unavailable. Select the full address shown below."); }
  }
  return (
    <div className="space-y-4">
      <Panel title="Your intent, bounded by code" meta={<span className="parrot-eyebrow">01 / SELECT</span>}>
        <div className="flex flex-wrap gap-2">{intentChips(chat.intent).map(chip => <span className="parrot-chip" key={chip}>{chip}</span>)}</div>
        {banner && <div className="parrot-clamp mt-4" role="status"><span className="parrot-eyebrow">THE POLICY HAS THE FINAL SAY</span><p className="mt-2 text-lg font-extrabold">{banner}</p></div>}
        <details className="parrot-details mt-4"><summary>Show what the model returned</summary><pre>{JSON.stringify(chat.intent, null, 2)}</pre></details>
        {chat.policy.changes.length > 0 && <ul className="mt-4 space-y-2 text-sm" aria-label="Policy changes">{chat.policy.changes.map((change, i) => <li key={i} className="break-words"><strong>{change.field}</strong>: {change.from} → {change.to}</li>)}</ul>}
        {chat.policy.notes.length > 0 && <ul className="mt-3 list-inside list-disc space-y-1 text-sm" style={{ color: "var(--ink-2)" }}>{chat.policy.notes.map((note, i) => <li key={i}>{note}</li>)}</ul>}
      </Panel>
      <div className="grid grid-cols-2 gap-3">
        <StatTile label="Shortlisted sources" value={String(chat.shortlist.addresses.length)} note="Selected by code" />
        <StatTile label="Effective source limit" value={String(chat.policy.effectiveMaxSources)} note="After policy checks" />
      </div>
      <Panel title="The wallet shortlist" meta={<Badge kind={demo ? "CACHED DEMO" : chat.shortlist.dataSource === "sample" ? "SAMPLE DATA" : "LIVE"} />}>
        {chat.shortlist.addresses.length ? <div className="max-h-72 overflow-auto"><table className="w-full text-left text-sm">
          <caption className="sr-only">Wallet addresses selected by code</caption>
          <thead style={{ color: "var(--ink-2)" }}><tr><th className="pb-2 font-medium">Wallet</th><th className="pb-2 text-right font-medium">Copy address</th></tr></thead>
          <tbody>{chat.shortlist.addresses.map((address, i) => <tr key={`${address}-${i}`} style={{ borderTop: "1px solid var(--ring)" }}>
            <td className="py-2 font-mono" title={address}>{shortenAddress(address)}</td>
            <td className="py-2 text-right"><button className="parrot-button parrot-button--small" aria-label={`Copy address ${address}`} onClick={() => void copy(address)}>Copy</button></td>
          </tr>)}</tbody>
        </table></div> : <p className="text-sm">No wallets were shortlisted. Try broader preferences.</p>}
        <p role="status" className="mt-2 text-xs" style={{ color: "var(--ink-2)" }}>{copyStatus}</p>
        {copyStatus.startsWith("Copy unavailable") && <pre className="mt-2 whitespace-pre-wrap break-all text-xs">{chat.shortlist.addresses.join("\n")}</pre>}
      </Panel>
      <button className="parrot-button parrot-button--primary w-full" onClick={onVerify}>Inspect the evidence <span aria-hidden="true">→</span></button>
    </div>
  );
}
