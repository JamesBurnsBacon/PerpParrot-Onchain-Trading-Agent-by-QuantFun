import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { DEFAULT_CONFIG, computeMetrics } from "../../score";
import type { ScoreInput } from "../../score";
import { computeFilters } from "../../score/filters";
import { orderEvidence } from "../score-input";
import { digest } from "../store";
import { LoopStore } from "./store";

export type Asset = { file: string; format: "jsonl+gzip"; rows: number; bytes: number; sha256: string };
export async function gzipRows(out: string, file: string, rows: AsyncIterable<unknown> | Iterable<unknown>): Promise<Asset> {
  await mkdir(out, { recursive: true });
  let count = 0;
  const hash = createHash("sha256"), destination = join(out, file);
  async function* lines() { for await (const row of rows) { count++; yield JSON.stringify(row) + "\n"; } }
  await pipeline(Readable.from(lines()), createGzip({ level: 6 }),
    new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } }),
    createWriteStream(destination + ".part"));
  await rename(destination + ".part", destination);
  return { file, format: "jsonl+gzip", rows: count, bytes: (await stat(destination)).size, sha256: hash.digest("hex") };
}

export async function* readGzipRows<T>(path: string): AsyncGenerator<T> {
  const source = createReadStream(path), unzip = createGunzip();
  const errors = pipeline(source, unzip).catch(error => { unzip.destroy(error); });
  const lines = createInterface({ input: unzip, crlfDelay: Infinity });
  try { for await (const line of lines) if (line.trim()) yield JSON.parse(line); }
  finally { lines.close(); source.destroy(); unzip.destroy(); await errors; }
}

export async function scoreSourceHash() {
  const root = resolve(import.meta.dir, "../../score"), hash = createHash("sha256");
  for (const file of (await readdir(root)).filter(f => f.endsWith(".ts")).sort()) {
    hash.update(file + "\0"); hash.update(await readFile(join(root, file))); hash.update("\0");
  }
  return hash.digest("hex");
}

export async function exportFirstPass(root: string, candidatePath: string, out: string) {
  const screen = JSON.parse(await readFile(join(root, "screening-v1/screening.json"), "utf8"));
  if (screen.summary?.status !== "complete") throw new Error("First pass must be complete");
  const candidates = JSON.parse(await readFile(candidatePath, "utf8"));
  const byAddress = new Map(candidates.map((c: { address: string }) => [c.address, c]));
  const rows = [...screen.rows].sort((a, b) => a.address.localeCompare(b.address));
  if (rows.length !== byAddress.size || new Set(rows.map(r => r.address)).size !== rows.length) throw new Error("Discovery/screen count mismatch");
  async function* evidence() {
    for (const row of rows) {
      const e = JSON.parse(await readFile(join(root, "evidence", `${row.address}.json`), "utf8"));
      if (e.address !== row.address || digest(e.raw) !== e.sha256 || e.sha256 !== row.evidenceSha256) throw new Error("Evidence hash/address mismatch");
      // Keep response bytes intact, but never export a personal provider hostname.
      yield { schema: "portfolio-evidence.v1", address: e.address, fetchedAt: e.fetchedAt,
        sha256: e.sha256, raw: e.raw, provider: String(e.sourceHost).endsWith("quiknode.pro") ? "quicknode" : "hyperliquid-official",
        acquisition: e.origin };
    }
  }
  const files = [await gzipRows(out, "portfolios.jsonl.gz", evidence()),
    await gzipRows(out, "discovery.jsonl.gz", rows.map(row => byAddress.get(row.address))),
    await gzipRows(out, "research-screen.jsonl.gz", rows)];
  const manifest = { schema: "score-data-release.v1", status: "awaiting-evidence-bootstrap", exportedAt: new Date().toISOString(),
    sourceScreenAt: screen.summary.updatedAt, counts: { scanned: rows.length, research: screen.summary.counts }, files };
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

export async function exportVerified(store: LoopStore, out: string) {
  const complete = store.state("bootstrapComplete");
  if (!complete) throw new Error("Evidence bootstrap is not complete");
  // Freeze the small registry snapshot once. Content-addressed blobs are immutable
  // even if a concurrent ten-minute cycle advances the live registry afterwards.
  const accounts = store.accounts(), inputs: ScoreInput[] = [], audit: unknown[] = [];
  for (const a of accounts) {
    const check = store.state<{ status: string; [key: string]: unknown }>(`bootstrap:${a.input.address}`);
    if (!check) throw new Error("Unchecked account in completed registry");
    if (a.basis === "verified-input" && a.classification !== null) inputs.push(a.input);
    const fills = a.fillsHash ? JSON.parse(store.raw(a.fillsHash)) : null;
    const proof = orderEvidence(fills, a.input.month!.pnlHistory.at(-1)![0]);
    if (a.input.tradeCount !== proof.tradeCount) throw new Error("Stored trade count disagrees with raw proof");
    audit.push({ address: a.input.address, status: check.status, includedInScoreInputs: a.basis === "verified-input" && a.classification !== null,
      fetchedAt: a.fetchedAt, portfolioSha256: a.rawHash, classification: a.classification, classificationAt: a.classificationAt,
      filledOrdersObserved: proof.observed, tradeCount: a.input.tradeCount, fillsSha256: a.fillsHash, fillsCheckedAt: a.fillsCheckedAt,
      investigation: store.state(`investigation:${a.input.address}`),
      filters: computeFilters(a.input, computeMetrics(a.input), DEFAULT_CONFIG) });
  }
  async function* proofs() {
    for (const a of accounts) {
      if (a.basis !== "verified-input" || !a.classification) continue;
      yield { schema: "score-evidence.v1", address: a.input.address,
        portfolio: { fetchedAt: a.fetchedAt, sha256: a.rawHash, raw: store.raw(a.rawHash) },
        fills: a.fillsHash ? { fetchedAt: a.fillsCheckedAt, sha256: a.fillsHash, raw: store.raw(a.fillsHash) } : null,
        classification: a.classification, classificationAt: a.classificationAt };
    }
  }
  const files = [await gzipRows(out, "score-inputs.jsonl.gz", inputs), await gzipRows(out, "account-audit.jsonl.gz", audit),
    await gzipRows(out, "score-evidence.jsonl.gz", proofs())];
  const manifestPath = join(out, "manifest.json"), manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest, { status: "complete", exportedAt: new Date().toISOString(), bootstrap: complete,
    scoreSourceSha256: await scoreSourceHash(), scoreConfig: DEFAULT_CONFIG,
    scoreInputScope: "regular research candidates with fetched classification and order evidence; strict filters still apply",
    files: [...manifest.files.filter((f: Asset) => !files.some(newFile => newFile.file === f.file)), ...files] });
  Object.assign(manifest.counts, { regularCandidates: accounts.length, scoreInputs: inputs.length,
    excludedBeforeEvidence: accounts.length - inputs.length });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (import.meta.main) {
  const args = Bun.argv.slice(2), get = (key: string) => {
    const index = args.indexOf(`--${key}`); if (index === -1 || !args[index + 1]) throw new Error(`Missing --${key}`); return args[index + 1];
  };
  const out = resolve(get("out"));
  if (get("phase") === "first-pass") console.log(JSON.stringify(await exportFirstPass(resolve(get("root")), resolve(get("candidates")), out)));
  else if (get("phase") === "verified") {
    const store = new LoopStore(resolve(get("db")));
    try { console.log(JSON.stringify(await exportVerified(store, out))); } finally { store.close(); }
  } else throw new Error("--phase must be first-pass or verified");
}
