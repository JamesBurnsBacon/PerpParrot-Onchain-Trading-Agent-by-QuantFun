// Offline negative controls. Run alone; each source is restored in finally.
// Pure tests only: backend CI deliberately has no React installation.
import { resolve } from "node:path";
const root = resolve(import.meta.dir, "../../..");
const tests = ["packages/backend/test/wallet-persona.test.ts", "packages/backend/test/wallet-board.test.ts", "packages/dashboard/test/wallet-board-logic.test.ts"];
async function run() {
  const child = Bun.spawn([process.execPath, "test", ...tests], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + err };
}
const persona = "packages/shared/wallet-persona.ts", board = "packages/dashboard/lib/wallet-board.ts", facts = "packages/backend/src/live/handler.ts";
const cases = [
  ["calm drawdown boundary", persona, "dd < .15", "dd <= .15"],
  ["calm volatility boundary", persona, "vol < .45", "vol <= .45"],
  ["wild drawdown boundary", persona, "dd >= .3", "dd > .3"],
  ["wild volatility boundary", persona, "vol >= .8", "vol > .8"],
  ["missing evidence neutrality", persona, 'vol < 0) return "steady"', 'vol < 0) return "calm"'],
  ["nickname determinism", persona, "let hash = 2166136261;", "let hash = Math.floor(Math.random() * 4294967296);"],
  ["nickname uniqueness", persona, "sampleNames.get(id) ?? cachedNames.get(id)", "BIRD_NAMES[0]"],
  ["nickname vocabulary safety", persona, '"Captain Cracker"', '"Captain Cash"'],
  ["board identity diff", board, 'added: [...after].filter(id => !before.has(id))', 'added: [...after].filter(id => before.has(id))'],
  ["spoken nicknames", facts, '${walletNickname(item.address)} (${item.address}):', '${item.address}:'],
  ["facts length budget", facts, "safety.length + 16 > 1200", "safety.length + 16 > 12000"],
  ["accessible change label", board, '${change ? `, ${change}` : ""}', '${""}'],
] as const;
if ((await run()).code !== 0) throw Error("Baseline must pass before negative controls");
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
