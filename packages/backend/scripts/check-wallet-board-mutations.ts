// Offline negative controls. Run alone: temporarily mutates one source file, restores it in finally.
import { resolve } from "node:path";
const backend = resolve(import.meta.dir, "..");
const root = resolve(backend, "../..");
const tests = ["test/wallet-board.test.ts", "test/wallet-effects.test.ts"];
async function run() {
  const child = Bun.spawn([process.execPath, "test", ...tests], { cwd: backend, stdout: "pipe", stderr: "pipe" });
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
  ["flash cap", "packages/dashboard/lib/wallet-board.ts", 'at - accepted.at(-1)! >= 1000', 'at - accepted.at(-1)! >= 0'],
] as const;
const baseline = await run();
if (baseline.code !== 0) throw Error(`Baseline failed:\n${baseline.output}`);
for (const [name, path, before, after] of cases) {
  const file = resolve(root, path), original = await Bun.file(file).text();
  if (original.split(before).length !== 2) throw Error(`Mutation anchor not unique: ${name}`);
  try {
    await Bun.write(file, original.replace(before, after));
    const result = await run();
    if (result.code === 0 || !result.output.includes("(fail)")) throw Error(`Mutation survived or failed to load: ${name}\n${result.output}`);
    console.log(`RED: ${name} (${result.output.match(/\d+ fail/)?.[0]})`);
  } finally { await Bun.write(file, original); }
}
const restored = await run();
if (restored.code !== 0) throw Error(restored.output);
console.log(`GREEN: restored sources; ${restored.output.match(/\d+ pass/)?.[0]}`);
