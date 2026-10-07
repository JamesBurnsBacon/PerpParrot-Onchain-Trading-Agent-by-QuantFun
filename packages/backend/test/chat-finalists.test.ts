import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadFinalists, localFinalistsRows } from "../src/chat/finalists";
import { makeSampleFinalists } from "../scripts/make-sample-finalists";

test("bundled finalists match deterministic synthetic Score paths and exclusion controls", async () => {
  const generated = makeSampleFinalists();
  expect(generated).toHaveLength(40);
  expect(generated.every(f => f.dataSource === "sample" && /^0x[0-9a-f]{40}$/.test(f.address))).toBe(true);
  expect(generated.filter(f => f.score === null).map(f => f.flags[0])).toEqual(["overflow", "ruin", "low-coverage", "no-intervals"]);
  expect(await Bun.file(new URL("../fixtures/sample-finalists.json", import.meta.url)).json()).toEqual(generated);
  expect(await loadFinalists()).toEqual({ finalists: generated, dataSource: "sample" });
});

test("chat source contains no trading authority references", async () => {
  const dir = new URL("../src/chat/", import.meta.url);
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = await Bun.file(`${entry.parentPath}/${entry.name}`).text();
    for (const forbidden of ["ADMIN_TOKEN", "HL_API_WALLET_KEY", "CRE_API_KEY", "/reports", "frozen/live.json", "proposeFreeze"]) expect(source).not.toContain(forbidden);
  }
});

test("the local finalists file source is off by default and can never be taken beside a database or on Vercel", () => {
  const file = "/tmp/anything.json";
  expect(localFinalistsRows({}, false)).toBeUndefined();                                    // unset: off
  expect(localFinalistsRows({ PARROT_FINALISTS_FILE: "" }, false)).toBeUndefined();         // empty: off
  expect(localFinalistsRows({ PARROT_FINALISTS_FILE: file }, true)).toBeUndefined();        // beside a database: refused
  expect(localFinalistsRows({ PARROT_FINALISTS_FILE: file, VERCEL: "1" }, false)).toBeUndefined(); // on Vercel: refused
  expect(typeof localFinalistsRows({ PARROT_FINALISTS_FILE: file }, false)).toBe("function");      // positive control: local, no database, set
});

test("the local finalists file reader accepts tracked account rows and rejects anything else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "parrot-finalists-"));
  const good = join(dir, "good.json"), bad = join(dir, "bad.json"), notArray = join(dir, "notarray.json");
  const row = { address: `0x${"ab".repeat(20)}`, kind: "trader" as const, account_value: 12_345, closed: false, portfolio: [], trade_count: 3, maker_share: 0.5 };
  await Bun.write(good, JSON.stringify([row]));
  await Bun.write(bad, JSON.stringify([{ ...row, kind: "bot" }]));
  await Bun.write(notArray, JSON.stringify({ rows: [row] }));
  expect(await localFinalistsRows({ PARROT_FINALISTS_FILE: good }, false)!()).toEqual([row]);
  await expect(localFinalistsRows({ PARROT_FINALISTS_FILE: bad }, false)!()).rejects.toThrow("tracked account rows");
  await expect(localFinalistsRows({ PARROT_FINALISTS_FILE: notArray }, false)!()).rejects.toThrow("tracked account rows");
});
