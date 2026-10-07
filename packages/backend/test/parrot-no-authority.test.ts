import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The parrot has no trading authority: its code must not even reference the admin/signing secrets or the report endpoint.
const FORBIDDEN = /ADMIN_TOKEN|HL_API_WALLET_KEY|CRE_API_KEY|\/reports\b|FROZEN_CONFIGURATION_HASH/;
const roots = [
  join(import.meta.dir, "../src/chat"),
  join(import.meta.dir, "../src/live"),
  join(import.meta.dir, "../../dashboard/components/parrot"),
  join(import.meta.dir, "../../dashboard/app/parrot"),
];
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : []);

describe("the parrot cannot reach trading authority", () => {
  test("the scan itself fires on a forbidden reference (positive control)", () => {
    expect(FORBIDDEN.test("const t = process.env.ADMIN_TOKEN")).toBe(true);
    expect(FORBIDDEN.test("fetch('/reports/latest')")).toBe(true);
    expect(FORBIDDEN.test("const intent = Object.freeze(parsed)")).toBe(false);
  });

  test("no chat, live or parrot UI source references admin secrets or the report endpoint", () => {
    const scanned = roots.flatMap(files);
    expect(scanned.length).toBeGreaterThan(20); // the scan really covers the code, not an empty list
    const hits = scanned.filter(f => FORBIDDEN.test(readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });
});
