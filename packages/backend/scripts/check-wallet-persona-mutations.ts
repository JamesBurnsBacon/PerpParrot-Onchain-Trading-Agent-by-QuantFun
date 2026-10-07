// Offline negative controls run in a disposable copy, safe alongside a dev server.
// Pure tests only: backend CI deliberately has no React installation.
import { resolve, dirname } from "node:path";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const root = resolve(import.meta.dir, "../../..");
const tests = ["packages/backend/test/wallet-persona.test.ts", "packages/backend/test/wallet-board.test.ts", "packages/dashboard/test/wallet-board-logic.test.ts"];
async function run(root: string) {
  const child = Bun.spawn([process.execPath, "test", ...tests], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: out + err };
}
const persona = "packages/shared/wallet-persona.ts", board = "packages/dashboard/lib/wallet-board.ts", facts = "packages/backend/src/live/handler.ts";
export const mutationCases = [
  ["calm drawdown boundary", persona, "dd < VIBE_THRESHOLDS.calmDrawdown", "dd <= VIBE_THRESHOLDS.calmDrawdown"],
  ["calm volatility boundary", persona, "vol < VIBE_THRESHOLDS.calmVol", "vol <= VIBE_THRESHOLDS.calmVol"],
  ["wild drawdown boundary", persona, "dd >= VIBE_THRESHOLDS.wildDrawdown", "dd > VIBE_THRESHOLDS.wildDrawdown"],
  ["wild volatility boundary", persona, "vol >= VIBE_THRESHOLDS.wildVol", "vol > VIBE_THRESHOLDS.wildVol"],
  ["missing evidence neutrality", persona, 'vol < 0) return "steady"', 'vol < 0) return "calm"'],
  ["nickname determinism", persona, "let hash = 2166136261;", "let hash = Math.floor(Math.random() * 4294967296);"],
  ["nickname uniqueness", persona, "sampleNames.get(id) ?? cachedNames.get(id)", "BIRD_NAMES[0]"],
  ["nickname vocabulary safety", persona, '"Captain Cracker"', '"Captain Cash"'],
  ["board identity diff", board, 'added: [...after].filter(id => !before.has(id))', 'added: [...after].filter(id => before.has(id))'],
  ["spoken nicknames", facts, '${walletNickname(item.address)} (${item.address}):', '${item.address}:'],
  ["facts length budget", facts, "safety.length + 16 > 1200", "safety.length + 16 > 12000"],
  ["accessible change label", board, '${change ? `, ${change}` : ""}', '${""}'],
] as const;
export function mutateSource(original: string, name: string, before: string, after: string): string {
  const matches = original.split(before).length - 1;
  if (matches !== 1) throw Error(`Mutation anchor missing or not unique: ${name} (found ${matches}): ${before}`);
  return original.replace(before, after);
}
const sha256 = (source: string) => createHash("sha256").update(source).digest("hex");
async function main() {
  const scratch = mkdtempSync(resolve(tmpdir(), "wallet-mutations-"));
  try {
    for (const path of ["packages/shared", "packages/backend/src", "packages/backend/test", "packages/backend/scripts", "packages/backend/fixtures", "packages/dashboard/lib", "packages/dashboard/test"]) {
      cpSync(resolve(root, path), resolve(scratch, path), { recursive: true, filter: source => !source.split(/[\\/]/).includes("node_modules") });
    }
    for (const path of ["node_modules", "packages/backend/node_modules", "packages/dashboard/node_modules", "packages/shared/node_modules"]) {
      if (!existsSync(resolve(root, path))) continue;
      mkdirSync(dirname(resolve(scratch, path)), { recursive: true });
      symlinkSync(resolve(root, path), resolve(scratch, path), "dir");
    }
    // Validate ALL anchors before running any controls. Source drift must never look green.
    for (const [name, path, before, after] of mutationCases)
      mutateSource(await Bun.file(resolve(scratch, path)).text(), name, before, after);
    if ((await run(scratch)).code !== 0) throw Error("Baseline must pass before negative controls");
    for (const [name, path, before, after] of mutationCases) {
      const file = resolve(scratch, path), original = await Bun.file(file).text();
      try {
        await Bun.write(file, mutateSource(original, name, before, after));
        const result = await run(scratch);
        if (result.code === 0 || !result.output.includes("(fail)")) throw Error(`Mutation survived or failed to load: ${name}\n${result.output}`);
        console.log(`RED: ${name} (${result.output.match(/\d+ fail/)?.[0]})`);
      } finally {
        await Bun.write(file, original);
        if (sha256(await Bun.file(file).text()) !== sha256(original)) throw Error(`SHA-256 restore failed: ${path}`);
      }
    }
    const restored = await run(scratch);
    if (restored.code !== 0) throw Error(restored.output);
    console.log(`GREEN: restored sources (SHA-256 verified); ${restored.output.match(/\d+ pass/)?.[0]}`);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
if (import.meta.main) await main();
