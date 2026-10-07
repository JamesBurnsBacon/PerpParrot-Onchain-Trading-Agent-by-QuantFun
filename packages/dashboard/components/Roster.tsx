"use client";
// The per-wallet roster (docs/ingest/ROSTER.md): who holds a seat, at what weight, how much tenure
// is left, who is flat or winding down, and what changed recently.
import type { RosterEvent, RosterSeat, RosterView, SeatState } from "../lib/data";

const HOUR = 3_600_000;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hours = (ms: number) => (ms < HOUR ? `${Math.max(1, Math.round(ms / 60_000))}m` : ms < 48 * HOUR ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / (24 * HOUR))}d`);

const STATE: Record<SeatState, { color: string; label: string }> = {
  probation: { color: "var(--series-1)", label: "Probation" },
  seated: { color: "var(--good)", label: "Seated" },
  winding_down: { color: "var(--warning)", label: "Winding down" },
  released: { color: "var(--muted)", label: "Released" },
  removed: { color: "var(--critical)", label: "Removed" },
};

const EVENT: Record<RosterEvent["kind"], { color: string; label: string }> = {
  seeded: { color: "var(--muted)", label: "seeded" },
  admitted: { color: "var(--series-1)", label: "admitted" },
  seated: { color: "var(--good)", label: "seated" },
  released: { color: "var(--ink-2)", label: "released" },
  removed: { color: "var(--critical)", label: "removed" },
  winding_down: { color: "var(--warning)", label: "winding down" },
  weight: { color: "var(--series-4)", label: "re-weighted" },
};

function Pill({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs" style={{ border: `1px solid ${color}`, color: "var(--ink)" }}>
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      {children}
    </span>
  );
}

function Track({ value, color }: { value: number; color: string }) {
  return (
    <span className="block h-2 w-full rounded-full" style={{ background: "var(--grid)" }}>
      <span className="lp-grow block h-2 rounded-full" style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, background: color }} />
    </span>
  );
}

// Tenure progress for probation, wind-down time left for a winding-down seat, else done.
function Clock({ seat, now }: { seat: RosterSeat; now: number }) {
  if (seat.state === "winding_down" && seat.windDownUntil) {
    const left = seat.windDownUntil - now;
    return (
      <span className="flex items-center gap-2">
        <Track value={1 - left / (48 * HOUR)} color="var(--warning)" />
        <span className="w-16 text-right" style={{ color: "var(--ink-2)" }}>{left > 0 ? `${hours(left)} left` : "due"}</span>
      </span>
    );
  }
  const span = seat.minTenureUntil - seat.admittedAt;
  const left = seat.minTenureUntil - now;
  if (left <= 0 || span <= 0) return <span style={{ color: "var(--muted)" }}>tenure done</span>;
  return (
    <span className="flex items-center gap-2">
      <Track value={1 - left / span} color="var(--series-1)" />
      <span className="w-16 text-right" style={{ color: "var(--ink-2)" }}>{hours(left)} left</span>
    </span>
  );
}

const describe = (e: RosterEvent): string => {
  const d = e.detail ?? {};
  const parts: string[] = [];
  if (typeof d.reason === "string") parts.push(d.reason);
  if (typeof d.weightUnits === "number") parts.push(`${(d.weightUnits / 1e4).toFixed(1)}%`);
  if (typeof d.from === "number" && typeof d.to === "number") parts.push(`${(d.from / 1e4).toFixed(1)}% → ${(d.to / 1e4).toFixed(1)}%`);
  if (typeof d.fit === "number") parts.push(`fit ${Math.round(d.fit)}`);
  if (typeof d.copyableShare === "number") parts.push(`copyable ${Math.round(d.copyableShare * 100)}%`);
  return parts.join(" · ");
};

export function Roster({ roster, now = Date.now() }: { roster: RosterView; now?: number }) {
  const seats = [...roster.seats].sort((a, b) => b.weightUnits - a.weightUnits);
  const invested = seats.reduce((sum, s) => sum + s.weightUnits, 0) / 1e6;
  const maxWeight = Math.max(...seats.map((s) => s.weightUnits), 1);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <div className="min-w-0 rounded-lg p-3" style={{ border: "1px solid var(--grid)" }}>
          <div className="mb-1 text-xs" style={{ color: "var(--ink-2)" }}>Seats</div>
          <div className="text-lg font-semibold tabular">{seats.length} <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>of 5–15</span></div>
        </div>
        <div className="min-w-0 rounded-lg p-3" style={{ border: "1px solid var(--grid)" }}>
          <div className="mb-1 flex items-baseline text-xs" style={{ color: "var(--ink-2)" }}>
            Invested weight <span className="ml-auto tabular" style={{ color: "var(--ink)" }}>{(invested * 100).toFixed(1)}% / 90%</span>
          </div>
          <Track value={invested / 0.9} color={invested >= 0.85 ? "var(--good)" : "var(--series-1)"} />
        </div>
        <div className="min-w-0 rounded-lg p-3" style={{ border: "1px solid var(--grid)" }}>
          <div className="mb-1 text-xs" style={{ color: "var(--ink-2)" }}>Implied copy turnover</div>
          <div className="text-lg font-semibold tabular">
            {roster.impliedTurnover === null ? <span style={{ color: "var(--muted)" }}>measuring</span> : <>{roster.impliedTurnover.toFixed(2)}× <span className="text-sm font-normal" style={{ color: "var(--muted)" }}>equity / day</span></>}
          </div>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-[3fr_2fr]">
        <div className="min-w-0 overflow-x-auto">
          {seats.length ? (
            <table className="tabular w-full whitespace-nowrap text-xs">
              <thead style={{ color: "var(--muted)" }}>
                <tr>
                  <th className="py-1 text-left font-normal">Wallet</th>
                  <th className="py-1 pl-2 text-left font-normal">State</th>
                  <th className="w-1/4 py-1 pl-2 text-left font-normal">Weight</th>
                  <th className="w-1/4 py-1 pl-2 text-left font-normal">Tenure</th>
                </tr>
              </thead>
              <tbody>
                {seats.map((s) => (
                  <tr key={s.address} className="border-t" style={{ borderColor: "var(--grid)" }}>
                    <td className="py-1.5">
                      <a className="font-mono hover:underline" style={{ color: "var(--ink)" }} href={`https://app.hyperliquid.xyz/explorer/address/${s.address}`} target="_blank" rel="noreferrer" title={s.address}>
                        {short(s.address)}
                      </a>
                    </td>
                    <td className="py-1.5 pl-2"><Pill color={STATE[s.state].color}>{STATE[s.state].label}</Pill></td>
                    <td className="py-1.5 pl-2">
                      <span className="flex items-center gap-2">
                        <Track value={s.weightUnits / maxWeight} color="var(--series-1)" />
                        <span className="w-12 text-right font-semibold">{(s.weightUnits / 1e4).toFixed(1)}%</span>
                      </span>
                    </td>
                    <td className="py-1.5 pl-2"><Clock seat={s} now={now} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-4 text-xs" style={{ color: "var(--muted)" }}>No seats yet</div>
          )}
        </div>
        <div className="min-w-0">
          <h3 className="mb-1 text-xs font-semibold" style={{ color: "var(--ink-2)" }}>Recent changes</h3>
          {roster.events.length ? (
            <ul className="text-xs">
              {roster.events.slice(0, 14).map((e, i) => (
                <li key={`${e.at}-${e.address}-${i}`} className="grid grid-cols-[3.5rem_6.5rem_1fr] items-center gap-2 border-t py-1" style={{ borderColor: "var(--grid)" }} title={describe(e)}>
                  <span className="tabular" style={{ color: "var(--muted)" }}>{new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                  <span style={{ color: EVENT[e.kind]?.color ?? "var(--ink-2)" }}>{EVENT[e.kind]?.label ?? e.kind}</span>
                  <span className="font-mono" style={{ color: "var(--ink)" }} title={e.address}>{short(e.address)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-4 text-xs" style={{ color: "var(--muted)" }}>No changes yet</div>
          )}
        </div>
      </div>
    </div>
  );
}
