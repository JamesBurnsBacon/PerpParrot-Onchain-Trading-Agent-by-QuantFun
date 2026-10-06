// HTTP routes, separate from server startup so tests can drive them directly.
import { timingSafeEqual } from "node:crypto";
import type { ReportEnvelope } from "../../shared/report";
import { handleReport, type HandlerDeps } from "./handler";
import type { Runner } from "./runner";
import type { ExecutorStore } from "./store";

export type AppDeps = {
  handler: Omit<HandlerDeps, "accept" | "claim">;
  runner: Runner;
  store: ExecutorStore;
  adminToken?: string;
  status: () => Record<string, unknown>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
};

// BigInts (report exposures) don't serialize natively.
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

// At most `max` points: every point if it fits, else evenly spaced ones including both ends.
const thin = <T,>(points: T[], max: number): T[] => {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]);
};

// /equity responses per app (one per process; tests make several).
const equityCaches = new WeakMap<AppDeps, { at: number; body: { runs: number; points: [number, number][] } }>();

export const createApp = (deps: AppDeps) => async (req: Request): Promise<Response> => {
  const { pathname, searchParams } = new URL(req.url);

  if (req.method === "GET" && pathname === "/health") return json({ ok: true });
  if (req.method === "GET" && pathname === "/status") {
    return json({ ...deps.status(), controls: await deps.store.getControls() }, 200, PUBLIC);
  }
  // Public run log: plans, order results and raw signed reports (README §4.11).
  // ?summary=1 drops plan, results and report (up to 500 runs: ~3.5 days).
  if (req.method === "GET" && pathname === "/runs") {
    const summary = searchParams.get("summary") === "1";
    const max = summary ? 500 : 200;
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 20) || 20, 1), max);
    return json(await (summary ? deps.store.recentRunSummaries(limit) : deps.store.recentRuns(limit)), 200, PUBLIC);
  }

  // The live account's equity at every executed run since the start, at most 1,500 points
  // (evenly thinned, first and last kept). Cached for a minute: it changes once per run.
  if (req.method === "GET" && pathname === "/equity") {
    const now = Date.now();
    let cached = equityCaches.get(deps);
    if (!cached || now - cached.at > 60_000) {
      const all = await deps.store.equityCurve();
      cached = { at: now, body: { runs: all.length, points: thin(all, 1500) } };
      equityCaches.set(deps, cached);
    }
    return json(cached.body, 200, PUBLIC);
  }

  if (req.method === "POST" && pathname === "/reports") {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    const result = await handleReport(payload, {
      ...deps.handler,
      claim: (id) => deps.store.claimReport(id),
      accept: (report, envelope: ReportEnvelope) => {
        deps.runner.executeReport(report, envelope).then(
          (run) => deps.log("run finished", { runId: run.runId, status: run.status, orders: run.plan?.orders.length, error: run.error }),
          (e) => deps.log("run crashed", { runId: report.body.runId, error: (e as Error).message }),
        );
      },
    });
    deps.log("report", { status: result.status, ...result.body });
    return json(result.body, result.status);
  }

  if (req.method === "POST" && pathname.startsWith("/admin/")) {
    if (!authorized(req, deps.adminToken)) return json({ error: "unauthorized" }, 401);
    const by = req.headers.get("x-operator") ?? "admin";
    switch (pathname) {
      case "/admin/pause":
      case "/admin/resume": {
        const controls = { paused: pathname === "/admin/pause", updatedAt: Date.now(), updatedBy: by };
        await deps.store.setControls(controls);
        deps.log("controls changed", controls);
        return json(controls);
      }
      case "/admin/flatten": {
        // Pause first so the next report doesn't reopen what we're closing.
        await deps.store.setControls({ paused: true, updatedAt: Date.now(), updatedBy: by });
        const run = await deps.runner.flatten(by);
        deps.log("flatten", { status: run.status, orders: run.plan?.orders.length, error: run.error });
        return json(run);
      }
    }
  }
  return json({ error: "not found" }, 404);
};
