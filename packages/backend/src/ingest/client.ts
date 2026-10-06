export const SOURCES = {
  leaderboard: "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard",
  vaults: "https://stats-data.hyperliquid.xyz/Mainnet/vaults",
  info: "https://api.hyperliquid.xyz/info",
  hyperevm: "https://rpc.hyperliquid.xyz/evm",
} as const;

export class RpcError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type Options = { spacingMs?: number; retries?: number; fetcher?: Fetcher };

// A serial start-rate limiter. API and HyperEVM RPC use separate instances.
export class ReadClient {
  private tail: Promise<void> = Promise.resolve();
  private nextStart = 0;
  private readonly fetcher: Fetcher;
  private readonly spacingMs: number;
  private readonly retries: number;
  constructor(options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.spacingMs = options.spacingMs ?? 1500;
    this.retries = options.retries ?? 2;
  }

  request(url: string, body?: object, timeoutMs = 25000, maxBytes = 32 * 1024 * 1024): Promise<string> {
    const operation = this.tail.then(() => this.run(url, body, timeoutMs, maxBytes));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async run(url: string, body: object | undefined, timeoutMs: number, maxBytes: number) {
    for (let attempt = 0; ; attempt++) {
      await Bun.sleep(Math.max(0, this.nextStart - Date.now()));
      this.nextStart = Date.now() + this.spacingMs;
      let res: Response;
      try {
        res = await this.fetcher(url, {
          method: body ? "POST" : "GET",
          headers: body ? { "Content-Type": "application/json" } : {},
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        if (attempt >= this.retries) throw new Error(`Network/timeout failure at ${new URL(url).hostname}`);
        await Bun.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel();
        if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
          const seconds = Number(res.headers.get("retry-after"));
          await Bun.sleep(Number.isFinite(seconds) && seconds > 0
            ? Math.min(10000, seconds * 1000) : 1000 * 2 ** attempt);
          continue;
        }
        throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("Empty HTTP body");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > maxBytes) throw new Error(`Response exceeds ${maxBytes} bytes`);
          chunks.push(value);
        }
      } catch {
        await reader.cancel().catch(() => {});
        // Body/parse failures are explicit and do not become cached valid responses.
        throw new Error(`Incomplete or oversized response from ${new URL(url).hostname}`);
      }
      const all = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
      return new TextDecoder().decode(all);
    }
  }

  async rpc(method: "eth_blockNumber" | "eth_chainId" | "eth_getCode" | "eth_call", params: unknown[]) {
    const raw = await this.request(SOURCES.hyperevm, { jsonrpc: "2.0", id: 1, method, params });
    const data = JSON.parse(raw) as { result?: unknown; error?: { code: number; message: string } };
    if (data.error) throw new RpcError(data.error.code, data.error.message);
    if (typeof data.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(data.result)) throw new Error(`Invalid RPC result for ${method}`);
    return data.result as `0x${string}`;
  }
}
