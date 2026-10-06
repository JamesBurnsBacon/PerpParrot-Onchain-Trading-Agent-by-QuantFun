import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipRows, readGzipRows } from "../src/ingest/loop/export-data";
import { verifyAssets } from "../src/ingest/loop/load-data";

const directories: string[] = [];
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }); });
async function dir() { const path = await mkdtemp(join(tmpdir(), "score-export-")); directories.push(path); return path; }
test("compressed handoff preserves response strings and verifies compressed-byte checksums", async () => {
  const path = await dir(), data = [{ address: "0x1", raw: '[ [ "month", {} ] ]\n' }, { address: "0x2", tradeCount: null }];
  const asset = await gzipRows(path, "evidence.jsonl.gz", data);
  const rows = []; for await (const row of readGzipRows(join(path, asset.file))) rows.push(row);
  expect(rows).toEqual(data); expect(asset.rows).toBe(2);
  const manifest = { schema: "score-data-release.v1", status: "complete", files: [asset] };
  await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
  expect((await verifyAssets(path)).files).toEqual([asset]);
  const bytes = await readFile(join(path, asset.file)); bytes[bytes.length - 1] ^= 1;
  await writeFile(join(path, asset.file), bytes);
  await expect(verifyAssets(path)).rejects.toThrow("integrity");
});
test("loader rejects path traversal in an untrusted asset manifest", async () => {
  const path = await dir();
  await writeFile(join(path, "manifest.json"), JSON.stringify({ schema: "score-data-release.v1", status: "complete", files: [{ file: "../outside.gz" }] }));
  await expect(verifyAssets(path)).rejects.toThrow("filename");
});
