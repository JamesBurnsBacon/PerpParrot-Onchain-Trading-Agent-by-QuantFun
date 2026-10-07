// Real stage interaction and receipt text, without browser/network claims: nothing is paged, so every order and fact is on screen at once.
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { hookHost, nodes } from "./receipt-hook-host";
mock.module("../../components/parrot/ParrotEffects", () => ({ useParrotEffects: () => null }));
const host = hookHost();
const { LiveCards } = await import("../../components/parrot/LiveCards");
const { ReceiptText } = await import("../../components/parrot/DecisionsDrawer");
const StageBits = await import("../../components/parrot/StageBits");
assert(!("Pager" in StageBits), "there is no pager component any more");
let card: any = { kind: "request", stage: "awaiting", plan: {
  equityUsd: 1000, grossUsd: 250, marginScale: 1, skipped: [], asOfMs: 1,
  orders: Array.from({ length: 25 }, (_, i) => ({ asset: `ASSET${i}`, isBuy: i % 2 === 0, notionalUsd: 10, size: "1", markPx: 10 })),
}, previewHash: "0xabc", requestId: null, sources: 25 };
let confirmed = 0;
const render = () => { const t = host.render(() => LiveCards({ card, onClose() {}, onConfirm() { confirmed++; } })); host.effects(); return t; };
let tree = render();
const items = nodes(tree).filter(n => n.type === "li");
assert.deepEqual(items.map(n => n.key), card.plan.orders.map((o: any) => o.asset), "all 25 orders are in the tree at once, in order");
const list = nodes(tree).find(n => n.type === "ul" && n.props?.["aria-label"] === "Hypothetical orders");
assert.equal(list.props["data-cols"], 3, "many orders use three columns instead of pages");
assert(!nodes(tree).some(n => /Next|Previous/.test(n.props?.["aria-label"] ?? "")), "no paging controls");
nodes(tree).find(n => n.props?.["aria-label"] === "Confirm (save pending request)").props.onClick();
assert.equal(confirmed, 1);
card = { ...card, stage: "saved", requestId: "request-1" }; tree = render();
assert(!nodes(tree).some(n => n.props?.["aria-label"] === "Confirm (save pending request)"), "only the awaiting card can confirm");
host.unmount();
const text = "Source positions and drawdown. ".repeat(40);
tree = host.render(() => ReceiptText({ text, label: "Turn facts" }));
assert.equal(nodes(tree).find(n => n.type === "p").props.children, text.replace(/\s+/g, " ").trim(), "all fact text is shown in full, no paging");
host.unmount();
console.log("stage interactions GREEN");
