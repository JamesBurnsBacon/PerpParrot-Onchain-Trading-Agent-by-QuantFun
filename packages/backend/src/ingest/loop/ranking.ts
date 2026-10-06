import type { Account, Selection } from "./store";

// Score on a worker so a broad registry cannot block the lease heartbeat or HTTP.
export async function rankAsync(accounts: Account[], now: number, limit = 100, signal?: AbortSignal): Promise<Selection[]> {
  signal?.throwIfAborted();
  const worker = new Worker(new URL("./rank-worker.ts", import.meta.url).href);
  return new Promise((resolve, reject) => {
    const clean = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); worker.terminate(); };
    const abort = () => { clean(); reject(signal?.reason ?? new Error("Ranking cancelled")); };
    const timer = setTimeout(() => { clean(); reject(new Error("Ranking exceeded 120 seconds")); }, 120_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = event => {
      clean();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.selected);
    };
    worker.onerror = event => { clean(); reject(new Error(event.message)); };
    worker.postMessage({ accounts, now, limit });
  });
}
