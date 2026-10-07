// HTTP routes, separate from server startup so tests can drive them directly.
import { timingSafeEqual } from "node:crypto";
import type { Runner } from "./runner";
import { summarize } from "./store";
import { dueRunAt, RUN_INTERVAL_SECONDS } from "./targets";
import type { ExecutorStore } from "./store";

export type AppDeps = {
  runner: Runner;
  store: ExecutorStore;
  // The public dashboard reads (/status, /runs, /equity): Supabase's transaction pooler when
  // EXECUTOR_READ_DATABASE_URL is set, so they don't use up the session pooler runs need.
  readStore?: ExecutorStore;
  adminToken?: string;
  watchdog?: () => Promise<Record<string, unknown>>;
  cronSecret?: string;
  status: () => Record<string, unknown>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  // Unix ms (tests pin it).
  now?: () => number;
};

// Starts runAt's run unless another trigger (cron retry, a second instance, the timer) already
// claimed it, and waits for it: the cron request, or the operator, gets the outcome.
export const triggerRun = async (deps: Pick<AppDeps, "runner" | "store" | "log">, runAt: number) => {
  if (!(await deps.store.claimRun(`mirror-${runAt}`))) return { status: "duplicate" as const, runId: `mirror-${runAt}` };
  const run = await deps.runner.executeRun(runAt);
  deps.log("run finished", { runId: run.runId, status: run.status, orders: run.plan?.orders.length, error: run.error });
  return summarize(run);
};

// BigInts (target exposures) don't serialize natively.
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v)), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// The public dashboard reads /status and /runs from the browser.
const PUBLIC = { "Access-Control-Allow-Origin": "*" };

const authorized = (req: Request, token?: string): boolean => {
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token || given.length !== token.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(token));
};

const thin = <T,>(points: T[], max: number): T[] => points.length <= max ? points : Array.from({ length: max }, (_, i) => points[Math.round(i * (points.length - 1) / (max - 1))]);
const equityCaches = new WeakMap<AppDeps, { at: number; body: { runs: number; points: [number, number][] } }>();

