// Local positions snapshot API for `cre workflow simulate mirror` (README §4.7).
// Builds each snapshot from live HL data on first request, then serves the same
// bytes for that runAt so every node sees an identical response. Run: bun run dev
import frozenSet from "../fixtures/frozen-set.json";
import { fetchEligibleAssets } from "./eligibility";
import { buildSnapshot, frozenSetHash, type FrozenSource } from "./snapshot";

const port = Number(process.env.PORT ?? 8788);
const set = frozenSet.sources as FrozenSource[];
const snapshots = new Map<number, Promise<string>>();

Bun.serve({
  port,
  fetch(req) {
    const m = /^\/snapshots\/(\d+)$/.exec(new URL(req.url).pathname);
    if (req.method !== "GET" || !m) return new Response("not found", { status: 404 });

    const runAt = Number(m[1]);
    let body = snapshots.get(runAt);
    if (!body) {
      body = fetchEligibleAssets().then(async (eligible) => JSON.stringify(await buildSnapshot(set, eligible, runAt)));
      snapshots.set(runAt, body);
      body.catch(() => snapshots.delete(runAt));
    }
    return body.then(
      (json) => {
        console.log(`[snapshot] runAt=${runAt} bytes=${json.length}`);
        return new Response(json, { headers: { "Content-Type": "application/json" } });
      },
      (e) => Response.json({ error: (e as Error).message }, { status: 502 }),
    );
  },
});

console.log(`snapshot dev server on :${port}/snapshots/{runAt} frozenSetHash=${frozenSetHash(set)}`);
