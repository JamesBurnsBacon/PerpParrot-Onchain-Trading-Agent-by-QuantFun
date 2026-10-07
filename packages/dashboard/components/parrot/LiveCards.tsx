"use client";
// Code-built facts only. No executor actions; the confirmation callback still saves a pending request.
import type { CSSProperties } from "react";
import { ordersOf } from "../../lib/data";
import type { LiveCard } from "../../lib/parrot-reads";
import { WalletBird } from "./WalletBird";
import { CountUp, DryBird, Icon, SavedStamp, StageCard, StatValue } from "./StageBits";

export function LiveCards({ card, onClose, onConfirm }: { card: LiveCard | null; onClose: () => void; onConfirm?: () => void }) {
  if (!card) return null;
  let body: React.ReactNode;
  let label: string;
  if (card.kind === "run") {
    label = "Run log";
    const run = card.runs[0];
    const state = run?.status === "failed" ? "Failed" : run?.status === "skipped_paused" ? "Skipped" : run ? "Executed" : "No runs";
    body = <><h2>ROLL CALL!</h2><div className="run-state"><span className="leaf-chip"><Icon kind={run?.status === "executed" ? "check" : run?.status === "failed" ? "alert" : "pause"} />{state}</span>{(run?.dryRun ?? card.status?.dryRun) ? <DryBird /> : <span className="leaf-chip">{card.status ? "Live" : "Unknown"}</span>}{card.status?.controls.paused && <span className="leaf-chip"><Icon kind="pause" />Paused</span>}</div>
      <dl className="stage-stats"><div><dt>Orders</dt><dd>{run ? <CountUp value={ordersOf(run)} /> : "—"}</dd></div><div><dt>Equity</dt><dd>{run?.equityUsd == null ? "—" : <CountUp value={run.equityUsd} prefix="$" digits={2} />}</dd></div></dl></>;
  } else if (card.kind === "wallet") {
    label = `Wallet ${card.nickname}`;
    body = <><div className="wallet-solo"><WalletBird vibe="steady" /></div><h2 className="wallet-title">{card.nickname}</h2>
      <dl className="stage-stats wallet-stats">{card.lines.slice(0, 3).map(l => <div key={l.label}><dt>{l.label}</dt><dd><StatValue value={l.value} /></dd></div>)}</dl>
      {!card.lines.length && <p>No stats</p>}<span className="sr-only">Past measurements, not a promise of returns.</span></>;
  } else if (card.kind === "backtest") {
    label = "Backtest vs BTC";
    const candidates = card.series.filter(s => !s.reference && s.id !== "btc").slice(0, 4);
    const btc = card.series.find(s => s.reference || s.id === "btc");
    const series = [...candidates, btc]; // every strategy lane plus BTC, all at once
    const values = series.map(s => s?.points.at(-1)?.[1]);
    const min = Math.min(0, ...values.filter((v): v is number => v !== undefined));
    const max = Math.max(1, ...values.filter((v): v is number => v !== undefined));
    body = <><span className="leaf-chip">Backtest</span><h2>BEAK vs BTC</h2><span className="race-window">{card.window}</span>
      <div className="bird-race">{series.map((s, i) => <div className="race-lane" key={s?.id ?? i}>
        <div className="race-track"><span className="race-runner" style={{ "--finish": `${values[i] == null ? 0 : 12 + (values[i]! - min) / (max - min) * 66}%` } as CSSProperties}>
          {s !== btc ? <WalletBird vibe="wild" /> : <svg viewBox="0 0 48 48" aria-label="BTC" role="img"><circle cx="24" cy="24" r="21" fill="#f29a2e" stroke="currentColor" strokeWidth="2" /><path d="M18 13v22m-4-20h13c9 0 9 9 0 9H18m0 0h11c9 0 9 10 0 10H14m7-23v4m6-4v4m-6 19v4m6-4v4" fill="none" stroke="currentColor" strokeWidth="2.5" /></svg>}
        </span></div><strong>{values[i] == null ? "—" : <CountUp value={values[i]!} suffix="%" digits={1} />}</strong>
        <span className="race-name">{s?.short ?? "BTC"}</span>
      </div>)}</div><span className="honesty-line">History only</span><span className="sr-only">History, not a promise of returns.</span></>;
  } else if (card.kind === "request") {
    const saved = card.stage === "saved";
    label = saved ? "Request saved (PENDING)" : "Order preview (dry run)";
    const { plan } = card;
    // Every order on screen: two or three columns when there are many.
    const ocols = plan.orders.length > 12 ? 3 : plan.orders.length > 5 ? 2 : 1;
    body = saved ? <><SavedStamp id={card.requestId} hash={card.previewHash} /><p className="honesty-line">dry run - nothing is sent</p></> : <>
      <div className="sketch-heading"><DryBird /><h2>THE SKETCH</h2></div>
      <ul className="order-sketch" aria-label="Hypothetical orders" data-cols={ocols} style={{ "--ocols": ocols } as CSSProperties}>{plan.orders.map(o => <li key={o.asset}>
        <span className={`order-side ${o.isBuy ? "is-buy" : "is-sell"}`} aria-label={`${o.isBuy ? "Buy" : "Sell"} ${o.asset}`}><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d={o.isBuy ? "M10 17V3m-6 6 6-6 6 6" : "M10 3v14m-6-6 6 6 6-6"} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>{o.asset}</span>
        <CountUp value={Math.abs(o.notionalUsd)} prefix="$" digits={2} />
      </li>)}</ul>
      {!plan.orders.length && <p>No orders</p>}
      <div className="sketch-meta"><span>{plan.orders.length} orders</span>{plan.marginScale < 1 && <span title="Margin rule scaling">{Math.round(plan.marginScale * 100)}% scale</span>}{!!plan.skipped.length && <span>{plan.skipped.length} skipped</span>}</div>
      {onConfirm && <button type="button" className="parrot-button parrot-button--primary" onClick={onConfirm} aria-label="Confirm (save pending request)"><Icon kind="check" />Confirm</button>}
      <p className="honesty-line">dry run - nothing is sent</p>
    </>;
  } else {
    label = card.what;
    body = <><span className="unavailable-icon"><Icon kind="alert" /></span><h2>NO CRUMBS.</h2><p>Unavailable</p><span className="sr-only">{card.what}</span></>;
  }
  return <StageCard label={label} onClose={onClose}>{body}</StageCard>;
}
