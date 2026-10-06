import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { screenEvidence, type ScreenRow } from "../research-screen";
import type { Candidate } from "../types";
import { readGzipRows } from "./export-data";

// Stream the release without holding all raw portfolio strings in memory.
// Replay again with each 100-response arrival block reversed; canonical output
// must be identical, regardless of response arrival order.
export async function replayResearch(directory: string) {
  const candidates = new Map<string, Candidate>(), expected = new Map<string, ScreenRow>();
  for await (const c of readGzipRows<Candidate>(join(directory, "discovery.jsonl.gz"))) candidates.set(c.address, c);
  for await (const r of readGzipRows<ScreenRow>(join(directory, "research-screen.jsonl.gz"))) expected.set(r.address, r);
  type Evidence = { address: string; raw: string; sha256: string; fetchedAt: string };
  const passes: { hash: string; count: number; mismatches: string[] }[] = [];
  for (const reordered of [false, true]) {
    const results = new Map<string, string>(), mismatches: string[] = [], buffer: Evidence[] = [];
    const evaluate = (e: Evidence) => {
      const c = candidates.get(e.address), original = expected.get(e.address);
      if (!c || !original || results.has(e.address)) throw new Error("Missing/duplicate replay identity");
      const result = screenEvidence(e, c, Date.parse(original.evaluatedAt)), raw = JSON.stringify(result);
      if (raw !== JSON.stringify(original)) mismatches.push(e.address);
      results.set(e.address, raw);
    };
    for await (const e of readGzipRows<Evidence>(join(directory, "portfolios.jsonl.gz"))) {
      if (!reordered) evaluate(e);
      else { buffer.push(e); if (buffer.length === 100) while (buffer.length) evaluate(buffer.pop()!); }
    }
    while (buffer.length) evaluate(buffer.pop()!);
    if (results.size !== expected.size || results.size !== candidates.size) throw new Error("Replay coverage mismatch");
    const hash = createHash("sha256");
    for (const address of [...results.keys()].sort()) hash.update(results.get(address)! + "\n");
    passes.push({ hash: hash.digest("hex"), count: results.size, mismatches });
  }
  return { schema: "research-replay.v1", passes, identical: passes[0].hash === passes[1].hash && passes.every(p => p.mismatches.length === 0) };
}

if (import.meta.main) {
  const directory = resolve(Bun.argv[2] ?? "data/score-handoff-2026-10-06"), result = await replayResearch(directory);
  await writeFile(join(directory, "research-replay.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result)); if (!result.identical) process.exitCode = 1;
}
