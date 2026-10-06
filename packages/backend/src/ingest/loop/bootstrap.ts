import { readFile } from "node:fs/promises";
import { computeMetrics, DEFAULT_CONFIG, parsePortfolio } from "../../score";
import { computeFilters } from "../../score/filters";
import { classify } from "../classify";
import { RpcError } from "../client";
import { orderEvidence } from "../score-input";
import { normalizedMonth } from "../history";
import { LoopStore, type Account } from "./store";
import { rankAsync } from "./ranking";

// Used only for the one-off evidence bootstrap. Credential URLs are consumed
// opaquely from the user's existing private file and never stored in evidence.
export class BootstrapProvider {
  private next = 0;
  private pausedUntil = 0;
  requests = 0; retries = 0;
  private constructor(private info: string, private evm: string, private rps: number) {}
  static async open(path: string, rps = 5) {
    if (!Number.isFinite(rps) || rps <= 0 || rps > 10) throw new Error("Bootstrap RPS must be 0..10 under the provider quota");
    const value = (await readFile(path, "utf8")).trim(), url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".quiknode.pro") || url.hostname.startsWith("docs-demo.")
      || !/\/info\/?$/.test(url.pathname) || url.search || url.hash) throw new Error("A personal QuickNode /info endpoint is required");
    const rpc = new URL(url); rpc.pathname = rpc.pathname.replace(/\/info\/?$/, "/evm");
    return new BootstrapProvider(url.href, rpc.href, rps);
  }
  async request(kind: "info" | "evm", body: object, signal: AbortSignal): Promise<string> {
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      const start = Math.max(Date.now(), this.next, this.pausedUntil);
      this.next = start + 1000 / this.rps;
      await Bun.sleep(Math.max(0, start - Date.now()));
      while (Date.now() < this.pausedUntil) { signal.throwIfAborted(); await Bun.sleep(Math.min(1000, this.pausedUntil - Date.now())); }
      signal.throwIfAborted(); this.requests++;
      try {
        const response = await fetch(kind === "info" ? this.info : this.evm, { method: "POST",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
          signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
        if (!response.ok) {
          await response.body?.cancel();
          if ((response.status === 429 || response.status >= 500) && attempt < 3) {
            const value = response.headers.get("retry-after"), seconds = value === null ? NaN : Number(value);
            const parsed = value === null ? NaN : Date.parse(value);
            const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
              : Number.isFinite(parsed) ? Math.max(0, parsed - Date.now()) : 1000 * 2 ** attempt;
            this.pausedUntil = Math.max(this.pausedUntil, Date.now() + delay); this.retries++; continue;
          }
          throw new Error(`Provider HTTP ${response.status}`);
        }
        const raw = await response.text();
        if (raw.length > 8 * 1024 * 1024) throw new Error("Provider oversized response");
        JSON.parse(raw); return raw;
      } catch (e) {
        signal.throwIfAborted();
        if (e instanceof Error && /^Provider HTTP 4/.test(e.message)) throw e;
        if (attempt === 3) throw new Error("Provider request failed after retries");
        this.retries++; await Bun.sleep(1000 * 2 ** attempt);
      }
    }
    throw new Error("Provider retries exhausted");
  }
  async rpc(method: "eth_blockNumber" | "eth_chainId" | "eth_getCode" | "eth_call", params: unknown[], signal: AbortSignal) {
    const raw = await this.request("evm", { jsonrpc: "2.0", id: 1, method, params }, signal), data = JSON.parse(raw);
    if (data.error) throw new RpcError(data.error.code, String(data.error.message));
    if (typeof data.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(data.result)) throw new Error("Provider invalid RPC result");
    return data.result as `0x${string}`;
  }
}

