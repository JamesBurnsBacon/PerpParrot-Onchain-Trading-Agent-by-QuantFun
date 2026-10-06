import type { Account, Selection } from "./store";

// Score on a worker so a broad registry cannot block the lease heartbeat or HTTP.
export async function rankAsync(accounts: Account[], now: number): Promise<Selection[]> {
  const worker = new Worker(new URL("./rank-worker.ts", import.meta.url).href);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Ranking exceeded 120 seconds")); }, 120_000);
    worker.onmessage = event => {
      clearTimeout(timer); worker.terminate();
      if (event.data.error) reject(new Error(event.data.error)); else resolve(event.data.selected);
    };
    worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ accounts, now });
  });
}
