import { expect, test } from "bun:test";
import { createSentenceSplitter } from "../lib/parrot-sentences";
const cases: [string, string[]][] = [
  ["Wallet A has lower losses. Wallet B has higher Sharpe! Is that on the receipt?", ["Wallet A has lower losses.", "Wallet B has higher Sharpe!", "Is that on the receipt?"]],
  ["The cap is 1.5x and fees 0.9%. Nothing is promised.", ["The cap is 1.5x and fees 0.9%.", "Nothing is promised."]],
  ["Wallet 0x1a2b…c3d4 is selected. Version 3.2.-style limits apply.", ["Wallet 0x1a2b…c3d4 is selected.", "Version 3.2.-style limits apply."]],
  ['He says “Wallet A is selected.” (Wallet B is excluded!) More facts follow.', ['He says “Wallet A is selected.”', '(Wallet B is excluded!)', 'More facts follow.']],
  ["Squawk! These wallets are invented. Hi!", ["Squawk! These wallets are invented."]],
  ["これは架空のウォレットです。市場の真実ではありません！本当にそうなのでしょうか？", ["これは架空のウォレットです。", "市場の真実ではありません！", "本当にそうなのでしょうか？"]],
  ["Wallet A is selected… Wallet B is excluded... More paperwork here！", ["Wallet A is selected…", "Wallet B is excluded...", "More paperwork here！"]],
  ["🐦 Wallet A is selected! 🦜 Wallet B is excluded?", ["🐦 Wallet A is selected!", "🦜 Wallet B is excluded?"]],
  ["Wallet A is selected\nWallet B is excluded\r\nNext sentence without punctuation", ["Wallet A is selected", "Wallet B is excluded", "Next sentence without punctuation"]],
  ["Squawk!\nWallet A is selected.", ["Squawk! Wallet A is selected."]],
  ["Wallet 0x1a2b...c3d4 is selected. More facts are coming.", ["Wallet 0x1a2b...c3d4 is selected.", "More facts are coming."]],
  ["Squawk! Chirp! Wallet A is selected.", ["Squawk! Chirp! Wallet A is selected."]],
];
for (const [text, expected] of cases) test(`split table: ${text}`, () => {
  // Every split point, including mid-word/number/ellipsis/quote/UTF-16 pair.
  for (let i = 0; i <= text.length; i++) {
    const splitter = createSentenceSplitter();
    expect([...splitter.push(text.slice(0, i)), ...splitter.push(text.slice(i)), ...splitter.flush()]).toEqual(expected);
  }
});
test("terminal lookahead and short fragment merge, flush/reset", () => {
  const s = createSentenceSplitter();
  expect(s.push("Squawk!")).toEqual([]);
  expect(s.push(" Wallet A has 1.")).toEqual([]);
  expect(s.push("5x leverage. Next sentence begins")).toEqual(["Squawk! Wallet A has 1.5x leverage."]);
  s.reset(); expect(s.flush()).toEqual([]);
  expect(s.push("short")).toEqual([]); expect(s.flush()).toEqual([]);
});
test("cap at last space or comma and preserve surrogate pairs", () => {
  const s = createSentenceSplitter(), text = "x".repeat(160) + "," + "y".repeat(70) + " "+ "🦜".repeat(130);
  const out = [...s.push(text), ...s.flush()];
  expect(out[0]).toBe("x".repeat(160) + ",");
  expect(out.every(x => x.length <= 200 && !/[\uD800-\uDBFF]$|^[\uDC00-\uDFFF]/.test(x))).toBe(true);
  expect(out.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
});
test("fuzz streaming loses no non-whitespace characters (terminal tiny fragment is intentionally omitted)", () => {
  let seed = 123456;
  const rand = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const atoms = ["Wallet A is selected. ", "Fees are only 0.9%. ", "The cap is 1.5x! ", "これは架空のウォレットです。", "Squawk! ", "🦜 ", "0x1a2b…c3d4 ", "v3.2.-style "];
  for (let n = 0; n < 200; n++) {
    const text = Array.from({ length: 20 }, () => atoms[rand() % atoms.length]).join("") + "Final sentence on the receipt.";
    const s = createSentenceSplitter(), out: string[] = [];
    for (let i = 0; i < text.length;) { const size = rand() % 21 + 1; out.push(...s.push(text.slice(i, i + size))); i += size; }
    out.push(...s.flush());
    expect(out.every(x => x.length >= 12 && x.length <= 200)).toBe(true);
    expect(out.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  }
});

test("silence flush never judges a decimal cut in half, but real sentence ends still flush", () => {
  const s = createSentenceSplitter();
  expect(s.push("The Sharpe is 1.")).toEqual([]);
  expect(s.flushIfSettled()).toEqual([]);
  expect(s.push("25 on the receipt.")).toEqual([]);
  expect(s.flushIfSettled()).toEqual(["The Sharpe is 1.25 on the receipt."]);
});
