import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// This deliberately locks the small policy construction boundary to a base-only copy.
// Any future transformation needs explicit review, even when it is hidden behind a helper.
const baseOnlyPolicy = (source: string) => {
  const initializers = [...source.matchAll(/\b(?:const|let)\s+policy(?:\s*:\s*Policy)?\s*=\s*([^;]+);/g)];
  return initializers.length === 1 && /^\{\s*\.\.\.basePolicy,\s*mode:\s*"SIMULATION"\s*\}$/.test(initializers[0][1]) &&
    !/requestedLeverage|intentToPreview|policy\s*(?:\.[\w]+|\[[^\]]+\])\s*=(?!=)|Object\.assign\s*\(\s*policy/.test(source);
};

test("policy source scan detects both raw requested leverage and the old tightening helper", () => {
  const good = 'const policy: Policy = { ...basePolicy, mode: "SIMULATION" };';
  expect(baseOnlyPolicy(good)).toBe(true);
  expect(baseOnlyPolicy(good + '\npolicy.maxGrossLeverage = intent.requestedLeverage;')).toBe(false);
  expect(baseOnlyPolicy('const policy = intentToPreview(intent, basePolicy).policy;')).toBe(false);
  expect(baseOnlyPolicy('const policy = { ...basePolicy, mode: "SIMULATION", maxGrossLeverage: intent.requestedLeverage };')).toBe(false);
});

test("saved-policy source scan excludes requestedLeverage and intent-derived policy fields", () => {
  const preview = readFileSync(join(import.meta.dir, "../src/chat/preview.ts"), "utf8");
  expect(baseOnlyPolicy(preview)).toBe(true);
  for (const dir of ["chat", "live"]) {
    for (const file of readdirSync(join(import.meta.dir, "../src", dir)).filter(f => f.endsWith(".ts"))) {
      const source = readFileSync(join(import.meta.dir, "../src", dir, file), "utf8");
      expect(source).not.toContain("intentToPreview");
    }
  }
  for (const handler of ["chat", "live"]) {
    const source = readFileSync(join(import.meta.dir, `../src/${handler}/handler.ts`), "utf8");
    expect(source).toMatch(/buildPreview\(\{ intent: effective, basePolicy: deps\.basePolicy, addresses/);
    expect(source).not.toMatch(/(?:deps\.basePolicy|preview\.policy)\s*(?:\.[\w]+|\[[^\]]+\])?\s*=(?!=)/);
  }
});
