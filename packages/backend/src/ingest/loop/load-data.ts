import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parsePortfolio, scoreCandidates, type ScoreInput } from "../../score";
import { digest } from "../store";
import { orderEvidence } from "../score-input";
import { gzipRows, readGzipRows, scoreSourceHash, type Asset } from "./export-data";

export async function verifyAssets(directory: string) {
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  if (manifest.schema !== "score-data-release.v1" || manifest.status !== "complete" || !Array.isArray(manifest.files)) throw new Error("Incomplete/invalid data release");
  for (const asset of manifest.files as Asset[]) {
    if (!/^[a-z0-9-]+\.jsonl\.gz$/.test(asset.file)) throw new Error("Invalid asset filename");
    const hash = createHash("sha256"); let size = 0;
    for await (const chunk of createReadStream(join(directory, asset.file))) { hash.update(chunk); size += chunk.length; }
    if (size !== asset.bytes || hash.digest("hex") !== asset.sha256) throw new Error(`Asset integrity failure: ${asset.file}`);
  }
  return manifest;
}

export async function loadScoreInputs(directory: string): Promise<ScoreInput[]> {
  const manifest = await verifyAssets(directory), inputs: ScoreInput[] = [];
  for await (const input of readGzipRows<ScoreInput>(join(directory, "score-inputs.jsonl.gz"))) inputs.push(input);
  if (inputs.length !== manifest.counts.scoreInputs || new Set(inputs.map(i => i.address)).size !== inputs.length) throw new Error("Score input count/uniqueness mismatch");
  return inputs;
}

export async function verifyOrderProofs(directory: string, inputs: ScoreInput[]) {
  const byAddress = new Map(inputs.map(input => [input.address, input])), seen = new Set<string>();
  type Evidence = { address: string; portfolio: { raw: string; sha256: string }; fills: { raw: string; sha256: string } | null; classification: { kind: string } };
  for await (const row of readGzipRows<Evidence>(join(directory, "score-evidence.jsonl.gz"))) {
    const input = byAddress.get(row.address);
    if (!input || seen.has(row.address) || digest(row.portfolio.raw) !== row.portfolio.sha256
      || (row.fills && digest(row.fills.raw) !== row.fills.sha256)) throw new Error("Evidence integrity/count mismatch");
    seen.add(row.address);
    const windows = parsePortfolio(JSON.parse(row.portfolio.raw));
    if (JSON.stringify(windows.month) !== JSON.stringify(input.month) || JSON.stringify(windows.allTime) !== JSON.stringify(input.allTime)) throw new Error("Input disagrees with portfolio evidence");
    const proof = orderEvidence(row.fills ? JSON.parse(row.fills.raw) : null, input.month!.pnlHistory.at(-1)![0]);
    if (proof.tradeCount !== input.tradeCount || row.classification.kind !== input.kind) throw new Error("Input disagrees with classification/order proof");
  }
  if (seen.size !== inputs.length) throw new Error("Missing input evidence");
}

if (import.meta.main) {
  const directory = resolve(Bun.argv[2] ?? "data/score-handoff-2026-10-06");
  const started = Date.now(), manifest = await verifyAssets(directory);
  if (await scoreSourceHash() !== manifest.scoreSourceSha256) throw new Error("Score implementation differs from the release; use its pinned commit to reproduce");
  const inputs = await loadScoreInputs(directory);
  await verifyOrderProofs(directory, inputs);
  const result = scoreCandidates(inputs);
  const selected = result.candidates.filter(c => c.eligible && c.score !== null).slice(0, 100);
  await writeFile(join(directory, "top100.json"), JSON.stringify({ schema: "strict-top100.v1", scope: "verified regular research candidates",
    scoreSourceSha256: manifest.scoreSourceSha256, scoreConfig: result.config, selected }, null, 2) + "\n");
  const asset = await gzipRows(directory, "score-results.jsonl.gz", result.candidates);
  manifest.files = [...manifest.files.filter((file: Asset) => file.file !== asset.file), asset];
  manifest.counts.strictEligible = result.candidates.filter(c => c.eligible && c.score !== null).length;
  manifest.counts.top100 = selected.length;
  await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(JSON.stringify({ verified: inputs.length, strictEligible: manifest.counts.strictEligible,
    selected: selected.length, elapsedSeconds: (Date.now() - started) / 1000, allowUnknown: result.config.allowUnknown }));
}
