// Real stage pagination and receipt text interaction, without browser/network claims.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { hookHost, nodes } from "./receipt-hook-host";
mock.module("../../components/parrot/ParrotEffects", () => ({ useParrotEffects: () => null }));
const host = hookHost();
const { LiveCards } = await import("../../components/parrot/LiveCards");
const { Pager } = await import("../../components/parrot/StageBits");
const { ReceiptText } = await import("../../components/parrot/DecisionsDrawer");
let card: any = { kind: "request", stage: "awaiting", plan: {
  equityUsd: 1000, grossUsd: 250, marginScale: 1, skipped: [], asOfMs: 1,
  orders: Array.from({ length: 25 }, (_, i) => ({ asset: `ASSET${i}`, isBuy: i % 2 === 0, notionalUsd: 10, size: "1", markPx: 10 })),
}, previewHash: "0xabc", requestId: null, sources: 25 };
let confirmed = 0;
const render = () => { const t = host.render(() => LiveCards({ card, onClose() {}, onConfirm() { confirmed++; } })); host.effects(); return t; };
let tree = render(); const seen: string[] = [];
for (let page = 0; page < 7; page++) {
  const items = nodes(tree).filter(n => n.type === "li");
  assert(items.length <= 4);
  seen.push(...items.map(n => n.key));
  const pager = nodes(tree).find(n => n.type === Pager);
  assert.equal(pager.props.page, page); assert.equal(pager.props.count, 7);
  if (page < 6) { pager.props.onPage(page + 1); tree = render(); }
}
assert.deepEqual(seen, card.plan.orders.map((o: any) => o.asset));
nodes(tree).find(n => n.props?.["aria-label"] === "Confirm (save pending request)").props.onClick();
assert.equal(confirmed, 1);
card = { ...card, stage: "saved", requestId: "request-1" }; tree = render();
assert(!nodes(tree).some(n => n.props?.["aria-label"] === "Confirm (save pending request)"));
card = { ...card, stage: "awaiting", requestId: null }; render(); tree = render();
assert.equal(nodes(tree).find(n => n.type === Pager).props.page, 0, "new sketch starts on its first page");
host.unmount();
const text = "Source positions and drawdown. ".repeat(40);
const renderText = () => host.render(() => ReceiptText({ text, label: "Turn facts" }));
tree = renderText(); let joined = "";
for (let page = 0; page < Math.ceil(text.trim().length / 180); page++) {
  joined += nodes(tree).find(n => n.type === "p").props.children;
  nodes(tree).find(n => n.type === Pager).props.onPage(page + 1); tree = renderText();
}
assert.equal(joined, text.trim(), "all fact text is reachable without scrolling");
host.unmount();
console.log("stage interactions GREEN");
