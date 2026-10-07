import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { mutateSource, mutationCases } from "../scripts/check-wallet-persona-mutations";

test("every wallet negative control has exactly one current source anchor", async () => {
  for (const [name, path, before, after] of mutationCases) {
    const source = await Bun.file(resolve(import.meta.dir, "../../..", path)).text();
    expect(() => mutateSource(source, name, before, after)).not.toThrow();
    expect(mutateSource(source, name, before, after)).not.toBe(source);
  }
});

test("missing and duplicate mutation anchors fail loudly", () => {
  for (const source of ["unrelated source", "anchor anchor"]) {
    expect(() => mutateSource(source, "regression control", "anchor", "mutant"))
      .toThrow(/Mutation anchor missing or not unique: regression control/);
  }
});
