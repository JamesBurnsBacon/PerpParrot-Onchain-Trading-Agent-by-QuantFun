import { PARROT_PRESETS } from "../lib/parrot-presets";
import { expect, test } from "bun:test";
import { diffWallets, updateWalletBoard, type WalletBoardState, walletLabel, walletVibe } from "../lib/wallet-board";

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

test("remove then re-add before expiry replaces the ghost with one current identity", () => {
  const chat = PARROT_PRESETS[0].chat, address = chat.shortlist.addresses[0];
  const initial: WalletBoardState = { chat, before: [], ghosts: [], epoch: 1, labels: true };
  const fewer = { ...chat, shortlist: { ...chat.shortlist, addresses: chat.shortlist.addresses.slice(1) },
    changes: { added: [], removed: [{ address, reason: "lower priority for this style" }] } };
  const removed = updateWalletBoard(initial, fewer, 1000);
  expect(removed.ghosts).toEqual([{ address, expiresAt: 3500, evidence: chat.evidence, reason: "lower priority for this style" }]);
  const readded = updateWalletBoard(removed, chat, 1500);
  expect(readded.ghosts).toEqual([]);
  expect(diffWallets(readded.before, chat.shortlist.addresses)).toEqual({ added: [address], removed: [], kept: fewer.shortlist.addresses });
  const rowIds = [...readded.chat.shortlist.addresses, ...readded.ghosts.map(g => g.address)];
  expect(rowIds.filter(id => id === address)).toHaveLength(1);
  expect(readded.epoch).toBe(3);
  expect(readded.labels).toBe(true);
  // A second departure gets its own expiry, not the old ghost's timeout.
  expect(updateWalletBoard(readded, fewer, 2000).ghosts[0].expiresAt).toBe(4500);
  expect(initial.ghosts).toEqual([]);
  expect(removed.ghosts).toHaveLength(1);
});
