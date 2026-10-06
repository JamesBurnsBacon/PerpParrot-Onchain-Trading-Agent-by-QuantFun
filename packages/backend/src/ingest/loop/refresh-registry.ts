import { LoopStore } from "./store";
import { activateFreshRegistry, freshAccounts } from "./import-release";
import type { Collector } from "./service";

/** Bounded, resumable bootstrap refresh. Historic ranking is an acquisition queue,
 * never a fresh score. Each account becomes usable only after official collection.
 */
export async function refreshRegistry(store: LoopStore, collector: Collector, limit = 100,
  now: () => number = Date.now, signal: AbortSignal = new AbortController().signal) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Refresh limit must be between 1 and 500");
  const queue = store.state<string[]>("releaseRefreshQueue");
  if (!queue) throw new Error("Import a portable release before refreshing it");
  const owner = store.claim(now()); if (!owner) throw new Error("Another registry worker owns the lease");
  const abort = new AbortController(), combined = AbortSignal.any([signal, abort.signal, AbortSignal.timeout(540_000)]);
  const heartbeat = setInterval(() => { try { store.renew(owner, now()); } catch (error) { abort.abort(error); } }, 15_000);
  let refreshed = 0;
  try {
    const fresh = new Set(freshAccounts(store.accounts(), now()).map(a => a.input.address));
    for (const address of queue.filter(a => (!fresh.has(a) || store.health(a).consecutiveFailures >= 2)
      && store.health(a).quarantinedUntil <= now()).slice(0, limit)) {
      combined.throwIfAborted(); store.assertOwner(owner, now());
      store.accountAttempt(address, owner, now());
      let result;
      try { result = await collector.collect(store.account(address), combined); }
      catch (error) {
        if (!combined.aborted) store.accountAttempt(address, owner, now(), { error: String(error) });
        throw error;
      }
      if (result.account.input.address !== address || freshAccounts([result.account], now()).length !== 1) throw new Error("Refresh did not produce fresh bound evidence");
      store.raw(result.account.rawHash);
      store.db.transaction(() => {
        store.assertOwner(owner, now()); store.putAccount(result.account);
        store.accountAttempt(address, owner, now(), { success: true }); refreshed++; fresh.add(address);
        store.setState("releaseRefreshProgress", { at: now(), refreshedThisAttempt: refreshed,
          freshAccounts: fresh.size, totalAccounts: queue.length });
      })();
    }
    const readiness = await activateFreshRegistry(store, now(), () => store.assertOwner(owner, now()));
    store.assertOwner(owner, now());
    return { marker: "INGEST_RELEASE_REFRESHED", refreshed, ...readiness };
  } finally { clearInterval(heartbeat); store.release(owner); }
}
