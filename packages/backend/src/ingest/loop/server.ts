import { resolve } from "node:path";
import { LoopStore } from "./store";
import { OfficialCollector } from "./collect";
import { LoopService } from "./service";
import { loopHandler } from "./http";

const path = resolve(process.env.INGEST_LOOP_DB ?? "data/ingest-loop/loop.sqlite");
const port = Number(process.env.INGEST_LOOP_PORT ?? "8790");
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid loop port");
const store = new LoopStore(path), service = new LoopService(store, new OfficialCollector(store));
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: loopHandler(store, service) });
const tick = () => void service.tick().then(result => { if (result) console.log(JSON.stringify(result)); })
  .catch(error => console.error("cycle failed", String(error)));
const timer = setInterval(tick, 5000);
tick();
console.log(JSON.stringify({ status: "listening", url: `http://127.0.0.1:${server.port}`, intervalSeconds: 600, count: 100, provider: "official-hyperliquid" }));
// Drain the current request and release the lease on a normal restart. After a
// hard crash the persisted lease expires in 90s; committed per-account work stays.
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, async () => {
  clearInterval(timer); server.stop(true); await service.stop(); store.close(); process.exit(0);
});
