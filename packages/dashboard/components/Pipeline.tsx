"use client";
import { dayTime, type PipelineView, type SelectionStatus } from "../lib/data";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);
const when = (iso: string | null | undefined) => (iso ? dayTime(ms(iso)) : "—");
const ago = (iso: string | null | undefined) => {
  const m = (Date.now() - ms(iso)) / 60_000;
  if (!Number.isFinite(m)) return "—";
  return m < 1 ? "just now" : m < 60 ? `${Math.round(m)}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export const SELECTION_STATUS: Record<SelectionStatus, { color: string; icon: string; label: string }> = {
  running: { color: "var(--series-1)", icon: "◌", label: "Running" },
  activated: { color: "var(--good)", icon: "●", label: "Activated" },
  kept: { color: "var(--good)", icon: "○", label: "Kept" },
  benched: { color: "var(--series-1)", icon: "◑", label: "Benched" },
  rejected: { color: "var(--warning)", icon: "◐", label: "Rejected" },
  failed: { color: "var(--critical)", icon: "✕", label: "Failed" },
};

function Badge({ status }: { status: SelectionStatus }) {
  const s = SELECTION_STATUS[status] ?? { color: "var(--muted)", icon: "?", label: status };
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs" style={{ border: `1px solid ${s.color}`, color: "var(--ink)" }}>
      <span style={{ color: s.color }}>{s.icon}</span>
      {s.label}
    </span>
  );
}

const Explorer = ({ address }: { address: string }) => (
  <a className="font-mono hover:underline" style={{ color: "var(--ink)" }} href={`https://app.hyperliquid.xyz/explorer/address/${address}`} target="_blank" rel="noreferrer" title={address}>
    {short(address)}
  </a>
);

function Bar({ value, color = "var(--series-1)" }: { value: number; color?: string }) {
  return (
    <span className="block h-2 w-full rounded-full" style={{ background: "var(--grid)" }}>
      <span className="lp-grow block h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </span>
  );
}

// A 0–100 AI score as a tinted cell: `bad` says which end is the concern.
function Heat({ v, bad }: { v: number | null; bad: "high" | "low" }) {
  if (v === null || v === undefined) return <td className="py-1 pl-2 text-right" style={{ color: "var(--muted)" }}>—</td>;
  const concern = bad === "high" ? v / 100 : 1 - v / 100;
  const color = concern >= 0.5 ? "var(--critical)" : "var(--good)";
  const strength = Math.round(Math.abs(concern - 0.5) * 2 * 45);
  return (
    <td className="py-1 pl-2 text-right">
      <span className="inline-block min-w-[2.25rem] rounded px-1 text-right" style={{ background: `color-mix(in srgb, ${color} ${strength}%, transparent)`, color: "var(--ink)" }}>
        {Math.round(v)}
      </span>
    </td>
  );
}

function Tile({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg p-3" style={{ border: "1px solid var(--grid)" }}>
      <div className="mb-1 text-xs" style={{ color: "var(--ink-2)" }}>{label}</div>
      {children}
      {note && <div className="mt-1 truncate text-xs" style={{ color: "var(--muted)" }}>{note}</div>}
    </div>
  );
}

