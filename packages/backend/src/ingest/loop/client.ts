import { RpcError, SOURCES, type Fetcher } from "../client";
import { LoopStore } from "./store";
import { randomUUID } from "node:crypto";

export class BudgetClient {
  requests = 0;
  retries = 0;
  rateLimited = 0;
  private context: { runId: string; slot: number; address: string } | null = null;
  setContext(value: { runId: string; slot: number; address: string } | null) { this.context = value; }
  constructor(private store: LoopStore, private fetcher: Fetcher = fetch,
    private now: () => number = Date.now, private sleep: (ms: number) => Promise<void> = Bun.sleep) {}

  async request(url: string, body: object | undefined, signal: AbortSignal, weight = 20,
    actualWeight?: (json: unknown) => number): Promise<string> {
    if (url !== SOURCES.info && url !== SOURCES.hyperevm && url !== SOURCES.vaults) throw new Error("Only official acquisition endpoints are allowed");
    const rpc = url === SOURCES.hyperevm, scope = rpc ? "rpc" : "info", capacity = rpc ? 80 : 800;
    const operationId = randomUUID();
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      let reservation;
      for (;;) {
        reservation = this.store.reserve(scope, weight, capacity, this.now());
        if (!reservation.wait) break;
        await this.wait(reservation.wait, signal);
      }
      this.requests++;
      const id = randomUUID(), startedAt = this.now(), context = this.context;
      const record = (result: Record<string, unknown>) => this.store.requestAttempt(id, context?.runId ?? null,
        { id, operationId, ...context, endpoint: url, method: body ? "POST" : "GET", request: body ?? null,
          attempt: attempt + 1, startedAt, finishedAt: this.now(), reservedWeight: weight, ...result });
      record({ status: "started" });
      let response: Response;
      try {
        response = await this.fetcher(url, { method: body ? "POST" : "GET",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.any([signal, AbortSignal.timeout(25_000)]) });
      } catch {
        record({ status: "failed", error: signal.aborted ? "cancelled" : "network-or-timeout" });
        signal.throwIfAborted();
        if (attempt === 2) throw new Error(`Network/timeout failure: ${new URL(url).hostname}`);
        this.retries++; await this.wait(1000 * 2 ** attempt, signal); continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        record({ status: "failed", httpStatus: response.status, error: "http-error", retryAfter: response.headers.get("retry-after") });
        if (response.status === 429) this.rateLimited++;
        if ((response.status === 429 || response.status >= 500) && attempt < 2) {
          const value = response.headers.get("retry-after");
          const seconds = value === null ? NaN : Number(value);
          const retryAt = value !== null && !Number.isFinite(seconds) ? Date.parse(value) : NaN;
          const delay = Number.isFinite(seconds) ? Math.max(0, seconds * 1000)
            : Number.isFinite(retryAt) ? Math.max(0, retryAt - this.now()) : 1000 * 2 ** attempt;
          this.retries++; await this.wait(delay, signal); continue;
        }
        throw new Error(`HTTP ${response.status}: ${new URL(url).hostname}`);
      }
      const reader = response.body?.getReader();
      if (!reader) { record({ status: "failed", httpStatus: response.status, error: "missing-body" }); throw new Error("Missing response body"); }
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 64 * 1024 * 1024) throw new Error("Oversized response");
          chunks.push(value);
        }
      } catch (error) { record({ status: "failed", httpStatus: response.status, error: "incomplete-or-oversized-body" }); await reader.cancel().catch(() => {}); throw error; }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const raw = new TextDecoder().decode(bytes), rawHash = this.store.blob(raw);
      let json: unknown;
      try { json = JSON.parse(raw); }
      catch (error) { record({ status: "failed", httpStatus: response.status, rawHash, error: "invalid-json" }); throw error; }
      let actual = weight;
      if (actualWeight) {
        actual = actualWeight(json);
        if (!Number.isSafeInteger(actual) || actual < 1 || actual > weight) {
          record({ status: "failed", httpStatus: response.status, rawHash, error: "weight-exceeds-reservation" });
          throw new Error("Response exceeds reserved rate-limit weight");
        }
        this.store.refund(reservation.id, actual);
      }
      record({ status: "success", httpStatus: response.status, rawHash, bytes: size, actualWeight: actual });
      return raw;
    }
    throw new Error("Retries exhausted");
  }
  private async wait(ms: number, signal: AbortSignal) {
    // Chunk long Retry-After values so shutdown/deadline is noticed promptly.
    for (let left = ms; left > 0; left -= 1000) { signal.throwIfAborted(); await this.sleep(Math.min(1000, left)); }
    signal.throwIfAborted();
  }
  async rpc(method: "eth_blockNumber" | "eth_chainId" | "eth_getCode" | "eth_call", params: unknown[], signal: AbortSignal) {
    const data = JSON.parse(await this.request(SOURCES.hyperevm, { jsonrpc: "2.0", id: 1, method, params }, signal, 1));
    if (data.error) throw new RpcError(data.error.code, data.error.message);
    if (typeof data.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(data.result)) throw new Error("Invalid RPC result");
    return data.result as `0x${string}`;
  }
}
