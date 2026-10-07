"use client";
import { useMemo, useState } from "react";
import type { Exposures } from "../lib/data";
import { time } from "../lib/data";
import { bandWidth, buildExposureFlow, shiftLabel, sideLabel, targetsWithMutes, walletLabel } from "../lib/exposure-flow";
import { Panel } from "./Charts";
import { useWidth } from "./useWidth";

const COLORS = ["#6cc04a", "#f29a2e", "#9683bf", "#639ec4", "#eac744"];

export function ExposureFlow({ exposures }: { exposures: Exposures }) {
  const model = useMemo(() => buildExposureFlow(exposures), [exposures]);
  const [muted, setMuted] = useState<Set<string>>(() => new Set());
  const [ref, width] = useWidth<HTMLDivElement>(240);
  const compact = width < 600;
  const left = compact ? 100 : 178;
  // The label column is as wide as its widest line ("Short 42.6%", about 90px), so the chart runs to the panel edge.
  const right = width - 104;
  const height = Math.max(140, model.wallets.length * 66, model.assets.length * 76);
  const rowY = (index: number, count: number) => count < 2 ? height / 2 : 38 + index * (height - 76) / (count - 1);
  const walletRows = new Map(model.wallets.map((wallet, i) => [wallet.id, rowY(i, model.wallets.length)]));
  const assetRows = new Map(model.assets.map(({ asset }, i) => [asset, rowY(i, model.assets.length)]));
  const targets = targetsWithMutes(model, muted);
  const hasMutes = model.wallets.some((wallet) => muted.has(wallet.id));
  const toggle = (id: string) => setMuted((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <Panel tone={3} title="Who drives each target" meta={time(exposures.runAt * 1000)}>
      <div className="exposure-flow" ref={ref}>
        <div className="exposure-flow-chart" style={{ height }}>
          <svg width="100%" height={height} role="img" aria-label="Source wallet contributions to net asset targets. Green solid adds long exposure; orange dashed adds short exposure or offsets. Values are listed after the chart.">
            {[...model.bands].sort((a, b) => Math.abs(b.fraction) - Math.abs(a.fraction)).map((band) => muted.has(band.wallet) ? null : (
              <path
                key={`${band.wallet}:${band.asset}`}
                d={`M ${left} ${walletRows.get(band.wallet)} C ${left + (right - left) / 2} ${walletRows.get(band.wallet)}, ${right - (right - left) / 2} ${assetRows.get(band.asset)}, ${right} ${assetRows.get(band.asset)}`}
                fill="none" stroke={band.fraction > 0 ? "var(--long)" : "var(--short)"}
                strokeWidth={bandWidth(band.fraction, model.maxContribution)}
                strokeDasharray={band.fraction < 0 ? "8 6" : undefined} opacity={0.5}
              >
                <title>{`${band.wallet} → ${band.asset}: ${sideLabel(band.fraction)}`}</title>
              </path>
            ))}
            {model.wallets.map((wallet, i) => (
              <circle key={wallet.id} cx={left} cy={walletRows.get(wallet.id)} r={4} fill={COLORS[i % COLORS.length]} opacity={muted.has(wallet.id) ? 0.35 : 1} />
            ))}
            {model.assets.map(({ asset }) => <circle key={asset} cx={right} cy={assetRows.get(asset)} r={4} fill="var(--ink)" />)}
          </svg>
          {model.wallets.map((wallet, i) => (
            <button key={wallet.id} type="button" className="exposure-flow-wallet"
              style={{ top: walletRows.get(wallet.id), width: left - 10 }}
              aria-pressed={muted.has(wallet.id)} aria-label={`Mute wallet ${wallet.address}, ${wallet.weightPct.toFixed(1)}% weight`}
              title={wallet.address} onClick={() => toggle(wallet.id)}>
              <span className="exposure-flow-wallet-name"><i style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />{walletLabel(wallet.address, compact)}</span>
              <span className="exposure-flow-weight">{wallet.weightPct.toFixed(1)}%{compact ? "" : " weight"}{muted.has(wallet.id) ? " · muted" : ""}</span>
            </button>
          ))}
          {targets.map(({ asset, net }) => (
            <div key={asset} className="exposure-flow-target tabular" aria-hidden="true" style={{ top: assetRows.get(asset), left: right + 12, width: width - right - 12 }}>
              <span className="exposure-flow-asset" title={asset}>{asset}</span>
              <strong style={{ color: net === 0 ? "var(--ink)" : net > 0 ? "var(--long)" : "var(--short)" }}>{sideLabel(net)}</strong>
            </div>
          ))}
        </div>
        <div className="exposure-flow-key">
          <span><svg width="26" height="8" aria-hidden="true"><path d="M 0 4 H 26" stroke="var(--long)" strokeWidth="4" /></svg>Adds long</span>
          <span><svg width="26" height="8" aria-hidden="true"><path d="M 0 4 H 26" stroke="var(--short)" strokeWidth="4" strokeDasharray="6 4" /></svg>Adds short / offsets</span>
        </div>
        <p className="exposure-flow-caption">Muting a wallet is a what-if; nothing is changed.</p>
        <div className="exposure-flow-sr" aria-live="polite" aria-atomic="true">
          <table>
            <caption>Net targets as a percentage of equity{hasMutes ? ", excluding muted wallets" : ""}</caption>
            <thead><tr><th scope="col">Asset</th><th scope="col">Net target</th><th scope="col">Change from all wallets</th></tr></thead>
            <tbody>{targets.map(({ asset, net, delta }) => <tr key={asset}><th scope="row">{asset}</th><td>{sideLabel(net)}</td><td>{shiftLabel(delta)}</td></tr>)}</tbody>
          </table>
          <table>
            <caption>Contribution of each wallet to each net target, as a percentage of equity</caption>
            <thead><tr><th scope="col">Wallet</th><th scope="col">Asset</th><th scope="col">Contribution</th><th scope="col">Status</th></tr></thead>
            <tbody>{model.bands.map((band) => <tr key={`${band.wallet}:${band.asset}`}><th scope="row">{band.wallet}</th><td>{band.asset}</td><td>{sideLabel(band.fraction)}</td><td>{muted.has(band.wallet) ? "muted" : "counted"}</td></tr>)}</tbody>
          </table>
          {!targets.length && <p>No nonzero targets in this run.</p>}
        </div>
      </div>
    </Panel>
  );
}
