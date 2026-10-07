// Routes Hyperliquid info reads between the official API and NOWNodes' copy (hype.nownodes.io).
// A fetch-shaped function, so it drops into PacedInfo's `fetchImpl` and `info()` unchanged.
//
// INFO_ROUTING (default "official" = today's behavior, byte for byte):
//   official  official API only; NOWNODES_API_KEY is not even read.
//   overflow  official first; only when it answers 429/5xx or throws does a NOWNodes-capable read go to
//             NOWNodes. The normal path is untouched, so this can only turn failures into successes.
//   split     INFO_SPLIT_PERCENT (default 25) of NOWNodes-capable reads go to NOWNodes first, failing over to
//             the official API. NOWNodes measured ~1.7x slower, so benchmark before using it by default.
// INFO_SHADOW_PERCENT (default 0): that share of official clearinghouseState reads is also sent to NOWNodes in
// the background and compared; nothing waits for it.
//
// NOWNodes' copy answers 422 for portfolio, userFillsByTime, userFunding, metaAndAssetCtxs, vaultDetails,
// allMids, l2Book and candleSnapshot (measured 2026-10-07), so those never leave the official API.

import { probeCapabilities, type CapabilityReport } from "./capability-probe";

const OFFICIAL_URL = "https://api.hyperliquid.xyz/info";
export const NOWNODES_URL ="https://hype.nownodes.io/info";

export const NOWNODES_CAPABLE = new Set([
  "meta",
  "perpDexs",
  "clearinghouseState",
  "spotClearinghouseState",
  "webData2",
  "userVaultEquities",
  "spotMeta",
  "vaultSummaries",
]);

const FALLBACK_TIMEOUT_MS = 15_000;
const BREAKER_FAILURES = 3;
const BREAKER_PAUSE_MS = 60_000;
const PROBE_TTL_MS = 6 * 60 * 60_000;

export type Provider = "official" | "nownodes";
export type ProviderStats = { requests: number; errors: number; totalMs: number };
export type RoutingStats = {
  mode: string;
  official: ProviderStats;
  nownodes: ProviderStats;
  fallbacks: number; // reads that failed on the first provider and succeeded on the other
  shadow: { compared: number; mismatches: number };
  breakerOpen: boolean;
  // The last NOWNodes capability probe (NOWNODES_PROBE=on); null before it ran or when it is off.
  capabilities: CapabilityReport | null;
};

type Env = Record<string, string | undefined>;
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type RouterOptions = {
  env?: () => Env;
  fetchImpl?: FetchFn; // late-bound to the global fetch by default so test mocks of it still apply
  now?: () => number;
  log?: (msg: string, data?: Record<string, unknown>) => void;
};

const bodyType = (init?: RequestInit): string | null => {
  if (typeof init?.body !== "string") return null;
  try {
    const t = (JSON.parse(init.body) as { type?: unknown }).type;
    return typeof t === "string" ? t : null;
  } catch {
    return null;
  }
};

const failed = (res: Response) => res.status === 429 || res.status >= 500;

// True when `b` is within a rounding hair of `a` (the two nodes answer a moment apart).
const close = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(a), Math.abs(b));

