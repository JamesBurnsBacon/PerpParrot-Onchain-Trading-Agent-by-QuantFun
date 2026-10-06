import type { SQL } from "bun";

export type LimitConfig = { ipHourly: number; previewIpHourly: number; previewGlobalDaily: number; globalDaily: number; dailyBudgetMicroUsd: number };
export type Kind = "chat" | "preview" | "live";
export type Reservation = { ok: true; id: string } | { ok: false; reason: "ip_hourly" | "global_daily" | "daily_budget"; retryAfterSec: number };
export interface ChatLimiter {
  reserve(args: { ipHash: string; kind: Kind; nowMs: number; reserveMicroUsd: number; cfg: LimitConfig }): Promise<Reservation>;
  settle(args: { id: string; tokens: number; costMicroUsd: number }): Promise<void>;
}

type Usage = { id: string; ipHash: string; kind: Kind; tsMs: number; tokens: number; costMicroUsd: number };
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const retryAfter = (oldest: number | undefined, nowMs: number, windowMs: number): number =>
  Math.max(1, Math.ceil(((oldest ?? nowMs) + windowMs - nowMs) / 1000));

export const hashIp = (ip: string, salt: string): string =>
  new Bun.CryptoHasher("sha256").update(`${salt}:${ip}`).digest("hex");

export class MemoryChatLimiter implements ChatLimiter {
  private readonly rows = new Map<string, Usage>();
  private nextId = 0;

  async reserve({ ipHash, kind, nowMs, reserveMicroUsd, cfg }: Parameters<ChatLimiter["reserve"]>[0]): Promise<Reservation> {
    // No await between inspection and insertion: reservations are atomic on one local instance.
    for (const [id, row] of this.rows) if (row.tsMs <= nowMs - DAY_MS) this.rows.delete(id);
    const rows = [...this.rows.values()];
    const hourly = rows.filter((row) => row.kind === kind && row.ipHash === ipHash && row.tsMs > nowMs - HOUR_MS);
    const oldest = (entries: Usage[]) => entries.length ? Math.min(...entries.map((row) => row.tsMs)) : undefined;
    if (hourly.length >= (kind === "preview" ? cfg.previewIpHourly : cfg.ipHourly)) {
      return { ok: false, reason: "ip_hourly", retryAfterSec: retryAfter(oldest(hourly), nowMs, HOUR_MS) };
    }
    const chats = rows.filter((row) => row.kind === kind);
    const paid = rows.filter((row) => row.kind !== "preview");
    if (chats.length >= (kind === "preview" ? cfg.previewGlobalDaily : cfg.globalDaily)) {
      return { ok: false, reason: "global_daily", retryAfterSec: retryAfter(oldest(chats), nowMs, DAY_MS) };
    }
    if (kind !== "preview" && paid.reduce((sum, row) => sum + row.costMicroUsd, 0) + reserveMicroUsd > cfg.dailyBudgetMicroUsd) {
      return { ok: false, reason: "daily_budget", retryAfterSec: retryAfter(oldest(paid), nowMs, DAY_MS) };
    }
    const id = String(++this.nextId);
    this.rows.set(id, { id, ipHash, kind, tsMs: nowMs, tokens: 0, costMicroUsd: kind === "preview" ? 0 : reserveMicroUsd });
    return { ok: true, id };
  }

  async settle({ id, tokens, costMicroUsd }: Parameters<ChatLimiter["settle"]>[0]): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.tokens = tokens;
      row.costMicroUsd = row.kind === "preview" ? 0 : costMicroUsd;
    }
  }
}


// Fixed advisory-lock key shared by every chat limiter instance (exported so a test can hold it).
export const CHAT_LIMITER_LOCK_KEY = 72478103621001;

export class PostgresChatLimiter implements ChatLimiter {
  constructor(private readonly sql: SQL) {}

  async reserve({ ipHash, kind, nowMs, reserveMicroUsd, cfg }: Parameters<ChatLimiter["reserve"]>[0]): Promise<Reservation> {
    return await this.sql.begin(async (tx): Promise<Reservation> => {
      // The transaction lock serializes reserves across processes and is pooler-safe.
      // Counts MUST be a later statement: READ COMMITTED then sees the prior commit.
      await tx`select pg_advisory_xact_lock(${CHAT_LIMITER_LOCK_KEY}::bigint)`;
      const [counts] = await tx`
        select
          count(*) filter (where kind = ${kind} and ip_hash = ${ipHash} and ts_ms > ${nowMs - HOUR_MS}) as hourly_count,
          min(ts_ms) filter (where kind = ${kind} and ip_hash = ${ipHash} and ts_ms > ${nowMs - HOUR_MS}) as hourly_oldest,
          count(*) filter (where kind = ${kind}) as daily_count,
          min(ts_ms) filter (where kind = ${kind}) as daily_oldest,
          min(ts_ms) filter (where kind <> 'preview') as budget_oldest,
          coalesce(sum(cost_micro_usd) filter (where kind <> 'preview'), 0) as daily_cost
        from public.chat_usage where ts_ms > ${nowMs - DAY_MS}`;
      const oldest = (value: unknown) => value == null ? undefined : Number(value);
      if (Number(counts.hourly_count) >= (kind === "preview" ? cfg.previewIpHourly : cfg.ipHourly)) {
        return { ok: false, reason: "ip_hourly", retryAfterSec: retryAfter(oldest(counts.hourly_oldest), nowMs, HOUR_MS) };
      }
      if (Number(counts.daily_count) >= (kind === "preview" ? cfg.previewGlobalDaily : cfg.globalDaily)) {
        return { ok: false, reason: "global_daily", retryAfterSec: retryAfter(oldest(counts.daily_oldest), nowMs, DAY_MS) };
      }
      if (kind !== "preview" && Number(counts.daily_cost) + reserveMicroUsd > cfg.dailyBudgetMicroUsd) {
        return { ok: false, reason: "daily_budget", retryAfterSec: retryAfter(oldest(counts.budget_oldest ?? counts.daily_oldest), nowMs, DAY_MS) };
      }
      const [row] = await tx`
        insert into public.chat_usage (kind, ts_ms, ip_hash, cost_micro_usd)
        values (${kind}, ${nowMs}, ${ipHash}, ${kind === "preview" ? 0 : reserveMicroUsd})
        returning id`;
      return { ok: true, id: String(row.id) };
    });
  }

  async settle({ id, tokens, costMicroUsd }: Parameters<ChatLimiter["settle"]>[0]): Promise<void> {
    await this.sql`
      update public.chat_usage
      set tokens = ${tokens}, cost_micro_usd = case when kind = 'preview' then 0 else ${costMicroUsd} end
      where id = ${id}`;
  }
}
