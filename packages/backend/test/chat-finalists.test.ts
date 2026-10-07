import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { loadFinalists } from "../src/chat/finalists";
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