export const makeRoutedFetch = (o: RouterOptions = {}) => {
  const env = o.env ?? (() => process.env);
  const base: FetchFn = o.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const now = o.now ?? Date.now;
  const log = o.log ?? ((msg, data) => console.warn(msg, data ?? {}));

  const stats: RoutingStats = {
    mode: "official",
    official: { requests: 0, errors: 0, totalMs: 0 },
    nownodes: { requests: 0, errors: 0, totalMs: 0 },
    fallbacks: 0,
    shadow: { compared: 0, mismatches: 0 },
    breakerOpen: false,
    capabilities: null,
  };
  // Methods the probe found NOWNodes answering 422 for although the allowlist serves them.
  let denied = new Set<string>();
  let probing = false;
  let probeNextAt = 0;
  let consecutiveFailures = 0;
  let pausedUntil = 0;
  let splitCounter = 0;
  let shadowCounter = 0;

  const call = async (provider: Provider, init: RequestInit, key: string | undefined, signal?: AbortSignal): Promise<Response> => {
    const s = stats[provider];
    s.requests++;
    const started = now();
    try {
      const headers = new Headers(init.headers);
      if (provider === "nownodes") headers.set("api-key", key ?? "");
      // The key must never follow a redirect to another host.
      const guard: RequestInit = provider === "nownodes" ? { redirect: "error" } : {};
      const res = await base(provider === "nownodes" ? NOWNODES_URL : OFFICIAL_URL, { ...init, ...guard, headers, signal: signal ?? init.signal });
      if (!res.ok) s.errors++;
      if (provider === "nownodes") {
        consecutiveFailures = res.ok ? 0 : consecutiveFailures + 1;
        if (consecutiveFailures >= BREAKER_FAILURES) pausedUntil = now() + BREAKER_PAUSE_MS;
      }
      return res;
    } catch (e) {
      s.errors++;
      if (provider === "nownodes" && ++consecutiveFailures >= BREAKER_FAILURES) pausedUntil = now() + BREAKER_PAUSE_MS;
      throw e;
    } finally {
      s.totalMs += now() - started;
    }
  };

  // The caller's request, untouched, with only the counters around it.
  const direct = async (url: string, init?: RequestInit): Promise<Response> => {
    const s = stats.official;
    s.requests++;
    const started = now();
    try {
      const res = await base(url, init);
      if (!res.ok) s.errors++;
      return res;
    } catch (e) {
      s.errors++;
      throw e;
    } finally {
      s.totalMs += now() - started;
    }
  };

  type State = { marginSummary?: { accountValue?: string }; assetPositions?: unknown[] };
  const shadowCompare = async (init: RequestInit, official: Response, key: string) => {
    try {
      const [a, b] = await Promise.all([
        official.clone().json() as Promise<State>,
        call("nownodes", init, key, AbortSignal.timeout(FALLBACK_TIMEOUT_MS)).then((r) => (r.ok ? r.json() : null)) as Promise<State | null>,
      ]);
      if (!b) return;
      stats.shadow.compared++;
      const sameValue = close(Number(a.marginSummary?.accountValue ?? NaN), Number(b.marginSummary?.accountValue ?? NaN));
      const samePositions = (a.assetPositions?.length ?? -1) === (b.assetPositions?.length ?? -2);
      if (!sameValue || !samePositions) {
        stats.shadow.mismatches++;
        log("info-router shadow mismatch", { sameValue, samePositions });
      }
    } catch {
      // The shadow read is best effort; it never affects the caller.
    }
  };

  // A read the caller aborted on purpose is not retried; one that merely timed out is (with a fresh timeout).
  const cancelledByCaller = (init: RequestInit) => !!init.signal?.aborted && (init.signal.reason as { name?: string } | undefined)?.name !== "TimeoutError";
  const retrySignal = (init: RequestInit) => {
    const timeout = AbortSignal.timeout(FALLBACK_TIMEOUT_MS);
    const caller = init.signal;
    return !caller || caller.aborted ? timeout : AbortSignal.any([caller, timeout]);
  };

  const routed = async (url: string, init?: RequestInit): Promise<Response> => {
    const e = env();
    const mode = e.INFO_ROUTING === "overflow" || e.INFO_ROUTING === "split" ? e.INFO_ROUTING : "official";
    stats.mode = mode;
    const key = e.NOWNODES_API_KEY;
    const type = bodyType(init);
    const shadowPercent = Number(e.INFO_SHADOW_PERCENT ?? 0);
    // Background comparison of an official clearinghouseState answer; never awaited.
    const maybeShadow = (res: Response) => {
      if (key && init && type === "clearinghouseState" && shadowPercent > 0 && res.ok && (++shadowCounter * shadowPercent) % 100 < shadowPercent) void shadowCompare(init, res, key);
      return res;
    };
    // NOWNODES_PROBE=on (needs a routing mode and a key): a background probe of what NOWNodes serves, at most
    // every PROBE_TTL_MS per process. It only narrows the allowlist; a failed probe changes nothing.
    if (mode !== "official" && key && e.NOWNODES_PROBE === "on" && !probing && now() >= probeNextAt) {
      probing = true;
      probeNextAt = now() + PROBE_TTL_MS;
      void probeCapabilities({ url: NOWNODES_URL, key, allowlist: NOWNODES_CAPABLE, fetchImpl: base, now })
        .then((report) => {
          stats.capabilities = report;
          denied = new Set(report.narrowed);
          if (report.narrowed.length) log("info-router capability probe narrowed the allowlist", { narrowed: report.narrowed });
        })
        .catch(() => {})
        .finally(() => {
          probing = false;
        });
    }
    const capable = mode !== "official" && !!key && !!init && type !== null && NOWNODES_CAPABLE.has(type) && !denied.has(type) && url === OFFICIAL_URL;
    if (!capable) return url === OFFICIAL_URL ? maybeShadow(await direct(url, init)) : base(url, init);
    stats.breakerOpen = now() < pausedUntil;
    const nownodesFirst = mode === "split" && !stats.breakerOpen && (++splitCounter * Number(e.INFO_SPLIT_PERCENT ?? 25)) % 100 < Number(e.INFO_SPLIT_PERCENT ?? 25);

    const first: Provider = nownodesFirst ? "nownodes" : "official";
    const second: Provider = nownodesFirst ? "official" : "nownodes";
    // Official: 429/5xx is a failure (anything else is the caller's to handle, as today). NOWNodes: any non-2xx.
    const bad = (p: Provider, r: Response) => (p === "official" ? failed(r) : !r.ok);
    let firstRes: Response | null = null;
    let firstErr: unknown = null;
    try {
      firstRes = await call(first, init, key);
      if (!bad(first, firstRes)) return first === "official" ? maybeShadow(firstRes) : firstRes;
    } catch (err) {
      firstErr = err;
    }
    const giveUp = () => {
      if (firstRes) return firstRes;
      throw firstErr;
    };
    if (cancelledByCaller(init!)) return giveUp();
    if (second === "nownodes" && now() < pausedUntil) return giveUp(); // breaker open: do not retry on NOWNodes
    try {
      const retry = await call(second, init!, key, retrySignal(init!));
      if (!bad(second, retry)) {
        stats.fallbacks++;
        return retry;
      }
      // Both failed: hand back the official answer (its Retry-After matters to the pacer).
      return first === "official" ? giveUp() : retry;
    } catch {
      return giveUp();
    }
  };

  return Object.assign(routed, { stats: () => ({ ...stats, breakerOpen: now() < pausedUntil }) as RoutingStats });
};

// The process-wide router: reads INFO_ROUTING / NOWNODES_API_KEY from the environment on every call.
export const routedFetch = makeRoutedFetch();
export const routingStats = () => routedFetch.stats();

// Large batches of position reads (the overlap pick): NOWNodes first, the official API as the fallback.
// A separate instance, so it keeps its own counters and circuit breaker. Needs NOWNODES_API_KEY.
export const bulkFetch = makeRoutedFetch({ env: () => ({ ...process.env, INFO_ROUTING: "split", INFO_SPLIT_PERCENT: "100", INFO_SHADOW_PERCENT: "0" }) });
export const bulkRoutingStats = () => bulkFetch.stats();
