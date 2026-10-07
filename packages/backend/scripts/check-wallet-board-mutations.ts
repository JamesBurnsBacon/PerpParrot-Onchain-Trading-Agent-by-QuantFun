// Run from root: bun packages/backend/scripts/check-wallet-board-mutations.ts.
// Expect each mutation RED and restored sources GREEN; only disposable copies are edited.
import { resolve } from "node:path";
import { cpSync, mkdtempSync, mkdirSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const backend = resolve(import.meta.dir, "..");
const root = resolve(backend, "../..");
const scratch = mkdtempSync(resolve(tmpdir(), "parrot-board-mutations-"));
for (const path of ["packages/backend/src", "packages/backend/test", "packages/backend/scripts", "packages/backend/fixtures", "packages/shared", "packages/dashboard/lib"]) {
  cpSync(resolve(root, path), resolve(scratch, path), { recursive: true, filter: source => !source.split(/[\\/]/).includes("node_modules") });
}
mkdirSync(resolve(scratch, "packages/dashboard/test"), { recursive: true });
cpSync(resolve(root, "packages/dashboard/test/parrot-materials-logic.test.ts"), resolve(scratch, "packages/dashboard/test/parrot-materials-logic.test.ts"));
symlinkSync(resolve(root, "packages/backend/node_modules"), resolve(scratch, "packages/backend/node_modules"));
const tests = ["test/wallet-board.test.ts", "test/wallet-effects.test.ts", "../dashboard/test/parrot-materials-logic.test.ts"];
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function run() {
  const child = Bun.spawn([process.execPath, "test", ...tests], { cwd: resolve(scratch, "packages/backend"), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: stdout + stderr };
}
const cases = [
  ["reason consistency", "packages/backend/src/chat/strategy.ts", 'if (flag) return `flagged: ${flag}`;', 'if (flag) return "unranked";'],
  ["style priority reason", "packages/backend/src/chat/strategy.ts", 'return "lower priority for this style";', 'return "outside the style score window";'],
  ["previous unknown id", "packages/backend/src/live/handler.ts", 'if (previous?.some(id => !data.finalists.some(f => f.address === id)))', 'if (false)'],
  ["previous oversize", "packages/backend/src/live/handler.ts", 'body.previous.length > 25', 'body.previous.length > 250'],
  ["previous unknown keys", "packages/backend/src/live/handler.ts", 'Object.keys(body).some(k => !["intent", "previous"].includes(k))', 'false'],
  ["facts per-side cap", "packages/backend/src/live/handler.ts", 'selection.changes?.[side].slice(0, 3)', 'selection.changes?.[side].slice(0, 25)'],
  ["facts length", "packages/backend/src/live/handler.ts", 'safety.length + 16 > 1200', 'safety.length + 16 > 12000'],
  ["board diff", "packages/dashboard/lib/wallet-board.ts", 'added: [...after].filter(id => !before.has(id))', 'added: [...after].filter(id => before.has(id))'],
  ["evidence guard", "packages/dashboard/lib/parrot.ts", '!isWalletEvidence(v.evidence) ||', 'false ||'],
  ["reason vocabulary guard", "packages/dashboard/lib/parrot.ts", 'isSelectionReason(e.reason)', 'typeof e.reason === "string"'],
  ["speech skip", "packages/dashboard/lib/wallet-board.ts", 's.now - s.lastInput >= 1200', 's.now - s.lastInput >= 0'],
  ["flash cap", "packages/dashboard/lib/wallet-board.ts", 'now - lastAccepted >= 1000', 'now - lastAccepted >= 0'],
  ["scheduler final sprinkle", "packages/dashboard/lib/wallet-board.ts", 'kind: reel.final ? "sprinkle" : "tick"', 'kind: "tick"'],
] as const;
// Verify anchors before any mutation; source drift must fail, not silently skip a control.
for (const [name, path, before] of cases) {
  if (readFileSync(resolve(scratch, path), "utf8").split(before).length !== 2) throw Error(`Mutation anchor not unique: ${name}`);
}
const baseline = await run();
if (baseline.code !== 0) throw Error(`Baseline failed:\n${baseline.output}`);
console.log(`GREEN baseline: ${baseline.output.match(/\d+ pass/)?.[0]}`);
for (const [name, path, before, after] of cases) {
  const file = resolve(scratch, path), original = readFileSync(file);
  const expected = sha(original);
  try {
    writeFileSync(file, original.toString().replace(before, after));
    const result = await run();
    writeFileSync(resolve(scratch, `${name.replaceAll(" ", "-")}.log`), result.output);
    if (result.code === 0 || !result.output.includes("(fail)") || !result.output.includes("expect(received)")) {
      throw Error(`Mutation survived or failed to load: ${name}\n${result.output}`);
    }
    console.log(`RED: ${name} (${result.output.match(/\d+ fail/)?.[0]}); SHA-256 ${expected}`);
  } finally {
    writeFileSync(file, original);
  }
  if (sha(readFileSync(file)) !== expected || sha(readFileSync(resolve(root, path))) !== expected) throw Error(`SHA-256 mismatch: ${path}`);
  const restored = await run();
  if (restored.code !== 0) throw Error(restored.output);
  console.log(`GREEN: ${name} restored; ${restored.output.match(/\d+ pass/)?.[0]}; disposable and workspace SHA-256 match`);
}
console.log(`Logs: ${scratch}`);
