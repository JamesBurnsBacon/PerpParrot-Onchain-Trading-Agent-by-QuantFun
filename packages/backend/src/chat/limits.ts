export type LimitConfig = { ipHourly: number; previewIpHourly: number; globalDaily: number; dailyBudgetMicroUsd: number };
export type Kind = "chat" | "preview";
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
    if (hourly.length >= (kind === "chat" ? cfg.ipHourly : cfg.previewIpHourly)) {
      return { ok: false, reason: "ip_hourly", retryAfterSec: retryAfter(oldest(hourly), nowMs, HOUR_MS) };
    }
    const chats = rows.filter((row) => row.kind === "chat");
    if (chats.length >= cfg.globalDaily) {
      return { ok: false, reason: "global_daily", retryAfterSec: retryAfter(oldest(chats), nowMs, DAY_MS) };
    }
    if (kind === "chat" && rows.reduce((sum, row) => sum + row.costMicroUsd, 0) + reserveMicroUsd > cfg.dailyBudgetMicroUsd) {
      return { ok: false, reason: "daily_budget", retryAfterSec: retryAfter(oldest(rows), nowMs, DAY_MS) };
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
