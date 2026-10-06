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

export const createApp = (deps: AppDeps) => async (req: Request): Promise<Response> => {
  const { pathname, searchParams } = new URL(req.url);

  if (req.method === "GET" && pathname === "/health") return json({ ok: true });
  if (req.method === "GET" && pathname === "/status") {
    return json({ ...deps.status(), controls: await deps.store.getControls() }, 200, PUBLIC);
  }
  // Public run log: plans, order results and raw signed reports (README §4.11).
  if (req.method === "GET" && pathname === "/runs") {
    const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 20) || 20, 1), 200);
    return json(await deps.store.recentRuns(limit), 200, PUBLIC);
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

  if (req.method === "GET" && pathname === "/admin/order-batches") {
    if (!authorized(req, deps.adminToken)) return json({ error: "unauthorized" }, 401);
    return json(await deps.store.unresolvedOrderBatches());
  }

  if (req.method === "POST" && pathname.startsWith("/admin/")) {
    if (!authorized(req, deps.adminToken)) return json({ error: "unauthorized" }, 401);
    const by = req.headers.get("x-operator") ?? "admin";
    if (pathname === "/admin/reconcile-batch") {
      let payload: unknown;
      try { payload = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
      const body = payload as { id?: unknown; evidence?: unknown };
      if (typeof body?.id !== "string" || body.id.length > 200 || typeof body?.evidence !== "string" || body.evidence.trim().length < 40 || body.evidence.trim().length > 2_000) {
        return json({ error: "batch id and reconciliation evidence (at least 40 characters) are required" }, 400);
      }
      const result = await deps.store.withExecutionLock(async () => {
        await deps.store.setControls({ paused: true, updatedAt: Date.now(), updatedBy: `reconciliation:${by}` });
        await deps.store.reconcileOrderBatch(body.id as string, by, body.evidence as string, Date.now());
        const unresolved = await deps.store.unresolvedOrderBatches();
        return { unresolved: unresolved.length };
      });
      deps.log("order batch reconciled", { id: body.id, by, remaining: result.unresolved });
      return json({ reconciled: body.id, ...result, paused: true });
    }
    switch (pathname) {
      case "/admin/pause":
      case "/admin/resume": {
        const paused = pathname === "/admin/pause";
        if (paused) {
          // Keep the kill switch prompt: the active run sees this durable flag
          // before its next exchange batch. An already dispatched request cannot
          // be recalled, and the route must not wait for the execution lock.
          const controls = { paused: true, updatedAt: Date.now(), updatedBy: by };
          await deps.store.setControls(controls);
          deps.log("controls changed", controls);
          return json(controls);
        }
        const result = await deps.store.withExecutionLock(async () => {
          const unresolved = await deps.store.unresolvedOrderBatches();
          if (unresolved.length > 0) {
            await deps.store.setControls({ paused: true, updatedAt: Date.now(), updatedBy: `unresolved-order-batch:${unresolved[0].id}` });
            return { blocked: unresolved.length };
          }
          const controls = { paused: false, updatedAt: Date.now(), updatedBy: by };
          await deps.store.setControls(controls);
          return { controls };
        });
        if (result.blocked !== undefined) {
          return json({ error: "unresolved order actions must be reconciled before resume", unresolved: result.blocked, paused: true }, 409);
        }
        deps.log("controls changed", result.controls!);
        return json(result.controls);
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
