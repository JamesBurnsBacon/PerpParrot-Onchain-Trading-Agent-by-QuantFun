// Missed-run watchdog for Vercel Cron, which calls GET /cron/watchdog every `everyMs`
// (vercel.json: 5 min). Mirror runs every 10 min, so no finished run for `afterMs` means
// CRE runs are failing or a run is stuck (README §4.7). Instances keep nothing between
// checks, so the last run comes from the store, and only the first check past `afterMs`
// alerts. The window has a minute of slack for cron jitter: rarely a second alert, never none.
import type { Alert } from "./alerts";
import type { ExecutorStore } from "./store";

export type WatchdogDeps = {
  store: Pick<ExecutorStore, "recentRunSummaries">;
  alert: Alert;
  now: () => number;
  afterMs: number;
  everyMs: number;
};

export const cronWatchdog = (deps: WatchdogDeps) => async () => {
  const [last] = await deps.store.recentRunSummaries(1);
  if (!last) return { lastFinishedAt: null, alerted: false };
  const sinceMs = deps.now() - last.finishedAt;
  const alerted = sinceMs >= deps.afterMs && sinceMs < deps.afterMs + deps.everyMs + 60_000;
  if (alerted) await deps.alert(`no finished run for ${Math.round(sinceMs / 60_000)} min (last: ${last.runId})`);
  return { lastFinishedAt: last.finishedAt, alerted };
};
