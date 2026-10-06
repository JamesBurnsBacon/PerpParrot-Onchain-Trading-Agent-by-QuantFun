import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { loadFinalists } from "../src/chat/finalists";
import { makeSampleFinalists } from "../scripts/make-sample-finalists";

test("bundled finalists exactly match Score's ranked sample", async () => {
  const generated = makeSampleFinalists();
  expect(generated.length).toBeGreaterThanOrEqual(5);
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
