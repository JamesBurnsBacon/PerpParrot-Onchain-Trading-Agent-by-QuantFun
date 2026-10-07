// Hyperliquid reads for the pipeline, paced under a weight budget. HL allows 1200 weight/min per
// IP; most info calls cost 20, plus 1 per 20 items returned for fills. The pipeline keeps to
// `perMinute` so the mirror loop's own reads (a few dozen weight per run) always fit.

const INFO_URL = "https://api.hyperliquid.xyz/info";

export class PacedInfo {
  private spent = 0;
  private readonly started = Date.now();

  constructor(
    private readonly perMinute = 600,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep = (ms: number) => Bun.sleep(ms),
  ) {}

  // Waits until `weight` more fits the budget since this client was created, then posts.
  async post<T>(body: Record<string, unknown>, weight = 20, itemsPerWeight?: (value: T) => number): Promise<T> {
    const due = this.started + ((this.spent + weight) / this.perMinute) * 60_000;
    if (due > Date.now()) await this.sleep(due - Date.now());
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchImpl(INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 429 && attempt < 2) {
        await this.sleep(Number(res.headers.get("retry-after") ?? 0) * 1000 || 10_000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HL info ${body.type} failed: ${res.status}`);
      const value = (await res.json()) as T;
      this.spent += weight + (itemsPerWeight ? Math.floor(itemsPerWeight(value) / 20) : 0);
      return value;
    }
  }
}

// The big public files (no info weight): ~40 MB and ~14 MB.
export const getJson = async <T>(url: string, timeoutMs = 150_000): Promise<T> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
};
