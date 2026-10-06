import { expect, test } from "bun:test";
import { diffWallets, walletLabel, walletVibe } from "../lib/wallet-board";

test("tile labels convey nickname, vibe and only a current change", () => {
  expect(walletLabel("Captain Cracker", "calm", "new")).toBe("Captain Cracker, calm vibe, new");
  expect(walletLabel("Captain Cracker", "wild", "removed")).toBe("Captain Cracker, wild vibe, removed");
  expect(walletLabel("Captain Cracker", "steady")).toBe("Captain Cracker, steady vibe");
  expect(walletVibe()).toBe("steady");
});

test("persona display never changes id-based diff, including reentry and duplicates", () => {
  expect(diffWallets(["addr-01", "addr-02", "addr-02"], ["addr-03", "addr-02", "addr-03"]))
    .toEqual({ added: ["addr-03"], removed: ["addr-01"], kept: ["addr-02"] });
  expect(diffWallets(["addr-03", "addr-02"], ["addr-01", "addr-02"]))
    .toEqual({ added: ["addr-01"], removed: ["addr-03"], kept: ["addr-02"] });
  expect(diffWallets(["addr-01", "addr-02"], ["addr-02", "addr-01"]))
    .toEqual({ added: [], removed: [], kept: ["addr-02", "addr-01"] });
});
