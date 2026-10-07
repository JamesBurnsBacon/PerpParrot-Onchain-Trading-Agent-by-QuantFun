// Offline RED/GREEN assertions in a disposable tree. Never mutate workspace sources.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dir, "../../.."), temp = mkdtempSync(resolve(tmpdir(), "receipt-mutations-"));
for (const path of ["packages/backend/src", "packages/backend/test/decisions.test.ts", "packages/shared", "packages/dashboard/lib", "packages/dashboard/components", "packages/dashboard/app/parrot/receipts", "packages/dashboard/test/receipts.test.tsx"]) {
  mkdirSync(resolve(temp, path, ".."), { recursive: true }); cpSync(resolve(root, path), resolve(temp, path), { recursive: true });
}
for (const pkg of ["backend", "dashboard"]) symlinkSync(resolve(root, `packages/${pkg}/node_modules`), resolve(temp, `packages/${pkg}/node_modules`));
const cases = [
  { name: "claim-only", pkg: "backend", file: "packages/backend/src/live/decisions.ts", pattern: "claim-only body", from: 'if (!keys(body, "claim"))', to: 'if (!body || typeof body !== "object")' },
  { name: "relation-enum", pkg: "backend", file: "packages/shared/receipt.ts", pattern: "strict relation enum", from: '!relation(c.choice) || ', to: '' },
  { name: "4xx-release", pkg: "backend", file: "packages/backend/src/live/decisions.ts", pattern: "cost handling on 4xx", from: 'error instanceof Rejected ? 0 : cost', to: 'cost' },
  { name: "client-unknown-key", pkg: "dashboard", file: "packages/shared/receipt.ts", pattern: "guard rejects unknown top key", from: '!keys(v, "supported,relation,relationProbabilities,usage,model,latencyMs,costUsd,request,response")', to: '!object(v)' },
];
const originals = new Map(cases.map(c => [c.file, readFileSync(resolve(root, c.file))]));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function run(pkg: string, name: string, pattern?: string) {
  const test = pkg === "backend" ? "test/decisions.test.ts" : "test/receipts.test.tsx";
  const result = Bun.spawnSync([process.execPath, "test", test, ...(pattern ? ["--test-name-pattern", pattern] : [])], {
    cwd: resolve(temp, `packages/${pkg}`), env: { ...process.env, TEST_DATABASE_URL: "" }, stdout: "pipe", stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString(); writeFileSync(resolve(temp, `${name}.log`), output);
  return { code: result.exitCode, output };
}
for (const pkg of ["backend", "dashboard"]) { if (run(pkg, `${pkg}-baseline`).code !== 0) throw new Error(`Baseline failed: ${temp}`); console.log(`GREEN ${pkg} baseline`); }
for (const c of cases) {
  const original = originals.get(c.file)!;
  const changed = original.toString().replace(c.from, c.to); if (changed === original.toString()) throw new Error(`Missed mutation ${c.name}`);
  try {
    writeFileSync(resolve(temp, c.file), changed);
    const red = run(c.pkg, c.name, c.pattern);
    if (red.code === 0 || !/expect\(received\)/.test(red.output) || !/[1-9]\d* fail/.test(red.output)) throw new Error(`Not assertion RED: ${c.name}; ${temp}`);
    console.log(`RED ${c.name}: assertion failed (exit ${red.code})`);
  } finally { writeFileSync(resolve(temp, c.file), original); }
  const hash = sha(original);
  if (sha(readFileSync(resolve(temp, c.file))) !== hash || sha(readFileSync(resolve(root, c.file))) !== hash) throw new Error("SHA-256 mismatch");
  if (run(c.pkg, `${c.name}-restored`, c.pattern).code !== 0) throw new Error(`Not GREEN restored: ${c.name}`);
  console.log(`GREEN ${c.name}: restored; workspace/disposable SHA-256 ${hash}`);
}
for (const pkg of ["backend", "dashboard"]) if (run(pkg, `${pkg}-restored-all`).code !== 0) throw new Error(`Restored suite failed: ${pkg}`);
console.log(`GREEN full restored suites. Logs: ${temp}`);
