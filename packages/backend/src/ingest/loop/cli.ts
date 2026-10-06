import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { LoopStore } from "./store";
import { seedFirstPass } from "./seed";
import { bootstrap, BootstrapProvider } from "./bootstrap";

const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
  db: { type: "string", default: "data/ingest-loop/loop.sqlite" },
  "first-pass": { type: "string" }, candidates: { type: "string" },
  "endpoint-file": { type: "string" }, rps: { type: "string", default: "5" },
  limit: { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("ingest-loop <seed|bootstrap|status> --db PATH\nseed --first-pass DIRECTORY --candidates CANDIDATES_JSON\nbootstrap --endpoint-file PRIVATE_FILE [--rps 5] [--limit N]\nNo credentials are printed. Bootstrap reuses the one-off personal provider; ongoing cycles use official APIs.");
} else {
  const store = new LoopStore(resolve(values.db!)), abort = new AbortController();
  process.once("SIGINT", () => abort.abort()); process.once("SIGTERM", () => abort.abort());
  try {
    switch (positionals[0]) {
      case "seed":
        if (!values["first-pass"] || !values.candidates) throw new Error("--first-pass and --candidates required");
        console.log(JSON.stringify(await seedFirstPass(store, resolve(values["first-pass"]), resolve(values.candidates)), null, 2)); break;
      case "bootstrap":
        if (!values["endpoint-file"]) throw new Error("--endpoint-file required for the one-off bootstrap");
        const limit = values.limit ? Number(values.limit) : Infinity;
        if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid limit");
        console.log(JSON.stringify(await bootstrap(store, await BootstrapProvider.open(resolve(values["endpoint-file"]), Number(values.rps)), abort.signal, limit), null, 2)); break;
      case "status":
        console.log(JSON.stringify({ seed: store.state("seed"), bootstrap: store.state("bootstrapProgress"),
          bootstrapComplete: store.state("bootstrapComplete"), selection: store.state("selection"),
          latest: store.state("latest"), runs: store.runs() }, null, 2)); break;
      default: throw new Error("Expected seed, bootstrap, or status");
    }
  } catch (error) { console.error(error instanceof Error ? error.message : "Pipeline failed"); process.exitCode = 1; }
  finally { store.close(); }
}
