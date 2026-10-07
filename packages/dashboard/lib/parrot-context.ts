import type { LiveContext } from "../../shared/live-context";

const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 0 && v <= 25;
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
export function isLiveContext(v: unknown): v is LiveContext {
  if (!record(v) || !keys(v, ["facts", "compare", "paper", "book"]) || !Array.isArray(v.facts) || v.facts.length > 5 ||
      !v.facts.every(f => short(f, 300)) || v.facts.join(" ").length > 1200) return false;
  if (v.compare !== undefined) {
    const c = v.compare;
    if (!record(c) || !keys(c, ["total", "existing", "new"]) || !count(c.total) || !count(c.existing) || !count(c.new) ||
        c.existing + c.new !== c.total) return false;
  }
  if (v.paper !== undefined && (!Array.isArray(v.paper) || v.paper.length > 3 ||
      !v.paper.every(p => record(p) && keys(p, ["bookId", "label", "returnPct", "days"]) &&
        short(p.bookId, 40) && short(p.label, 40) && finite(p.returnPct) && finite(p.days) && p.days >= 0) ||
      new Set(v.paper.map(p => p.bookId)).size !== v.paper.length)) return false;
  if (v.book !== undefined) {
    const b = v.book;
    if (!record(b) || !keys(b, ["gross", "top"]) || !finite(b.gross) || b.gross < 0 || !Array.isArray(b.top) || b.top.length > 3 ||
        !b.top.every(e => record(e) && keys(e, ["asset", "fraction"]) && short(e.asset, 32) && finite(e.fraction)) ||
        new Set(b.top.map(e => e.asset)).size !== b.top.length) return false;
  }
  return true;
}

export function liveContextLine(context?: LiveContext): string {
  const parts: string[] = [];
  if (context?.compare) parts.push(`${context.compare.existing} of ${context.compare.total} already in the live book`);
  const paper = context?.paper?.[0];
  if (paper) parts.push(`paper ${paper.label} ${paper.returnPct >= 0 ? "+" : ""}${paper.returnPct}% (${paper.days}d replay)`);
  if (context?.book) parts.push(`book gross ${context.book.gross}x (last snapshot)`);
  return parts.join(" · ");
}