export const createApp = (deps: AppDeps) => async (req: Request): Promise<Response> => {
  const { pathname: rawPath, searchParams } = new URL(req.url);
  const pathname = rawPath.replace(/^\/api\/executor(?=\/|$)/, "") || "/";

  if (req.method === "GET" && pathname === "/health") return json({ ok: true });
  if (req.method === "GET" && pathname === "/status") {
    return json({ ...deps.status(), controls: await (deps.readStore ?? deps.store).getControls() }, 200, PUBLIC);
  }
  // Public run log: plans, order results and what each run traded toward (README §4.11).
  if (req.method === "GET" && pathname === "/runs") {
    const summary = searchParams.get("summary") === "1";
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 20) || 20, 1), summary ? 500 : 200);
    const reads = deps.readStore ?? deps.store;
    return json(await (summary ? reads.recentRunSummaries(limit) : reads.recentRuns(limit)), 200, PUBLIC);
  }
  if (req.method === "GET" && pathname === "/equity") {
    const now = Date.now(); let cached = equityCaches.get(deps);
    if (!cached || now - cached.at > 60_000) {
      const all = await (deps.readStore ?? deps.store).equityCurve();
      cached = { at: now, body: { runs: all.length, points: thin(all.filter((p) => !p.dryRun).map((p): [number, number] => [p.t, p.equityUsd]), 1500) } };
      equityCaches.set(deps, cached);
    }
    return json(cached.body, 200, PUBLIC);
  }

  // Authenticated cron-compatible trigger; root vercel.json does not schedule it.
  // The long-running host owns the :x0 timer (server.ts).
  if (req.method === "GET" && pathname === "/cron/run") {
    if (!authorized(req, deps.cronSecret)) return json({ error: "unauthorized" }, 401);
    const runAt = dueRunAt((deps.now ?? Date.now)());
    if (runAt === null) return json({ status: "no run due" });
    return json(await triggerRun(deps, runAt));
  }

  if (req.method === "GET" && pathname === "/cron/watchdog" && deps.watchdog) {
    if (!authorized(req, deps.cronSecret)) return json({ error: "unauthorized" }, 401);
    return json(await deps.watchdog());
  }

  if (req.method === "GET" && pathname === "/admin/order-batches") {
    if (!authorized(req, deps.adminToken)) return json({ error: "unauthorized" }, 401);
    return json(await deps.store.unresolvedOrderBatches());
  }

  if (req.method === "POST" && pathname.startsWith("/admin/")) {
    if (!authorized(req, deps.adminToken)) return json({ error: "unauthorized" }, 401);
    const by = req.headers.get("x-operator") ?? "admin";
    // A run for a given slot: a missed run, or a local end-to-end test that asks for the next
    // :x0 ahead of time (the backend only builds a snapshot near its run time).
    if (pathname === "/admin/run") {
      let payload: unknown;
      try { payload = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const runAt = (payload as { runAt?: unknown })?.runAt;
      const now = Math.floor((deps.now ?? Date.now)() / 1000);
      if (!Number.isSafeInteger(runAt) || (runAt as number) % RUN_INTERVAL_SECONDS !== 0 || Math.abs((runAt as number) - now) > RUN_INTERVAL_SECONDS + 300) {
        return json({ error: "runAt must be a :x0 run time within 15 minutes of now" }, 400);
      }
      deps.log("run requested", { runAt, by });
      return json(await triggerRun(deps, runAt as number));
    }
    if (pathname === "/admin/reconcile-batch") {
      let payload: unknown;
      try { payload = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const body = payload as { id?: unknown; evidence?: unknown };
      if (typeof body?.id !== "string" || body.id.length > 200 || typeof body?.evidence !== "string" || body.evidence.trim().length < 40 || body.evidence.trim().length > 2_000) {
        return json({ error: "batch id and reconciliation evidence (at least 40 characters) are required" }, 400);
      }
      const id = body.id, evidence = body.evidence;
      let result: { unresolved: number } | { error: string };
      try {
        // Behind any run (same lock); the batch is checked before anything changes, so a wrong id
        // leaves the controls as they were.
        result = await deps.runner.exclusive(async () => {
          if (!(await deps.store.unresolvedOrderBatches()).some((batch) => batch.id === id)) return { error: `order batch ${id} is not unresolved` };
          // Controls are left as they are: runs reconcile on their own, and only a human pauses.
          await deps.store.reconcileOrderBatch(id, by, evidence, Date.now());
          return { unresolved: (await deps.store.unresolvedOrderBatches()).length };
        });
      } catch (e) {
        return json({ error: `a run is in progress; retry: ${(e as Error).message}` }, 409);
      }
      if ("error" in result) return json(result, 409);
      deps.log("order batch reconciled", { id, by, remaining: result.unresolved });
      return json({ reconciled: id, ...result });
    }
    switch (pathname) {
      case "/admin/pause":
      case "/admin/resume": {
        const paused = pathname === "/admin/pause";
        if (paused) {
          // Keep the kill switch prompt: the active run sees this durable flag
          // before its next exchange batch. An already dispatched request cannot
          // be recalled, and the route must not wait for the run lock.
          const controls = { paused: true, updatedAt: Date.now(), updatedBy: by };
          await deps.store.setControls(controls);
          deps.log("controls changed", controls);
          return json(controls);
        }
        // Unresolved order actions don't block a resume: the next run reconciles them automatically.
        let controls: { paused: boolean; updatedAt: number; updatedBy: string };
        try {
          controls = await deps.runner.exclusive(async () => {
            const next = { paused: false, updatedAt: Date.now(), updatedBy: by };
            await deps.store.setControls(next);
            return next;
          });
        } catch (e) {
          return json({ error: `a run is in progress; retry: ${(e as Error).message}` }, 409);
        }
        deps.log("controls changed", controls);
        return json(controls);
      }
      case "/admin/flatten": {
        // Pause first so the next run doesn't reopen what we're closing.
        await deps.store.setControls({ paused: true, updatedAt: Date.now(), updatedBy: by });
        const run = await deps.runner.flatten(by);
        deps.log("flatten", { status: run.status, orders: run.plan?.orders.length, error: run.error });
        return json(run);
      }
    }
  }
  return json({ error: "not found" }, 404);
};
