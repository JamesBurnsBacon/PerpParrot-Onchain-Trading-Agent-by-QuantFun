// Run from root: bun packages/backend/scripts/live-context-mutations.ts.
// Expect GREEN baseline/restoration, three RED assertions and matching SHA-256 hashes.
// Offline RED/GREEN proof in a disposable copy. The workspace source is never mutated.
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dir, "../../..");
const target = "packages/backend/src/live/context.ts";
const baseline = readFileSync(resolve(root, target));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const expected = sha(baseline);
const temp = mkdtempSync(resolve(tmpdir(), "parrot-context-mutations-"));
mkdirSync(resolve(temp, "packages/backend/test"), { recursive: true });
cpSync(resolve(root, "packages/backend/src"), resolve(temp, "packages/backend/src"), { recursive: true });
cpSync(resolve(root, "packages/shared"), resolve(temp, "packages/shared"), { recursive: true });
cpSync(resolve(root, "packages/backend/test/live-context.test.ts"), resolve(temp, "packages/backend/test/live-context.test.ts"));
symlinkSync(resolve(root, "packages/backend/node_modules"), resolve(temp, "packages/backend/node_modules"));
const cases = [
  { name: "overlap", pattern: "overlap counts", from: '[...new Set(shortlistAddresses.map(a => a.toLowerCase()))]', to: 'shortlistAddresses' },
  { name: "failure-isolation", pattern: "per-dep failure isolation", from: '    return undefined;\n  } finally', to: '    throw new Error("read failure");\n  } finally' },
  { name: "facts-cap", pattern: "1200-char cap", from: 'if (result.length + 1 + fact.length <= 1200)', to: 'if (true)' },
];
function run(name: string, pattern?: string) {
  const result = Bun.spawnSync([process.execPath, "test", "test/live-context.test.ts", ...(pattern ? ["--test-name-pattern", pattern] : [])], {
    cwd: resolve(temp, "packages/backend"), env: { ...process.env, TEST_DATABASE_URL: "" }, stdout: "pipe", stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  writeFileSync(resolve(temp, `${name}.log`), output);
  return { code: result.exitCode, output };
}
if (run("baseline").code !== 0) throw new Error(`Baseline failed; see ${temp}`);
console.log(`GREEN baseline; SHA-256 ${expected}`);
for (const c of cases) {
  const changed = baseline.toString().replace(c.from, c.to);
  if (changed === baseline.toString()) throw new Error(`Mutation missed: ${c.name}`);
  try {
    writeFileSync(resolve(temp, target), changed);
    const red = run(c.name, c.pattern);
    if (red.code === 0 || !/expect\(received\)|error: read failure/.test(red.output) || !/[1-9]\d* fail/.test(red.output)) {
      throw new Error(`Mutation did not fail its assertions: ${c.name}; see ${temp}`);
    }
    console.log(`RED ${c.name}: exit ${red.code}`);
  } finally {
    writeFileSync(resolve(temp, target), baseline);
  }
  if (sha(readFileSync(resolve(temp, target))) !== expected || sha(readFileSync(resolve(root, target))) !== expected) throw new Error("SHA-256 mismatch");
  if (run(`${c.name}-restored`, c.pattern).code !== 0) throw new Error(`Restoration failed: ${c.name}`);
  console.log(`GREEN ${c.name} restored; disposable and workspace SHA-256 match`);
}
if (run("restored-all").code !== 0) throw new Error("Restored suite failed");
console.log(`GREEN full restored suite. Logs: ${temp}`);
