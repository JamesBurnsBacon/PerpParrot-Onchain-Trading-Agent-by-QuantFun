// Which Hyperliquid info methods does NOWNodes' copy (hype.nownodes.io/info) serve right now?
//
// info-router.ts keeps a fixed allowlist (NOWNODES_CAPABLE), measured by hand on 2026-10-07. This probes the
// provider with one minimal request per method and compares the answers with that list:
//   2xx            supported
//   422            unsupported (NOWNodes' answer for methods its copy does not serve)
//   anything else  inconclusive (429, 5xx, timeout, network): never changes anything
//
// The probe can only report, and narrow the allowlist (a method the list serves but NOWNodes now answers 422
// for stops going there). It never widens it: a newly supported method is shown, not used, until someone
// adds it to the list and tests it. Reads only; nothing here sends an order.

export type ProbeVerdict = "supported" | "unsupported" | "inconclusive";

export type ProbeRow = {
  method: string;
  status: number | null; // null: no HTTP answer (timeout or network error)
  verdict: ProbeVerdict;
  allowlisted: boolean;
  // The allowlist and the observation disagree (and the observation is conclusive).
  drift: boolean;
  ms: number;
};

export type CapabilityReport = {
  probedAt: number;
  rows: ProbeRow[];
  // Allowlisted but answered 422: the router stops sending these to NOWNodes.
  narrowed: string[];
  // Answered 2xx but not allowlisted: shown only.
  newlySupported: string[];
};

// A minimal request for each method, to keep the probe cheap. The account is a throwaway address. Only
// the first eight methods are on the allowlist; a body that is wrong for any other method (the vault
// address, say) changes that method's row, never what the router does.
const ADDRESS = "0x0000000000000000000000000000000000000001";
const VAULT = "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";

export const PROBE_BODIES: Record<string, Record<string, unknown>> = {
  meta: { type: "meta" },
  perpDexs: { type: "perpDexs" },
  clearinghouseState: { type: "clearinghouseState", user: ADDRESS },
  spotClearinghouseState: { type: "spotClearinghouseState", user: ADDRESS },
  webData2: { type: "webData2", user: ADDRESS },
  userVaultEquities: { type: "userVaultEquities", user: ADDRESS },
  spotMeta: { type: "spotMeta" },
  vaultSummaries: { type: "vaultSummaries" },
  portfolio: { type: "portfolio", user: ADDRESS },
  userFillsByTime: { type: "userFillsByTime", user: ADDRESS, startTime: 0 },
  userFunding: { type: "userFunding", user: ADDRESS, startTime: 0 },
  metaAndAssetCtxs: { type: "metaAndAssetCtxs" },
  vaultDetails: { type: "vaultDetails", vaultAddress: VAULT },
  allMids: { type: "allMids" },
  l2Book: { type: "l2Book", coin: "BTC" },
  candleSnapshot: { type: "candleSnapshot", req: { coin: "BTC", interval: "1h", startTime: 0 } },
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type ProbeOptions = {
  url: string;
  key: string;
  allowlist: ReadonlySet<string>;
  fetchImpl?: FetchFn;
  now?: () => number;
  timeoutMs?: number;
};

export const probeCapabilities = async (o: ProbeOptions): Promise<CapabilityReport> => {
  const base: FetchFn = o.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
  const now = o.now ?? Date.now;
  const probedAt = now();
  const rows = await Promise.all(
    Object.entries(PROBE_BODIES).map(async ([method, body]): Promise<ProbeRow> => {
      const started = now();
      let status: number | null = null;
      try {
        const res = await base(o.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "api-key": o.key },
          body: JSON.stringify(body),
          redirect: "error", // the key must never follow a redirect to another host
          signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
        });
        status = res.status;
        await res.body?.cancel();
      } catch {
        status = null;
      }
      const verdict: ProbeVerdict = status !== null && status >= 200 && status < 300 ? "supported" : status === 422 ? "unsupported" : "inconclusive";
      const allowlisted = o.allowlist.has(method);
      return { method, status, verdict, allowlisted, drift: (verdict === "supported" && !allowlisted) || (verdict === "unsupported" && allowlisted), ms: Math.max(0, now() - started) };
    }),
  );
  return {
    probedAt,
    rows,
    narrowed: rows.filter((r) => r.allowlisted && r.verdict === "unsupported").map((r) => r.method),
    newlySupported: rows.filter((r) => !r.allowlisted && r.verdict === "supported").map((r) => r.method),
  };
};
