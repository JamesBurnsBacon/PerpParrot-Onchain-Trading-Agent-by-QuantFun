import { bucketAt, type LoopStore } from "./store";
import type { LoopService } from "./service";

export type Latest = { runId: string; bucket: number; completedAt: number; artifactHash: string; receiptHash: string; count: number };
export function loopHandler(store: LoopStore, service: LoopService, now: () => number = Date.now) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url), path = url.pathname;
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
    if (request.method === "GET" && path === "/health") {
      const latest = store.state<Latest>("latest");
      return json({ status: !latest ? "initializing" : now() - latest.completedAt > 900_000 ? "stale" : "ready",
        bootstrap: store.state("bootstrapProgress"), bootstrapComplete: store.state("bootstrapComplete"),
        progress: store.state("progress"), latest, lastRun: store.runs(1)[0] ?? null,
        background: { last: store.state("backgroundLast"), totals: store.state("backgroundTotals") },
        quarantinedAccounts: [...store.healthMap().values()].filter(h => h.consecutiveFailures >= 2).length });
    }
    if (request.method === "GET" && path === "/ingest/latest") {
      const latest = store.state<Latest>("latest");
      if (!latest) return json({ error: "No complete cycle yet" }, 503);
      if (latest.completedAt > now() || now() - latest.completedAt > 900_000) return json({ error: "Latest complete cycle is stale", latest }, 503);
      return json(latest);
    }
    const artifact = /^\/ingest\/artifacts\/([a-f0-9]{64})$/.exec(path);
    if (request.method === "GET" && artifact) {
      // Serve only committed complete artifacts, never arbitrary evidence blobs.
      if (!store.state(`published:${artifact[1]}`)) return json({ error: "Artifact not published" }, 404);
      return new Response(store.raw(artifact[1]), { headers: { "Content-Type": "application/json", ETag: artifact[1], "Cache-Control": "public,max-age=31536000,immutable" } });
    }
    const receipt = /^\/ingest\/receipts\/([a-f0-9]{64})$/.exec(path);
    if (request.method === "GET" && receipt) {
      if (!store.state(`receipt:${receipt[1]}`)) return json({ error: "Receipt not published" }, 404);
      return new Response(store.raw(receipt[1]), { headers: { "Content-Type": "application/json", ETag: receipt[1], "Cache-Control": "public,max-age=31536000,immutable" } });
    }
    const publication = /^\/ingest\/runs\/(ingest-[0-9]{10,13})\/publication$/.exec(path);
    if (request.method === "GET" && publication) {
      const fixed = store.state<Latest>(`publication:${publication[1]}`);
      return fixed ? json(fixed) : json({ error: "Requested bucket has no complete publication" }, 503);
    }
    const run = /^\/ingest\/runs\/(ingest-[0-9]{10,13})$/.exec(path);
    if (request.method === "GET" && run) {
      const found = store.run(run[1]); return found ? json(found) : json({ error: "Unknown run" }, 404);
    }
    if (request.method === "POST" && path === "/ingest/trigger") {
      // The server binds exclusively to loopback. Remote deployment must add
      // authenticated transport; an arbitrary network caller cannot burn quota.
      const text = await request.text();
      if (text.length > 1024) return json({ error: "Request too large" }, 413);
      try {
        const body = JSON.parse(text);
        if (!body || Object.keys(body).some(k => k !== "bucket") || body.bucket !== bucketAt(now())) throw new Error("Expected current bucket");
        const accepted = service.trigger(body.bucket);
        void service.start(accepted).catch(error => console.error("ingest run failed", String(error)));
        // Semantic acknowledgement is identical for a first submission/replay.
        return json({ accepted: true, runId: accepted.id, bucket: accepted.bucket }, 202);
      } catch (error) { return json({ error: String(error) }, 409); }
    }
    return json({ error: "Not found" }, 404);
  };
}
