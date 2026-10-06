import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { LoopStore } from "./store";
import { importRegistry } from "./import-registry";
import { OfficialCollector } from "./collect";
import { LoopService } from "./service";
import { digest } from "../store";
import { importRelease } from "./import-release";
import { refreshRegistry } from "./refresh-registry";

// A backend job entry point: optional read-only registry import, then one official
// API cycle. No process.env credentials, exchange client or scheduled side effects.
const { values } = parseArgs({ strict: true, options: {
  db: { type: "string" }, "import-from": { type: "string" }, out: { type: "string" },
  "import-release": { type: "string" }, "refresh-stale": { type: "boolean" }, "refresh-limit": { type: "string", default: "100" },
  "import-only": { type: "boolean" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("bun --no-env-file src/ingest/loop/once.ts --db NEW.sqlite [--import-release RELEASE_DIRECTORY | --import-from EXISTING.sqlite] [--refresh-stale --refresh-limit 100] [--import-only] [--out DIRECTORY]\nImported evidence remains local; --out writes aggregate, address-free validation evidence only. Stale releases require official refresh before the worker is ready.");
} else {
  if (!values.db) throw new Error("--db is required; use a separate database for a rehearsal");
  if (values["import-from"] && values["import-release"]) throw new Error("Choose one import source");
  const path = resolve(values.db);
  if (values["import-from"] && resolve(values["import-from"]) === path) throw new Error("Source and destination must differ");
  const store = new LoopStore(path), service = new LoopService(store, new OfficialCollector(store));
  const abort = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { abort.abort(); void service.stop(); });
  try {
    if (values["import-from"]) console.log(JSON.stringify(await importRegistry(resolve(values["import-from"]), store)));
    if (values["import-release"]) console.log(JSON.stringify(await importRelease(resolve(values["import-release"]), store)));
    if (values["refresh-stale"]) console.log(JSON.stringify(await refreshRegistry(store, new OfficialCollector(store), Number(values["refresh-limit"]), Date.now, abort.signal)));
    if (!values["import-only"]) {
      const run = service.trigger();
      const result = await service.execute(run);
      const completed = store.run(run.id)!;
      if (completed.status !== "complete" || !completed.artifactHash) throw new Error("Cycle did not produce a complete publication");
      const artifact = JSON.parse(store.raw(completed.artifactHash));
      const proof = {
        schema: "ingest-validation.v1", checkedAt: new Date().toISOString(), dataKind: "live-public-api-read",
        runId: run.id, bucket: run.bucket, artifactSha256: completed.artifactHash,
        success: artifact.count, failure: artifact.provenance.failure, selected: run.selected.length,
        substitutions: artifact.substitutions?.length ?? 0, failedAccountAttempts: artifact.accountFailures?.length ?? 0,
        nextSelected: artifact.nextSelection.length, registryCount: artifact.registryCount,
        strictEligibleInBatch: artifact.strict.candidates.filter((c: { eligible: boolean }) => c.eligible).length,
        scoreSourceSha256: artifact.provenance.scoreSourceSha256,
        targetListSha256: artifact.provenance.targetListSha256,
        scoreConfigSha256: artifact.provenance.scoreConfigSha256,
        scoreScope: artifact.scoreScope, allowUnknown: artifact.strict.config.allowUnknown,
        inputAsOfRange: artifact.inputAsOfRange, durationSeconds: artifact.durationSeconds,
        upstream: artifact.upstream, requestAttempts: artifact.requestAttempts.length,
        historyWarningCount: artifact.historyWarnings.length,
        externalWrites: 0, ordersSubmitted: 0, databaseKind: "local-sqlite",
      };
      if (values.out) {
        const out = resolve(values.out); await mkdir(out, { recursive: true });
        const text = JSON.stringify(proof, null, 2) + "\n";
        await writeFile(join(out, "ingest-validation.json"), text);
        await writeFile(join(out, "SHA256SUMS"), digest(text) + "  ingest-validation.json\n");
      }
      console.log(JSON.stringify({ result, proof }));
    }
  } finally { await service.stop(); store.close(); }
}