// scan ~14k accounts every 12 h → refresh every 5 min → Score qualifies ~250 → every 10 min pick 25
// (no high-frequency traders) → AI review when they change → freeze → activate when the sources change.
export function Pipeline({ view }: { view: PipelineView }) {
  const { accounts, selections, active, latest, routing, verification } = view;
  const run = selections[0];
  const freshShare = accounts.listed ? accounts.fresh / accounts.listed : 0;
  const sources = [...(active?.sources ?? [])].sort((a, b) => b.weightUnits - a.weightUnits);
  const maxWeight = Math.max(...sources.map((s) => s.weightUnits), 1);

  // Latest run's finalists joined with the AI verdicts; picked = in that run's manifest.
  const picked = new Map((run?.manifest?.sources ?? []).map((s) => [s.address.toLowerCase(), s.weight]));
  // The roster's bench: approved wallets and whether a 10-minute loop can follow them.
  const bench = new Map((latest?.bench ?? []).map((b) => [b.address.toLowerCase(), b]));
  const verdicts = new Map((latest?.summary ?? []).filter((s) => s.address).map((s) => [s.address!.toLowerCase(), s]));
  const finalists = [...(latest?.finalists?.finalists ?? [])].sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const funnel = latest?.finalists?.funnel ?? [];
  const overlap = latest?.finalists?.overlap;
  const guard = latest?.finalists?.overlapGuard;
  const contractCheck = latest?.finalists?.contracts;
  const contractSet = new Set((contractCheck?.contracts ?? []).map((c) => c.address.toLowerCase()));
  const funnelMax = Math.max(...funnel.map((f) => f.count), 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Tile label="Accounts refreshed" note={[accounts.errors ? `${accounts.errors} errors` : "", accounts.qualified ? `${accounts.qualified} qualified` : ""].filter(Boolean).join(" · ") || undefined}>
          <div className="mb-1.5 flex items-baseline gap-1 text-lg font-semibold tabular">
            {accounts.fresh}
            <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>/ {accounts.listed}</span>
            <span className="ml-auto text-xs font-normal" style={{ color: "var(--ink-2)" }}>{Math.round(freshShare * 100)}%</span>
          </div>
          <Bar value={freshShare} color={freshShare >= 0.95 ? "var(--good)" : "var(--series-1)"} />
        </Tile>
        <Tile label="Active configuration" note={active ? undefined : "pinned fixture"}>
          {active ? (
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tabular">{active.sources.length}</span>
              <span className="text-xs" style={{ color: "var(--ink-2)" }}>sources</span>
              <code className="ml-auto truncate font-mono text-xs" style={{ color: "var(--muted)" }} title={active.hash}>{short(active.hash)}</code>
            </div>
          ) : (
            <div className="text-lg font-semibold" style={{ color: "var(--muted)" }}>none</div>
          )}
        </Tile>
        <div className="min-w-0 rounded-lg p-3" style={{ border: "1px solid var(--grid)" }}>
          <h3 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>Active sources</h3>
          {sources.length ? (
            <table className="tabular w-full whitespace-nowrap text-xs">
              <tbody>
                {sources.map((s) => (
                  <tr key={s.sourceAddress} className="border-t first:border-t-0" style={{ borderColor: "var(--grid)" }}>
                    <td className="w-28 py-1.5"><Explorer address={s.sourceAddress} /></td>
                    <td className="w-full px-2"><Bar value={s.weightUnits / maxWeight} /></td>
                    <td className="py-1.5 text-right font-semibold">{(s.weightUnits / 1e4).toFixed(1)}%</td>
                    <td className="py-1.5 pl-2 text-right" style={{ color: "var(--muted)" }} title="Ceiling">≤{(s.ceilingUnits / 1e4).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-xs" style={{ color: "var(--muted)" }}>No configuration activated yet</div>
          )}
        </div>
      </div>

      {routing && (routing.mode !== "official" || routing.nownodes.requests > 0) && (
        <Tile
          label="Hyperliquid data providers"
          note={`mode ${routing.mode}${routing.breakerOpen ? " · NOWNodes paused (circuit breaker)" : ""}${routing.shadow.compared ? ` · shadow check: ${routing.shadow.compared - routing.shadow.mismatches}/${routing.shadow.compared} match` : ""}`}
        >
          <div className="tabular flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            {(["official", "nownodes"] as const).map((p) => (
              <span key={p}>
                <span className="font-semibold">{p === "official" ? "Hyperliquid" : "NOWNodes"}</span>{" "}
                {routing[p].requests} reads
                {routing[p].requests ? ` · avg ${Math.round(routing[p].totalMs / routing[p].requests)} ms` : ""}
                {routing[p].errors ? ` · ${routing[p].errors} errors` : ""}
              </span>
            ))}
            <span style={{ color: "var(--ink-2)" }}>{routing.fallbacks} failovers</span>
          </div>
          {routing.capabilities && (
            <div className="mt-2 text-xs" style={{ color: "var(--ink-2)" }}>
              Probed {routing.capabilities.rows.length} info methods on NOWNodes {ago(new Date(routing.capabilities.probedAt).toISOString())}:{" "}
              {routing.capabilities.rows.filter((r) => r.verdict === "supported").length} served, {routing.capabilities.rows.filter((r) => r.verdict === "unsupported").length} refused (422)
              {routing.capabilities.rows.some((r) => r.verdict === "inconclusive") ? `, ${routing.capabilities.rows.filter((r) => r.verdict === "inconclusive").length} inconclusive` : ""}.
              {routing.capabilities.narrowed.length ? ` Not used any more: ${routing.capabilities.narrowed.join(", ")}.` : " The allowlist matches."}
              {routing.capabilities.newlySupported.length ? ` Served but unused: ${routing.capabilities.newlySupported.join(", ")}.` : ""}
            </div>
          )}
        </Tile>
      )}

      {verification && verification.mode !== "off" && (
        <Tile
          label="Snapshot cross-check (NOWNodes)"
          note={`mode ${verification.mode}`}
        >
          <div className="tabular flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
            <span><span className="font-semibold">{verification.verified}</span> verified</span>
            <span style={{ color: verification.mismatches ? "var(--critical)" : "var(--ink-2)" }}>{verification.mismatches} blocked on a mismatch</span>
            <span style={{ color: "var(--ink-2)" }}>{verification.unverified} unverified</span>
            <span style={{ color: "var(--ink-2)" }}>{verification.checks} checks since this instance started</span>
          </div>
          {verification.last && (
            <div className="mt-2 text-xs" style={{ color: "var(--ink-2)" }}>
              Last: {verification.last.verdict} across {verification.last.sources} sources in {verification.last.ms} ms
              {verification.last.retried ? `, ${verification.last.retried} re-read` : ""}
              {verification.last.diffs.length ? `, differing: ${verification.last.diffs.map((d) => `${short(d.address)} ${d.asset}`).join(", ")}` : ""}.
            </div>
          )}
        </Tile>
      )}

      <details className="lp-details">
        <summary>Details</summary>
        <div className="flex flex-col gap-4">
        <Tile label="Latest selection" note={run ? (run.error ?? run.manifest?.reason ?? `${run.accounts ?? "—"} accounts scored`) : "none yet · every 10 min"}>
          {run ? (
            <div className="flex items-center gap-2">
              <Badge status={run.status} />
              <span className="text-xs" style={{ color: "var(--ink-2)" }}>{when(run.started_at)}</span>
              <span className="ml-auto text-xs" style={{ color: "var(--muted)" }}>{ago(run.started_at)}</span>
            </div>
          ) : (
            <div className="text-lg font-semibold" style={{ color: "var(--muted)" }}>—</div>
          )}
        </Tile>
      <div className="grid gap-4 md:grid-cols-1">
        <div className="min-w-0">
          <h3 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>Recent selections</h3>
          {selections.length ? (
            <table className="tabular w-full whitespace-nowrap text-xs">
              <tbody>
                {selections.slice(0, 6).map((r) => (
                  <tr key={r.id} className="border-t first:border-t-0" style={{ borderColor: "var(--grid)" }}>
                    <td className="py-1.5 pr-2" style={{ color: "var(--ink)" }}>{when(r.started_at)}</td>
                    <td className="py-1.5 pr-2"><Badge status={r.status} /></td>
                    <td className="py-1.5 pr-2 text-right" style={{ color: "var(--ink-2)" }} title="Accounts scored">{r.accounts ?? "—"}</td>
                    <td className="max-w-[12rem] truncate py-1.5" style={{ color: "var(--muted)" }} title={r.error ?? r.manifest?.reason ?? ""}>
                      {r.error ?? (r.manifest ? `${r.manifest.sources.length} src · ${r.manifest.reason}` : "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-xs" style={{ color: "var(--muted)" }}>No selection has run yet</div>
          )}
        </div>
      </div>

      {(finalists.length > 0 || funnel.length > 0) && (
        <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
          <div className="min-w-0">
            <h3 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>Score funnel · run #{latest?.id}</h3>
            <ul className="text-xs">
              {funnel.map((f) => (
                <li key={f.stage} className="grid grid-cols-[6.5rem_1fr_2rem] items-center gap-2 py-0.5">
                  <span className="truncate" style={{ color: "var(--ink-2)" }}>{f.stage.replace(/_/g, " ")}</span>
                  <Bar value={f.count / funnelMax} color="var(--axis)" />
                  <span className="tabular text-right" style={{ color: "var(--ink)" }}>{f.count}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="min-w-0 overflow-x-auto">
            <h3 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>
              Finalists · AI verdicts <span className="font-normal" style={{ color: "var(--muted)" }}>0–100 · red = concern</span>
            </h3>
            {guard && (
              <p className="mb-1 text-xs" style={{ color: "var(--ink-2)" }}>
                Overlap guard: read {guard.reads} books ({guard.provider.nownodes} via NOWNodes, {guard.provider.official} via Hyperliquid) in {(guard.ms / 1000).toFixed(1)} s · left out {guard.excluded} overlapping candidate{guard.excluded === 1 ? "" : "s"} above {guard.threshold}
                {guard.failed ? ` · ${guard.failed} reads failed` : ""}
              </p>
            )}
            {contractCheck && (
              <p className="mb-1 text-xs" style={{ color: "var(--ink-2)" }}>
                Contract check (HyperEVM eth_getCode via NOWNodes): {contractCheck.contracts.length} of {contractCheck.checked} picks {contractCheck.contracts.length === 1 ? "is a contract" : "are contracts"} in {(contractCheck.ms / 1000).toFixed(1)} s
                {contractCheck.unread.length ? ` · ${contractCheck.unread.length} could not be read` : ""} · evidence only, the pick is unchanged
              </p>
            )}
            <table className="tabular w-full whitespace-nowrap text-xs">
              <thead style={{ color: "var(--muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">#</th>
                  <th className="py-1 text-left font-normal">Address</th>
                  <th className="py-1 pl-2 text-left font-normal">Kind</th>
                  <th className="py-1 pl-2 text-right font-normal">Score</th>
                  <th className="py-1 pl-2 text-right font-normal" title="Role: aggressive-bucket fit">Fit</th>
                  <th className="py-1 pl-2 text-right font-normal" title="Role: reject">Reject</th>
                  <th className="py-1 pl-2 text-right font-normal" title="Risk: leverage">Lev</th>
                  <th className="py-1 pl-2 text-right font-normal" title="Risk: evidence">Evid</th>
                  {overlap && <th className="py-1 pl-2 text-right font-normal" title="Largest same-direction position overlap with another pick (0–1)">Overlap</th>}
                  {bench.size > 0 && <th className="py-1 pl-2 text-right font-normal" title="Approved for the roster's bench · share of notional held ≥ 90 min (≥ 50% to be seated)">Bench · copyable</th>}
                  <th className="py-1 pl-2 text-right font-normal">Weight</th>
                </tr>
              </thead>
              <tbody>
                {finalists.map((f, i) => {
                  const v = verdicts.get(f.address.toLowerCase());
                  const w = picked.get(f.address.toLowerCase());
                  return (
                    <tr key={f.address} className="border-t" style={{ borderColor: "var(--grid)" }}>
                      <td className="py-1" style={{ color: "var(--muted)" }}>{f.rank ?? i + 1}</td>
                      <td className="py-1"><Explorer address={f.address} /></td>
                      <td className="py-1 pl-2" style={{ color: contractSet.has(f.address.toLowerCase()) ? "var(--warning)" : "var(--ink-2)" }} title={contractSet.has(f.address.toLowerCase()) ? "Has code on HyperEVM (eth_getCode via NOWNodes): a contract, not a person's wallet" : undefined}>{f.kind ?? "—"}{contractSet.has(f.address.toLowerCase()) ? " · contract" : ""}</td>
                      <td className="py-1 pl-2 text-right">{f.score === undefined ? "—" : f.score.toLocaleString(undefined, { maximumSignificantDigits: 3 })}</td>
                      <Heat v={v?.aggressiveFit ?? null} bad="low" />
                      <Heat v={v?.reject ?? null} bad="high" />
                      <Heat v={v?.leverageRisk ?? null} bad="high" />
                      <Heat v={v?.evidenceRisk ?? null} bad="high" />
                      {overlap && (
                        <td className="py-1 pl-2 text-right" style={{ color: (overlap.byAddress[f.address.toLowerCase()] ?? 0) > overlap.threshold ? "var(--critical)" : "var(--ink-2)" }}>
                          {overlap.byAddress[f.address.toLowerCase()] === undefined ? "—" : overlap.byAddress[f.address.toLowerCase()]!.toFixed(2)}
                        </td>
                      )}
                      {bench.size > 0 && (() => {
                        const b = bench.get(f.address.toLowerCase());
                        if (!b) return <td className="py-1 pl-2 text-right" style={{ color: "var(--muted)" }}>—</td>;
                        const share = b.copyableShare === null ? (b.turnoverPerDay === null ? "?" : `turnover ${b.turnoverPerDay.toFixed(1)}/d`) : `${Math.round(b.copyableShare * 100)}%`;
                        return <td className="py-1 pl-2 text-right" style={{ color: b.passesHold ? "var(--good)" : "var(--warning)" }}>{b.passesHold ? "✓" : "✗"} {share}</td>;
                      })()}
                      <td className="py-1 pl-2 text-right font-semibold" style={{ color: w ? "var(--series-1)" : "var(--muted)" }}>
                        {w ? `${(w * 100).toFixed(1)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </div>
      </details>
    </div>
  );
}