export async function bootstrap(store: LoopStore, provider: BootstrapProvider, signal: AbortSignal, limit = Infinity) {
  const stop = new AbortController();
  signal = AbortSignal.any([signal, stop.signal]);
  const owner = store.claim(Date.now());
  if (!owner) throw new Error("Another pipeline worker is active");
  const heartbeat = setInterval(() => { try { store.renew(owner, Date.now()); } catch (e) { stop.abort(e); } }, 15_000);
  const started = Date.now(); let done = 0, skipped = 0, errors = 0;
  try {
    const accounts = store.accounts();
    const pending = accounts.filter(a => !store.state(`bootstrap:${a.input.address}`)).slice(0, limit);
    const chain = await provider.rpc("eth_chainId", [], signal);
    if (BigInt(chain) !== 999n) throw new Error("Expected HyperEVM mainnet chain 999");
    let block = await provider.rpc("eth_blockNumber", [], signal), blockAt = Date.now();
    let blockRefresh: Promise<void> | null = null;
    const currentBlock = async () => {
      if (Date.now() - blockAt > 30_000 && !blockRefresh) {
        blockRefresh = provider.rpc("eth_blockNumber", [], signal).then(value => { block = value; blockAt = Date.now(); })
          .finally(() => { blockRefresh = null; });
      }
      if (blockRefresh) await blockRefresh;
      return block;
    };
    const rpc = { rpc: (method: "eth_blockNumber" | "eth_chainId" | "eth_getCode" | "eth_call", params: unknown[]) => provider.rpc(method, params, signal) };
    const status = () => {
      const value = { phase: "bootstrap", total: accounts.length, pendingThisRun: pending.length - done,
        processedThisRun: done, skippedThisRun: skipped, errorsThisRun: errors, requests: provider.requests,
        retries: provider.retries, elapsedSeconds: (Date.now() - started) / 1000, updatedAt: new Date().toISOString() };
      store.setState("bootstrapProgress", value); return value;
    };
    let index = 0;
    const outcomes = await Promise.allSettled(Array.from({ length: 6 }, async () => {
      for (;;) {
        signal.throwIfAborted();
        const a = pending[index++]; if (!a) return;
        try {
          const filters = computeFilters(a.input, computeMetrics(a.input), DEFAULT_CONFIG);
          const failed = Object.entries(filters).filter(([key, value]) => key !== "minTrades" && key !== "notClosed" && value !== "pass");
          if (failed.length) {
            store.setState(`bootstrap:${a.input.address}`, { status: "excluded-by-score", filters: failed, checkedAt: new Date().toISOString() });
            skipped++; continue;
          }
          const endTime = a.input.month!.pnlHistory.at(-1)![0];
          // Ask for history ending at the actual portfolio endpoint: no future
          // executions are silently counted against an older observation.
          const request = { type: "userFillsByTime", user: a.input.address, startTime: Math.max(0, endTime - 90 * 86_400_000), endTime, aggregateByTime: true };
          let fillsRaw = await provider.request("info", request, signal), fills = JSON.parse(fillsRaw);
          if (!Array.isArray(fills) || fills.length > 2000) throw new Error("Invalid fills response");
          let observed = orderEvidence(fills, endTime);
          // Busy accounts may have aged out of the endpoint's retained fills.
          // Refresh both histories before accepting newer order evidence.
          if (observed.tradeCount === null) {
            const recent = await provider.request("info", { type: "userFills", user: a.input.address, aggregateByTime: true }, signal);
            const latest = JSON.parse(recent);
            if (!Array.isArray(latest) || latest.length > 2000) throw new Error("Invalid recent fills response");
            if (orderEvidence(latest, Date.now()).tradeCount !== null) {
              const raw = await provider.request("info", { type: "portfolio", user: a.input.address }, signal);
              a.fetchedAt = new Date().toISOString(); normalizedMonth(a.input.address, JSON.parse(raw), a.fetchedAt, "bootstrap-refresh");
              a.rawHash = store.blob(raw); Object.assign(a.input, parsePortfolio(JSON.parse(raw)));
              fillsRaw = recent; fills = latest; observed = orderEvidence(fills, a.input.month!.pnlHistory.at(-1)![0]);
            }
          }
          a.fillsHash = store.blob(fillsRaw); a.fillsCheckedAt = new Date().toISOString();
          a.input.tradeCount = observed.tradeCount;
          a.classification = await classify(a.candidate, rpc, await currentBlock());
          a.classificationAt = new Date().toISOString(); a.input.kind = a.classification.kind;
          a.input.closed = a.classification.kind === "erc4626-vault" ? null : false;
          a.basis = "verified-input";
          store.assertOwner(owner, Date.now()); store.putAccount(a);
          store.setState(`bootstrap:${a.input.address}`, { status: "checked", ordersObserved: observed.observed,
            minimumOrdersProven: observed.tradeCount !== null, classification: a.classification,
            fillsHash: a.fillsHash, checkedAt: a.fillsCheckedAt });
        } catch (error) {
          errors++; store.setState(`bootstrap-error:${a.input.address}`, { error: String(error), at: new Date().toISOString() });
          if (/Provider HTTP (401|402|403)/.test(String(error))) stop.abort(new Error("Provider authorization/quota needs attention"));
          // No success marker: failed addresses are retried on resume.
        } finally {
          done++; if (done % 25 === 0 || done === pending.length) console.log(JSON.stringify(status()));
        }
      }
    }));
    const rejected = outcomes.find(r => r.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const unchecked = store.accounts().filter(a => !store.state(`bootstrap:${a.input.address}`)).length;
    if (unchecked === 0) {
      const selected = await rankAsync(store.accounts(), Date.now());
      if (selected.length !== 100) throw new Error("Bootstrap checked all accounts but fewer than 100 pass strict Score");
      store.setState("selection", { generatedAt: Date.now(), sourceRun: "verified-bootstrap", selected });
      store.setState("bootstrapComplete", { at: new Date().toISOString(), checked: accounts.length, selected: selected.length });
    }
    return { ...status(), unchecked, complete: unchecked === 0 };
  } finally { clearInterval(heartbeat); store.release(owner); }
}
