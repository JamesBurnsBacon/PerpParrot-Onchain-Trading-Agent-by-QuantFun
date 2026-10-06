import { digest } from "../store";
import type { Collector } from "./service";
import { requireCollection } from "./checks";
import { rankAsync } from "./ranking";
import { LoopStore, bucketAt, INTERVAL_MS, TARGET_COUNT, type Account, type Selection } from "./store";

export const BACKGROUND_POLICY = { maxAccounts: 20, sliceMs: 45_000, foregroundReserveMs: 60_000, minAgeMs: 3_600_000 } as const;
export type Catchup = { runId: string; at: number; reason: string; failedAddresses: string[] };

export function availableAccounts(store: LoopStore, accounts: Account[], now: number) {
  const health = store.healthMap();
  const catchup = store.state<Catchup>("foregroundNeedsRefresh");
  // Cooldown expiry permits an API probe, not promotion of the old failed cache.
  // Only a successful collection resets consecutiveFailures and restores ranking.
  return accounts.filter(a => (health.get(a.input.address)?.quarantinedUntil ?? 0) <= now
    && (health.get(a.input.address)?.consecutiveFailures ?? 0) < 2
    && (!catchup?.failedAddresses.includes(a.input.address)
      || ((health.get(a.input.address)?.lastSuccessAt ?? -1) >= catchup.at
        && (health.get(a.input.address)?.consecutiveFailures ?? 0) === 0)));
}

/** Single-host idle work shares the foreground lease and the collector's durable
 * request budget. Each visited account is persisted before moving to the next. */
export async function backgroundRefresh(store: LoopStore, collector: Collector, now: () => number = Date.now,
  signal: AbortSignal = new AbortController().signal, policy: { maxAccounts: number; sliceMs: number; foregroundReserveMs: number; minAgeMs: number } = BACKGROUND_POLICY) {
  if (!store.state("seed")) return { status: "no-registry" };
  const remaining = bucketAt(now()) + INTERVAL_MS - now();
  if (remaining <= policy.foregroundReserveMs) return { status: "foreground-reserved" };
  const owner = store.claim(now()); if (!owner) return { status: "worker-busy" };
  const abort = new AbortController(), deadline = Math.min(policy.sliceMs, remaining - policy.foregroundReserveMs);
  const timer = setTimeout(() => abort.abort(new Error("Background slice complete")), deadline);
  const combined = AbortSignal.any([signal, abort.signal]);
  const heartbeat = setInterval(() => { try { store.renew(owner, now()); } catch (error) { abort.abort(error); } }, 15_000);
  const startedAt = now(), id = `refresh-${startedAt}`;
  let attempted = 0, refreshed = 0, failures = 0, interrupted = false;
  try {
    const accounts = store.accounts(), health = store.healthMap();
    // A previous slice may have saved rows but run out of time before ranking.
    // Give that pending computation a whole slice before making more API calls.
    const rankingOnly = !!store.state("backgroundRankingPending");
    const catchup = store.state<Catchup>("foregroundNeedsRefresh");
    const protectedSet = new Set(!catchup && store.state("bootstrapComplete")
      ? store.state<{ selected: Selection[] }>("selection")?.selected.map(a => a.address) ?? [] : []);
    const queue = rankingOnly ? [] : accounts.filter(a => !protectedSet.has(a.input.address)
      && (health.get(a.input.address)?.quarantinedUntil ?? 0) <= now()
      && (!(health.get(a.input.address)?.consecutiveFailures ?? 0)
        || now() - (health.get(a.input.address)?.lastAttemptAt ?? 0) >= 60_000)
      && (now() - Date.parse(a.fetchedAt) >= policy.minAgeMs
        || (catchup && (health.get(a.input.address)?.consecutiveFailures ?? 0) > 0)))
      .sort((a, b) => Math.max(Date.parse(a.fetchedAt), health.get(a.input.address)?.lastAttemptAt ?? 0)
        - Math.max(Date.parse(b.fetchedAt), health.get(b.input.address)?.lastAttemptAt ?? 0)
        || a.input.address.localeCompare(b.input.address))
      .slice(0, policy.maxAccounts);
    for (const account of queue) {
      if (combined.aborted || bucketAt(now()) + INTERVAL_MS - now() <= policy.foregroundReserveMs || now() - startedAt >= deadline) break;
      const address = account.input.address;
      store.accountAttempt(address, owner, now()); attempted++;
      collector.client?.setContext?.({ runId: id, slot: attempted - 1, address });
      try {
        const result = await collector.collect(account, combined);
        combined.throwIfAborted(); requireCollection(store, result, address, now());
        store.db.transaction(() => {
          store.assertOwner(owner, now()); store.putAccount(result.account);
          store.accountAttempt(address, owner, now(), { success: true }); refreshed++;
          store.setState("backgroundRankingPending", { at: now(), runId: id });
        })();
      } catch (error) {
        if (combined.aborted) { interrupted = true; break; }
        store.accountAttempt(address, owner, now(), { error: String(error) }); failures++;
      }
      store.db.transaction(() => {
        store.assertOwner(owner, now());
        store.setState("backgroundProgress", { runId: id, at: now(), attempted, refreshed, failures, lastVisited: address });
      })();
    }
    if ((refreshed || rankingOnly) && !combined.aborted) {
      const registry = store.accounts(), selected = await rankAsync(availableAccounts(store, registry, now()), now(), TARGET_COUNT, combined);
      combined.throwIfAborted();
      store.db.transaction(() => {
        store.assertOwner(owner, now());
        const fresh = registry.filter(a => Date.parse(a.fetchedAt) <= now() && now() - Date.parse(a.fetchedAt) <= 86_400_000).length;
        const readiness = { at: now(), ready: selected.length === TARGET_COUNT, selected: selected.length,
          freshAccounts: fresh, totalAccounts: registry.length, selectionScope: "fresh-nonquarantined-registry",
          selectionSha256: digest(JSON.stringify(selected)) };
        store.setState("selection", readiness.ready ? { generatedAt: now(), selected, scope: readiness.selectionScope } : null);
        store.setState("bootstrapComplete", readiness.ready ? readiness : null);
        store.setState("releaseReadiness", readiness);
        store.setState("backgroundRankingPending", null);
        if (readiness.ready) store.setState("foregroundNeedsRefresh", null);
      })();
    }
  } catch (error) {
    if (!combined.aborted) throw error;
    interrupted = true;
  } finally {
    clearInterval(heartbeat); clearTimeout(timer); collector.client?.setContext?.(null);
    try { store.db.transaction(() => {
      store.assertOwner(owner, now());
      const previous = store.state<{ attempted: number; refreshed: number; failures: number }>("backgroundTotals");
      store.setState("backgroundTotals", { at: now(), attempted: (previous?.attempted ?? 0) + attempted,
        refreshed: (previous?.refreshed ?? 0) + refreshed, failures: (previous?.failures ?? 0) + failures });
      store.setState("backgroundLast", { runId: id, startedAt, finishedAt: now(), attempted, refreshed, failures, interrupted });
    })(); } catch { /* expired owners cannot write progress */ }
    store.release(owner);
  }
  return { status: interrupted ? "background-interrupted" : "background-complete", attempted, refreshed, failures };
}
