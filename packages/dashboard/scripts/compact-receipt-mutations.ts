// Offline guard proof: mutate disposable copies only; retain exact logs and hashes.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = fileURLToPath(new URL("../../..", import.meta.url)), temp = mkdtempSync(resolve(tmpdir(), "compact-receipt-mutations-"));
for (const path of ["packages/shared", "packages/backend/test/fixtures", "packages/dashboard/lib", "packages/dashboard/components", "packages/dashboard/test/fixtures"]) {
  mkdirSync(resolve(temp, path, ".."), { recursive: true }); cpSync(resolve(root, path), resolve(temp, path), { recursive: true });
}
symlinkSync(resolve(root, "packages/dashboard/node_modules"), resolve(temp, "packages/dashboard/node_modules"));
const cases = [
  { name: "hidden when never worked", key: "hidden", file: "packages/dashboard/components/parrot/useSentenceReceipts.ts",
    from: '!worked ? "off" : feed.paused ? "paused" : "ready"', to: 'feed.paused ? "paused" : "ready"' },
  { name: "late result updates only its own sentence", key: "late", file: "packages/dashboard/lib/parrot-judge-queue.ts",
    from: 'job.row.decision = result.value;', to: 'feed.rows[0].decision = result.value; job.row.decision = result.value;' },
];
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
function run(key: string, phase: string) {
  const result = spawnSync(process.execPath, ["run", "test/fixtures/sentence-receipts.fixture.ts", key], {
    cwd: resolve(temp, "packages/dashboard"), encoding: "utf8",
  });
  const output = (result.stdout ?? "") + (result.stderr ?? "");
  writeFileSync(resolve(temp, `${key}-${phase}.log`), output); return { code: result.status, output };
}
for (const c of cases) {
  const original = readFileSync(resolve(root, c.file)), hash = sha(original);
  if (run(c.key, "baseline").code !== 0) throw new Error(`Baseline failed: ${temp}`);
  console.log(`GREEN baseline: ${c.name}`);
  const changed = original.toString().replace(c.from, c.to);
  if (changed === original.toString()) throw new Error(`Mutation not applied: ${c.name}`);
  try {
    writeFileSync(resolve(temp, c.file), changed);
    const result = run(c.key, "red");
    if (result.code === 0 || !result.output.includes("AssertionError") || !result.output.includes(c.name)) throw new Error(`Not assertion RED: ${c.name}; ${temp}`);
    console.log(`RED ${c.name}: named assertion failed, exit ${result.code}`);
  } finally { writeFileSync(resolve(temp, c.file), original); }
  if (sha(readFileSync(resolve(temp, c.file))) !== hash || sha(readFileSync(resolve(root, c.file))) !== hash) throw new Error("SHA-256 mismatch");
  if (run(c.key, "restored").code !== 0) throw new Error(`Restoration failed: ${temp}`);
  console.log(`GREEN restored: ${c.name}; workspace/disposable SHA-256 ${hash}`);
}
console.log(`Evidence: ${temp}`);
