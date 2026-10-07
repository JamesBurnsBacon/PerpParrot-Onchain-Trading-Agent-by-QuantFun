import { defaultBooks, type PaperPoint } from "../paper/service";
import type { LiveContext } from "../../../shared/live-context";

export type LiveContextDeps = {
  activeSources(): Promise<string[] | null>;
  paperPoints(): Promise<PaperPoint[]>;
  liveExposures(): Promise<{ asset: string; fraction: number }[] | null>;
  log?: (message: string) => void;
};
const round = (n: number) => Number(n.toFixed(2));
export const appendContextFacts = (base: string, facts: string[]): string => {
  let result = base.slice(0, 1200);
  for (const fact of facts) {
    if (result.length + 1 + fact.length <= 1200) result += ` ${fact}`;
  }
  return result;
};

// Each read has its own deadline and failure boundary. Never log returned data or errors.
export async function buildLiveContext(deps: LiveContextDeps, shortlistAddresses: string[]): Promise<LiveContext> {
  const read = async <T>(part: string, fn: () => Promise<T>): Promise<T | undefined> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(fn), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), 2000);
      })]);
    } catch {
      try { (deps.log ?? console.warn)(`parrot context: ${part} unavailable`); } catch { /* logging cannot fail the read */ }
      return undefined;
    } finally { clearTimeout(timer); }
  };
  const [compare, paper, book] = await Promise.all([
    read("comparison", async () => {
      const sources = await deps.activeSources();
      if (sources === null) return undefined;
      const active = new Set(sources.map(a => a.toLowerCase()));
      const addresses = [...new Set(shortlistAddresses.map(a => a.toLowerCase()))];
      const existing = addresses.filter(a => active.has(a)).length;
      return { total: addresses.length, existing, new: addresses.length - existing };
    }),
    read("paper", async () => {
      const points = await deps.paperPoints();
      const books: NonNullable<LiveContext["paper"]> = [];
      for (const spec of defaultBooks().filter(b => b.kind === "copy")) {
        const rows = points.filter(p => p.bookId === spec.id && Number.isFinite(p.t) && Number.isFinite(p.equityUsd))
          .sort((a, b) => a.t - b.t);
        if (rows.length < 2 || rows[0].equityUsd <= 0) continue;
        const first = rows[0], last = rows.at(-1)!;
        const returnPct = (last.equityUsd / first.equityUsd - 1) * 100;
        const days = (last.t - first.t) / 86_400;
        if (!Number.isFinite(returnPct) || !Number.isFinite(days)) continue;
        books.push({ bookId: spec.id, label: spec.id, returnPct: round(returnPct), days: round(days) });
      }
      return books.length ? books.slice(0, 3) : undefined;
    }),
    read("book", async () => {
      const exposures = await deps.liveExposures();
      if (exposures === null) return undefined;
      if (exposures.some(e => !Number.isFinite(e.fraction) || !/^[\w.:-]{1,32}$/.test(e.asset))) throw new Error("invalid exposure");
      const gross = exposures.reduce((sum, e) => sum + Math.abs(e.fraction), 0);
      if (!Number.isFinite(gross)) throw new Error("invalid gross");
      const top = [...exposures].filter(e => e.fraction !== 0)
        .sort((a, b) => Math.abs(b.fraction) - Math.abs(a.fraction) || a.asset.localeCompare(b.asset)).slice(0, 3);
      return { gross: round(gross), top: top.map(e => ({ asset: e.asset, fraction: round(e.fraction) })) };
    }),
  ]);
  const facts: string[] = [];
  if (compare) facts.push(`${compare.existing} of these ${compare.total} wallets are already in the live book; ${compare.new} are new.`);
  if (paper) for (const p of paper) facts.push(`Paper ${p.label}: ${p.returnPct >= 0 ? "+" : ""}${p.returnPct}% over ${p.days} days (existing paper book replay, not this shortlist or a forecast).`);
  if (book) facts.push(`Live book now (last stepped snapshot targets): gross ${book.gross}x${book.top.length ? `; top ${book.top.map(e => `${e.asset} ${e.fraction < 0 ? "short" : "long"} ${Math.abs(e.fraction)}x`).join(", ")}` : ""}.`);
  return { facts, ...(compare ? { compare } : {}), ...(paper ? { paper } : {}), ...(book ? { book } : {}) };
}
